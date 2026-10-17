import { isHexHash, isArchiveDigest } from "./identity.mjs";
import { githubEnvironment } from "./config.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  chmodSync,
  mkdirSync,
  closeSync,
  fstatSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function createArtifactTools(config) {
  const EVIDENCE_REPOSITORY = config.repository;
  const EVIDENCE_WORKFLOW = config.workflow;
  const EVIDENCE_PREFIX = "review-evidence-";
  const MANIFEST_FILE = "evidence-manifest.json";
  const MAX_BYTES = 200 * 1024 * 1024;
  const MAX_FILE_BYTES = 100 * 1024 * 1024;
  // Bound slow downloads and retry only timeouts.
  const ARCHIVE_TIMEOUT_FLOOR_MS = 30_000;
  const ARCHIVE_TIMEOUT_CEILING_MS = 5 * 60_000;
  const ARCHIVE_DOWNLOAD_ATTEMPTS = 3;
  const ARCHIVE_TIMEOUT_MIN_BYTES_PER_SECOND = 128 * 1024;
  // Metadata GETs share one budget for timeouts and transient server errors.
  const METADATA_ATTEMPTS = 3;
  const METADATA_DEADLINE_MS = 90_000;
  const ARCHIVE_CACHE_LIMIT = 4;
  const authenticatedStages = new WeakMap();
  function assertAuthenticatedEvidenceStage(stage) {
    if (!stage || authenticatedStages.get(stage) !== sha256(JSON.stringify(stage)))
      throw new Error("evidence stage lacks unchanged process-local artifact authentication");
  }
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

  function safeEvidencePath(path) {
    return (
      typeof path === "string" &&
      path.length <= 200 &&
      path.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part)) &&
      /\.(?:png|jpe?g|webp|gif|avif|mp4|mov|webm|json|xml|txt|log|md|csv)$/i.test(path) &&
      path !== MANIFEST_FILE
    );
  }

  function validateManifest(manifest) {
    if (
      manifest?.version !== 1 ||
      manifest.repository !== EVIDENCE_REPOSITORY ||
      !isHexHash(manifest.sourceSha, 40) ||
      !Number.isSafeInteger(manifest.issue) ||
      manifest.issue < 1 ||
      !isHexHash(manifest.bundleId, 64) ||
      !Number.isFinite(Date.parse(manifest.createdAt)) ||
      !Array.isArray(manifest.files) ||
      !manifest.files.length ||
      manifest.files.length > 1000
    )
      throw new Error("invalid evidence manifest identity");
    const paths = new Set();
    let total = 0;
    for (const file of manifest.files) {
      if (
        !safeEvidencePath(file.path) ||
        paths.has(file.path) ||
        !isHexHash(file.sha256, 64) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        file.bytes > MAX_FILE_BYTES
      )
        throw new Error("invalid evidence manifest file");
      paths.add(file.path);
      total += file.bytes;
    }
    if (total > MAX_BYTES) throw new Error("evidence exceeds 200 MiB");
    const { bundleId, ...content } = manifest;
    if (sha256(JSON.stringify(content)) !== bundleId)
      throw new Error("evidence manifest bundle digest mismatch");
    return manifest;
  }

  function snapshotEvidence(
    directory,
    { sourceSha, issue, createdAt = new Date(Date.now()).toISOString() },
  ) {
    if (lstatSync(directory).isSymbolicLink())
      throw new Error("evidence directory cannot be a symlink");
    const root = realpathSync(directory);
    const files = [];
    const bytes = new Map();
    function walk(current, prefix = "") {
      for (const name of readdirSync(current).sort()) {
        const path = prefix ? `${prefix}/${name}` : name;
        const full = join(current, name);
        const stat = lstatSync(full);
        if (stat.isSymbolicLink()) throw new Error("evidence cannot contain symlinks");
        if (stat.isDirectory()) {
          if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))
            throw new Error("unsafe evidence directory");
          walk(full, path);
        } else {
          if (
            !stat.isFile() ||
            !safeEvidencePath(path) ||
            stat.size < 1 ||
            stat.size > MAX_FILE_BYTES
          )
            throw new Error(`unsupported evidence file: ${path}`);
          const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
          let data;
          try {
            const opened = fstatSync(fd);
            if (opened.ino !== stat.ino || opened.dev !== stat.dev || realpathSync(full) !== full)
              throw new Error("evidence path changed during snapshot");
            data = readFileSync(fd);
            if (realpathSync(full) !== full)
              throw new Error("evidence path changed during snapshot");
          } finally {
            closeSync(fd);
          }
          if (data.length !== stat.size) throw new Error("evidence changed during snapshot");
          bytes.set(path, data);
          files.push({ path, bytes: data.length, sha256: sha256(data) });
          if (
            files.length > 1000 ||
            [...bytes.values()].reduce((sum, item) => sum + item.length, 0) > MAX_BYTES
          )
            throw new Error("evidence snapshot exceeds limits");
        }
      }
    }
    walk(root);
    const content = {
      version: 1,
      repository: EVIDENCE_REPOSITORY,
      sourceSha,
      issue: Number(issue),
      createdAt,
      files,
    };
    const manifest = { ...content, bundleId: sha256(JSON.stringify(content)) };
    validateManifest(manifest);
    return { manifest, bytes };
  }

  const githubText = (args, { timeout = 30000 } = {}) =>
    execFileSync("gh", args, {
      encoding: "utf8",
      timeout,
      maxBuffer: 20 * 1024 * 1024,
      env: githubEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });

  const isTimeoutFailure = (error) =>
    error?.code === "ETIMEDOUT" ||
    error?.signal === "SIGTERM" ||
    /ETIMEDOUT|timed out/i.test(String(error?.message ?? ""));

  function withTimeoutRetry(action, { attempts, label }) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return action(attempt);
      } catch (error) {
        if (!isTimeoutFailure(error)) throw error;
        lastError = error;
      }
    }
    throw new Error(
      `${label} timed out after ${attempts} attempts on this runner: ${lastError?.message ?? "no response"}`,
    );
  }

  function metadataGet(args) {
    if (!Array.isArray(args) || args[0] !== "api") return false;
    let endpoints = 0;
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (arg === "-X" || arg === "--method") {
        if (args[++index] !== "GET") return false;
      } else if (["--method=GET", "-XGET", "--paginate", "--slurp"].includes(arg)) {
        continue;
      } else if (typeof arg === "string" && /^\/?repos\/[^\s#]+$/.test(arg)) {
        endpoints++;
      } else return false;
    }
    return endpoints === 1;
  }

  function githubJson(
    args,
    {
      exec = githubText,
      attempts = METADATA_ATTEMPTS,
      now = () => performance.now(),
      sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    } = {},
  ) {
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > METADATA_ATTEMPTS)
      throw new Error("metadata attempts must be an integer from 1 to 3");
    const safe = metadataGet(args);
    const limit = safe ? attempts : 1;
    const deadline = now() + METADATA_DEADLINE_MS;
    let lastError;
    let count = 0;
    while (count < limit) {
      const remaining = Math.floor(deadline - now());
      if (remaining <= 0) break;
      let raw;
      try {
        count++;
        raw = exec(args, { timeout: Math.min(30000, remaining) });
      } catch (error) {
        const transient = /\(HTTP (?:502|503|504)\)(?:\s|$)/.test(
          `${error?.stderr ?? ""}\n${error?.message ?? ""}`,
        );
        if (!safe || (!isTimeoutFailure(error) && !transient)) throw error;
        lastError = error;
        const backoff = 250 * 2 ** (count - 1);
        if (count === limit || now() + backoff >= deadline) break;
        sleep(backoff);
        continue;
      }
      // A response parse/validation failure is never a transport retry.
      return JSON.parse(raw);
    }
    throw new Error(
      `GitHub evidence metadata read failed after ${count} attempts within 90 seconds: ${lastError?.message ?? "deadline exceeded"}`,
      { cause: lastError },
    );
  }

  function verifyPublisherArtifactProvenance(
    artifact,
    run,
    { runId, artifactId, digest, now = Date.now() },
  ) {
    if (
      artifact.id !== artifactId ||
      artifact.workflow_run?.id !== runId ||
      artifact.expired !== false ||
      !Number.isFinite(Date.parse(artifact.expires_at)) ||
      Date.parse(artifact.expires_at) <= now ||
      !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes < 1 ||
      artifact.size_in_bytes > MAX_BYTES + 5 * 1024 * 1024 ||
      artifact.digest !== `sha256:${digest}` ||
      !new RegExp(`^${EVIDENCE_PREFIX}[a-f0-9]{64}$`).test(artifact.name)
    )
      throw new Error("artifact is missing, expired, oversized or has a different digest/identity");
    if (
      run.id !== runId ||
      run.repository?.full_name !== EVIDENCE_REPOSITORY ||
      run.head_repository?.full_name !== EVIDENCE_REPOSITORY ||
      run.event !== "workflow_dispatch" ||
      run.head_branch !== config.branch ||
      run.path !== EVIDENCE_WORKFLOW ||
      run.status !== "completed"
    )
      throw new Error(
        `artifact was not published by the completed ${config.branch}-only evidence workflow`,
      );
  }

  function verifyArtifactProvenance(artifact, run, proof) {
    verifyPublisherArtifactProvenance(artifact, run, proof);
    if (run.conclusion !== "success")
      throw new Error(
        `artifact was not published by the successful ${config.branch}-only evidence workflow`,
      );
  }

  // Inspect central-directory types before reading payloads: unzip -p would turn a
  // symlink into ordinary bytes and lose the evidence file's declared nature.
  function assertRegularZipEntries(archive) {
    if (!Buffer.isBuffer(archive)) throw new Error("evidence archive must contain bytes");
    let end = archive.length - 22;
    const floor = Math.max(0, end - 65535);
    for (; end >= floor; end--) {
      if (
        archive.readUInt32LE(end) === 0x06054b50 &&
        end + 22 + archive.readUInt16LE(end + 20) === archive.length
      )
        break;
    }
    if (
      end < floor ||
      archive.readUInt16LE(end + 4) !== 0 ||
      archive.readUInt16LE(end + 6) !== 0 ||
      archive.readUInt16LE(end + 8) !== archive.readUInt16LE(end + 10)
    )
      throw new Error("unsupported evidence ZIP directory");
    const count = archive.readUInt16LE(end + 10);
    const size = archive.readUInt32LE(end + 12);
    let offset = archive.readUInt32LE(end + 16);
    if (count > 2001 || count === 0 || offset + size !== end)
      throw new Error("unsupported evidence ZIP directory");
    let total = 0;
    const paths = new Set();
    for (let i = 0; i < count; i++) {
      if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50)
        throw new Error("invalid evidence ZIP entry");
      const nameLength = archive.readUInt16LE(offset + 28);
      const next =
        offset +
        46 +
        nameLength +
        archive.readUInt16LE(offset + 30) +
        archive.readUInt16LE(offset + 32);
      if (next > end) throw new Error("invalid evidence ZIP entry");
      const path = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      if (paths.has(path)) throw new Error("duplicate evidence ZIP entry");
      paths.add(path);
      const directory = path.endsWith("/");
      const mode = archive.readUInt32LE(offset + 38) >>> 16;
      const type = mode & 0o170000;
      if (type && type !== (directory ? 0o040000 : 0o100000))
        throw new Error("evidence ZIP requires regular files, not symlinks or special types");
      if (
        directory
          ? !path
              .slice(0, -1)
              .split("/")
              .every((p) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p))
          : path !== MANIFEST_FILE && !safeEvidencePath(path)
      )
        throw new Error("unsafe evidence ZIP path");
      const bytes = archive.readUInt32LE(offset + 24);
      if (
        archive.readUInt16LE(offset + 8) & 1 ||
        ![0, 8].includes(archive.readUInt16LE(offset + 10)) ||
        bytes > (path === MANIFEST_FILE ? 1024 * 1024 : MAX_FILE_BYTES) ||
        (directory && bytes)
      )
        throw new Error("unsupported evidence ZIP payload");
      total += bytes;
      if (total > MAX_BYTES + 1024 * 1024) throw new Error("evidence ZIP exceeds limits");
      offset = next;
    }
    if (offset !== end) throw new Error("invalid evidence ZIP directory size");
  }

  function removeStagedEvidence(root) {
    if (!root || !existsSync(root)) return;
    function writable(directory) {
      chmodSync(directory, 0o700);
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (lstatSync(path).isDirectory()) writable(path);
      }
    }
    writable(root);
    rmSync(root, { recursive: true, force: true });
  }

  function stageEvidence({ manifest, bytes }, proof, directory) {
    const root = mkdtempSync(join(realpathSync(directory), "evidence-"));
    const directories = new Set([root]);
    try {
      const files = manifest.files.map((file) => {
        const localPath = join(root, file.path);
        mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
        for (let path = dirname(localPath); path !== root; path = dirname(path))
          directories.add(path);
        writeFileSync(localPath, bytes.get(file.path), { flag: "wx", mode: 0o400 });
        if (sha256(readFileSync(localPath)) !== file.sha256)
          throw new Error("staged evidence changed");
        return { ...file, localPath };
      });
      for (const path of directories) chmodSync(path, 0o500);
      return {
        root,
        repository: manifest.repository,
        sourceSha: manifest.sourceSha,
        issue: manifest.issue,
        bundleId: manifest.bundleId,
        runId: proof.runId,
        artifactId: proof.artifactId,
        archiveSha256: proof.digest,
        files,
      };
    } catch (error) {
      removeStagedEvidence(root);
      throw error;
    }
  }

  function readEvidenceArchive(archive, { sourceSha, bundleId } = {}) {
    if (archive.length > MAX_BYTES + 5 * 1024 * 1024)
      throw new Error("evidence archive exceeds limits");
    assertRegularZipEntries(archive);
    const scratch = mkdtempSync(join(tmpdir(), "review-evidence-verify-"));
    try {
      const zipPath = join(scratch, "evidence.zip");
      writeFileSync(zipPath, archive, { mode: 0o600 });
      const unzip = (args, options = {}) =>
        execFileSync("unzip", args, { timeout: 10000, maxBuffer: MAX_FILE_BYTES + 1, ...options });
      const entries = unzip(["-Z1", zipPath], { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter((path) => !path.endsWith("/"));
      if (
        entries.length > 1001 ||
        new Set(entries).size !== entries.length ||
        entries.filter((path) => path === MANIFEST_FILE).length !== 1 ||
        entries.some((path) => path !== MANIFEST_FILE && !safeEvidencePath(path))
      )
        throw new Error("unsafe or duplicate artifact archive entries");
      const manifest = validateManifest(
        JSON.parse(
          unzip(["-p", zipPath, MANIFEST_FILE], { maxBuffer: 1024 * 1024 }).toString("utf8"),
        ),
      );
      if (
        (sourceSha && manifest.sourceSha !== sourceSha) ||
        (bundleId && manifest.bundleId !== bundleId) ||
        entries.length !== manifest.files.length + 1 ||
        manifest.files.some((file) => !entries.includes(file.path))
      )
        throw new Error("artifact manifest does not match the candidate/files");
      const bytes = new Map();
      for (const file of manifest.files) {
        const data = unzip(["-p", zipPath, file.path]);
        if (data.length !== file.bytes || sha256(data) !== file.sha256)
          throw new Error(`artifact file digest mismatch: ${file.path}`);
        bytes.set(file.path, data);
      }
      return { manifest, bytes };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  function archiveDownloadTimeout(sizeInBytes) {
    const bytes = Number.isFinite(sizeInBytes) && sizeInBytes > 0 ? sizeInBytes : 0;
    return Math.min(
      ARCHIVE_TIMEOUT_CEILING_MS,
      Math.max(
        ARCHIVE_TIMEOUT_FLOOR_MS,
        Math.ceil((bytes / ARCHIVE_TIMEOUT_MIN_BYTES_PER_SECOND) * 1000),
      ),
    );
  }

  // Only an archive that passed every check is memoised, and only its bytes are: each call still reads
  // the live artifact, re-asserts the digest, and re-verifies the manifest. Keying on the artifact id
  // rather than the declared digest keeps the hash load-bearing — a reused archive cannot smuggle a
  // second record past a check the first record satisfied.
  const archiveCache = new Map();

  function clearEvidenceArchiveCache() {
    archiveCache.clear();
  }

  function fetchEvidenceArchive(artifactId, sizeInBytes, download) {
    const cached = archiveCache.get(artifactId);
    if (cached) return cached;
    const timeoutMs = archiveDownloadTimeout(sizeInBytes);
    return withTimeoutRetry(
      () =>
        download
          ? download(artifactId, { timeoutMs })
          : execFileSync(
              "gh",
              ["api", `repos/${EVIDENCE_REPOSITORY}/actions/artifacts/${artifactId}/zip`],
              {
                timeout: timeoutMs,
                maxBuffer: MAX_BYTES + 5 * 1024 * 1024,
                env: githubEnvironment(),
                stdio: ["ignore", "pipe", "pipe"],
              },
            ),
      { attempts: ARCHIVE_DOWNLOAD_ATTEMPTS, label: "Evidence artifact archive download" },
    );
  }

  function rememberEvidenceArchive(artifactId, archive) {
    if (archiveCache.size >= ARCHIVE_CACHE_LIMIT)
      archiveCache.delete(archiveCache.keys().next().value);
    archiveCache.set(artifactId, archive);
  }

  function verifyArtifactArchive(artifact, { digest, sourceSha }, download) {
    const archive = fetchEvidenceArchive(artifact.id, artifact.size_in_bytes, download);
    if (archive.length > MAX_BYTES + 5 * 1024 * 1024 || sha256(archive) !== digest)
      throw new Error("downloaded artifact archive digest mismatch");
    const verified = readEvidenceArchive(archive, { sourceSha });
    if (artifact.name !== `${EVIDENCE_PREFIX}${verified.manifest.bundleId}`)
      throw new Error("artifact bundle identity mismatch");
    return { archive, verified };
  }

  // Deletion eligibility never stages files or supplies authenticated live review proof.
  function verifyRetentionArtifactRecord(
    artifact,
    run,
    { ghJson = githubJson, download, now = Date.now() } = {},
  ) {
    if (
      !Number.isSafeInteger(artifact.id) ||
      artifact.id < 1 ||
      !Number.isSafeInteger(artifact.workflow_run?.id) ||
      artifact.workflow_run.id < 1 ||
      !isArchiveDigest(artifact.digest) ||
      ![
        "success",
        "failure",
        "cancelled",
        "timed_out",
        "action_required",
        "neutral",
        "skipped",
        "stale",
        "startup_failure",
      ].includes(run.conclusion)
    )
      throw new Error("invalid completed retention artifact identity/conclusion");
    const proof = {
      artifactId: artifact.id,
      runId: artifact.workflow_run.id,
      digest: artifact.digest.slice(7),
      now,
    };
    verifyPublisherArtifactProvenance(artifact, run, proof);
    const { archive, verified } = verifyArtifactArchive(artifact, proof, download);
    const { manifest } = verified;
    const source = ghJson([
      "api",
      `repos/${EVIDENCE_REPOSITORY}/git/commits/${manifest.sourceSha}`,
    ]);
    if (source?.sha !== manifest.sourceSha)
      throw new Error("retention artifact source commit identity mismatch");
    rememberEvidenceArchive(artifact.id, archive);
    return { artifact, manifest };
  }

  function verifyArtifactRecord(
    record,
    { ghJson = githubJson, download, now = Date.now(), stageDirectory } = {},
  ) {
    if (!record?.artifact) return null;
    const proof = record.artifact;
    if (
      !isHexHash(proof.sourceSha, 40) ||
      !Number.isSafeInteger(proof.runId) ||
      proof.runId < 1 ||
      !Number.isSafeInteger(proof.artifactId) ||
      proof.artifactId < 1 ||
      !isHexHash(proof.digest, 64) ||
      !Array.isArray(proof.files)
    )
      throw new Error(
        "live proof requires valid IDs/digest/files and an explicit expected source SHA",
      );
    const artifact = ghJson([
      "api",
      `repos/${EVIDENCE_REPOSITORY}/actions/artifacts/${proof.artifactId}`,
    ]);
    const run = ghJson(["api", `repos/${EVIDENCE_REPOSITORY}/actions/runs/${proof.runId}`]);
    verifyArtifactProvenance(artifact, run, { ...proof, now });
    const { archive, verified } = verifyArtifactArchive(artifact, proof, download);
    const { manifest } = verified;
    for (const file of proof.files) {
      if (!manifest.files.some((item) => item.path === file.path && item.sha256 === file.sha256))
        throw new Error(`screenshot absent from artifact manifest: ${file.path}`);
    }
    rememberEvidenceArchive(proof.artifactId, archive);
    const result = {
      artifact,
      manifest,
      ...(stageDirectory ? { localEvidence: stageEvidence(verified, proof, stageDirectory) } : {}),
    };
    if (result.localEvidence)
      authenticatedStages.set(result.localEvidence, sha256(JSON.stringify(result.localEvidence)));
    return result;
  }
  return {
    EVIDENCE_REPOSITORY,
    EVIDENCE_WORKFLOW,
    EVIDENCE_PREFIX,
    MANIFEST_FILE,
    MAX_BYTES,
    MAX_FILE_BYTES,
    ARCHIVE_TIMEOUT_FLOOR_MS,
    ARCHIVE_TIMEOUT_CEILING_MS,
    ARCHIVE_DOWNLOAD_ATTEMPTS,
    ARCHIVE_TIMEOUT_MIN_BYTES_PER_SECOND,
    assertAuthenticatedEvidenceStage,
    sha256,
    safeEvidencePath,
    validateManifest,
    snapshotEvidence,
    githubJson,
    verifyArtifactProvenance,
    removeStagedEvidence,
    readEvidenceArchive,
    archiveDownloadTimeout,
    clearEvidenceArchiveCache,
    verifyRetentionArtifactRecord,
    verifyArtifactRecord,
  };
}
