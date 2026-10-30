import { isHexHash, isArchiveDigest } from "./identity.mjs";
import { githubEnvironment, escapeRegExp } from "./config.mjs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function createPublicationTools(config, artifacts) {
  const {
    EVIDENCE_PREFIX,
    EVIDENCE_REPOSITORY,
    EVIDENCE_WORKFLOW,
    MAX_BYTES,
    MANIFEST_FILE,
    githubJson,
    sha256,
    snapshotEvidence,
    readEvidenceArchive,
    validateManifest,
    verifyArtifactRecord,
    verifyRetentionArtifactRecord,
  } = artifacts;

  const evidenceSpoolRoot = () => join(homedir(), ".cache", ...config.cacheNamespace.split("/"));
  const TRANSFER_TAG = config.transferTag;
  const TRANSFER_MARKER = config.transferMarker;
  const transferName = (bundleId) => `${EVIDENCE_PREFIX}${bundleId}.zip`;
  const emptyTransfer = (asset) => asset.state === "starter" && asset.size === 0 && !asset.digest;
  const ghCommand = (args) =>
    execFileSync("gh", args, {
      timeout: args[0] === "release" && args[1] === "upload" ? 180000 : 30000,
      env: githubEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  const downloadTransferAsset = (id) =>
    execFileSync(
      "gh",
      [
        "api",
        "-H",
        "Accept: application/octet-stream",
        `repos/${EVIDENCE_REPOSITORY}/releases/assets/${id}`,
      ],
      {
        env: githubEnvironment(),
        timeout: 60000,
        maxBuffer: MAX_BYTES + 5 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

  function transferRelease(ghJson) {
    if (
      ghJson(["api", `repos/${EVIDENCE_REPOSITORY}`]).private !==
      (config.visibility === "private")
    )
      throw new Error(
        `review evidence transfer visibility does not match expected ${config.visibility} repository`,
      );
    const release = ghJson(["api", `repos/${EVIDENCE_REPOSITORY}/releases/tags/${TRANSFER_TAG}`]);
    if (
      !Number.isSafeInteger(release.id) ||
      release.id < 1 ||
      release.tag_name !== TRANSFER_TAG ||
      release.draft !== false ||
      release.prerelease !== true ||
      release.body !== TRANSFER_MARKER
    )
      throw new Error("unexpected review evidence transfer container");
    return release;
  }

  function transferAssets(release, ghJson) {
    return paginatedItems(
      `repos/${EVIDENCE_REPOSITORY}/releases/${release.id}/assets`,
      null,
      ghJson,
    );
  }

  function readTransfer(asset, bundleId, downloadTransfer) {
    if (
      asset.name !== transferName(bundleId) ||
      !Number.isSafeInteger(asset.id) ||
      asset.id < 1 ||
      asset.state !== "uploaded" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1 ||
      asset.size > MAX_BYTES + 5 * 1024 * 1024 ||
      !isArchiveDigest(asset.digest)
    )
      throw new Error("invalid review evidence transfer asset");
    const archive = downloadTransfer(asset.id);
    if (archive.length !== asset.size || `sha256:${sha256(archive)}` !== asset.digest)
      throw new Error("review evidence transfer digest mismatch");
    return readEvidenceArchive(archive, { bundleId });
  }

  function stageEvidenceBundle(
    bundle,
    { ghJson = githubJson, ghRun = ghCommand, downloadTransfer = downloadTransferAsset } = {},
  ) {
    let release;
    try {
      release = transferRelease(ghJson);
    } catch (error) {
      if (!/HTTP 404/.test(String(error.message))) throw error;
      // A racing/uncertain create must resolve to the same configured container.
      try {
        ghRun([
          "release",
          "create",
          TRANSFER_TAG,
          "--repo",
          EVIDENCE_REPOSITORY,
          "--target",
          bundle.manifest.sourceSha,
          "--title",
          "Review evidence transfer",
          "--notes",
          TRANSFER_MARKER,
          "--prerelease",
          "--latest=false",
        ]);
      } catch {
        /* Re-read the exact container before trusting an uncertain create. */
      }
      release = transferRelease(ghJson);
    }
    const name = transferName(bundle.manifest.bundleId);
    let matching = transferAssets(release, ghJson).filter((asset) => asset.name === name);
    if (matching.length > 1) throw new Error("duplicate transfer identity; publication refused");
    if (matching.length && emptyTransfer(matching[0])) {
      const asset = ghJson([
        "api",
        `repos/${EVIDENCE_REPOSITORY}/releases/assets/${matching[0].id}`,
      ]);
      if (
        !Number.isSafeInteger(asset.id) ||
        asset.id < 1 ||
        asset.id !== matching[0].id ||
        asset.name !== name ||
        !emptyTransfer(asset) ||
        !Number.isFinite(Date.parse(asset.created_at)) ||
        Date.parse(asset.created_at) > Date.now() - 10 * 60000
      )
        throw new Error(
          "incomplete transfer upload retained; resume after its 10-minute upload grace",
        );
      // GitHub documents empty `starter` assets after an upstream upload failure
      // as safely deletable. The grace exceeds this CLI's bounded upload timeout.
      ghRun([
        "api",
        "--method",
        "DELETE",
        `repos/${EVIDENCE_REPOSITORY}/releases/assets/${asset.id}`,
      ]);
      matching = [];
    }
    if (!matching.length) {
      const scratch = mkdtempSync(join(bundle.directory, "transfer-"));
      try {
        const archivePath = join(scratch, name);
        execFileSync("zip", ["-q", "-r", archivePath, "."], {
          cwd: bundle.payload,
          timeout: 60000,
        });
        readEvidenceArchive(readFileSync(archivePath), { bundleId: bundle.manifest.bundleId });
        ghRun(["release", "upload", TRANSFER_TAG, archivePath, "--repo", EVIDENCE_REPOSITORY]);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      matching = transferAssets(release, ghJson).filter((asset) => asset.name === name);
    }
    if (matching.length !== 1) throw new Error("transfer did not produce exactly one bundle asset");
    readTransfer(matching[0], bundle.manifest.bundleId, downloadTransfer);
    return matching[0];
  }

  function removeTransferBundle(
    bundleId,
    { ghJson = githubJson, ghRun = ghCommand, downloadTransfer = downloadTransferAsset } = {},
  ) {
    const release = transferRelease(ghJson);
    const assets = transferAssets(release, ghJson).filter(
      (asset) => asset.name === transferName(bundleId),
    );
    if (assets.length > 1) throw new Error("duplicate transfer identity; cleanup refused");
    for (const asset of assets) {
      readTransfer(asset, bundleId, downloadTransfer);
      ghRun([
        "api",
        "--method",
        "DELETE",
        `repos/${EVIDENCE_REPOSITORY}/releases/assets/${asset.id}`,
      ]);
    }
  }

  function pruneEvidenceTransfers({
    ghJson = githubJson,
    ghRun = ghCommand,
    downloadTransfer = downloadTransferAsset,
    now = Date.now(),
    apply = false,
  } = {}) {
    let release;
    try {
      release = transferRelease(ghJson);
    } catch (error) {
      if (/HTTP 404/.test(String(error.message))) return [];
      throw error;
    }
    const removed = [];
    for (const listed of transferAssets(release, ghJson)) {
      const match = /^review-evidence-([a-f0-9]{64})\.zip$/.exec(listed.name ?? "");
      if (!match) continue;
      const asset = ghJson(["api", `repos/${EVIDENCE_REPOSITORY}/releases/assets/${listed.id}`]);
      if (
        !Number.isSafeInteger(asset.id) ||
        asset.id < 1 ||
        asset.id !== listed.id ||
        asset.name !== listed.name
      )
        throw new Error("transfer identity changed during cleanup");
      const created = Date.parse(asset.created_at);
      if (!Number.isFinite(created)) throw new Error("unknown transfer age; cleanup refused");
      if (created >= now - 30 * 86400000) continue;
      if (!emptyTransfer(asset)) readTransfer(asset, match[1], downloadTransfer);
      if (apply)
        ghRun([
          "api",
          "--method",
          "DELETE",
          `repos/${EVIDENCE_REPOSITORY}/releases/assets/${asset.id}`,
        ]);
      removed.push({ id: asset.id, applied: apply });
    }
    return removed;
  }

  function privateRoot(root) {
    const absolute = resolve(root);
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    const stat = lstatSync(absolute);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(absolute) !== absolute ||
      stat.uid !== process.getuid()
    )
      throw new Error("evidence spool must be an owned real directory");
    chmodSync(absolute, 0o700);
    return absolute;
  }

  function ownedSpoolDirectory(root, bundleId) {
    if (!isHexHash(bundleId, 64)) throw new Error("invalid evidence bundle ID");
    const allowed = privateRoot(root);
    const directory = join(allowed, bundleId);
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(directory) !== directory ||
      stat.uid !== process.getuid()
    )
      throw new Error("unsafe evidence spool bundle");
    return directory;
  }

  function readSpoolBundle(root, bundleId) {
    const directory = ownedSpoolDirectory(root, bundleId);
    const payload = join(directory, "payload");
    if (lstatSync(payload).isSymbolicLink() || realpathSync(payload) !== payload)
      throw new Error("unsafe spool payload");
    const manifestPath = join(payload, MANIFEST_FILE);
    const manifestStat = lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 1024 * 1024)
      throw new Error("unsafe spool manifest");
    const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    if (manifest.bundleId !== bundleId) throw new Error("spool identity does not match manifest");
    for (const file of manifest.files) {
      const path = join(payload, file.path);
      const fileStat = lstatSync(path);
      if (
        !fileStat.isFile() ||
        fileStat.isSymbolicLink() ||
        fileStat.size !== file.bytes ||
        realpathSync(path) !== path
      )
        throw new Error("unsafe spool file");
      const bytes = readFileSync(path);
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
        throw new Error("spool file hash changed");
    }
    return { manifest, directory, payload };
  }

  function writeBundle(root, snapshot) {
    const allowed = privateRoot(root);
    const directory = join(allowed, snapshot.manifest.bundleId);
    mkdirSync(directory, { mode: 0o700 });
    const payload = join(directory, "payload");
    mkdirSync(payload, { mode: 0o700 });
    for (const [path, bytes] of snapshot.bytes) {
      mkdirSync(dirname(join(payload, path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(payload, path), bytes, { mode: 0o600, flag: "wx" });
    }
    writeFileSync(join(payload, MANIFEST_FILE), JSON.stringify(snapshot.manifest), {
      mode: 0o600,
      flag: "wx",
    });
    return readSpoolBundle(allowed, snapshot.manifest.bundleId);
  }

  function discardSpoolBundle(root, bundleId) {
    // Explicit retirement must also work after an interrupted initial write or
    // damaged contents. Ownership/path checks remain mandatory; publication and
    // resume separately require the full manifest and file-hash verification.
    const directory = ownedSpoolDirectory(root, bundleId);
    const retired = join(privateRoot(root), `.retired-${randomUUID()}`);
    renameSync(directory, retired);
    // Rename binds retirement to the checked directory. Recursive removal unlinks
    // any later symlink rather than following it outside this private spool.
    rmSync(retired, { recursive: true });
  }

  function prepareEvidenceUpload(
    bundleId,
    { output, ghJson = githubJson, downloadTransfer = downloadTransferAsset } = {},
  ) {
    if (!isHexHash(bundleId, 64)) throw new Error("invalid evidence bundle ID");
    const release = transferRelease(ghJson);
    const assets = transferAssets(release, ghJson).filter(
      (asset) => asset.name === transferName(bundleId),
    );
    if (assets.length !== 1) throw new Error("missing or duplicate evidence transfer bundle");
    const { manifest, bytes } = readTransfer(assets[0], bundleId, downloadTransfer);
    if (
      ghJson(["api", `repos/${EVIDENCE_REPOSITORY}/git/commits/${manifest.sourceSha}`]).sha !==
      manifest.sourceSha
    )
      throw new Error(`capture source is not a published commit in ${EVIDENCE_REPOSITORY}`);
    if (!output) throw new Error("runner output directory is required");
    mkdirSync(output, { mode: 0o700 });
    for (const file of manifest.files) {
      const target = join(output, file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes.get(file.path), { mode: 0o600, flag: "wx" });
    }
    writeFileSync(join(output, MANIFEST_FILE), JSON.stringify(manifest), {
      mode: 0o600,
      flag: "wx",
    });
    return manifest;
  }

  function paginatedItems(endpoint, field, ghJson) {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const response = ghJson([
        "api",
        `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      ]);
      const items = field ? response[field] : response;
      if (!Array.isArray(items)) throw new Error(`incomplete GitHub ${field ?? "PR"} listing`);
      result.push(...items);
      if (items.length < 100) return result;
    }
    throw new Error("GitHub listing exceeds the evidence pagination bound");
  }

  async function publishEvidence({
    directory,
    issue,
    cwd = process.cwd(),
    spoolRoot = evidenceSpoolRoot(),
    resume,
    ghJson = githubJson,
    ghRun = ghCommand,
    download,
    downloadTransfer = downloadTransferAsset,
    delay = () => new Promise((done) => setTimeout(done, 15000)),
    maxPolls = 60,
    log = () => {},
  } = {}) {
    let bundle;
    if (resume) bundle = readSpoolBundle(spoolRoot, resume);
    else {
      const git = (args) =>
        execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          env: githubEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      const clean = () => {
        if (git(["status", "--porcelain", "--untracked-files=normal"]))
          throw new Error("evidence publication requires a clean committed candidate");
      };
      clean();
      const sourceSha = git(["rev-parse", "HEAD"]);
      const snapshot = snapshotEvidence(directory, { sourceSha, issue });
      clean();
      if (git(["rev-parse", "HEAD"]) !== sourceSha)
        throw new Error("candidate changed during evidence snapshot");
      bundle = writeBundle(spoolRoot, snapshot);
    }
    const { manifest } = bundle;
    log(
      `Evidence bundle ${manifest.bundleId}; resume with --resume ${manifest.bundleId} using the same trusted configuration`,
    );
    if (
      ghJson(["api", `repos/${EVIDENCE_REPOSITORY}/git/commits/${manifest.sourceSha}`]).sha !==
      manifest.sourceSha
    )
      throw new Error("push the clean candidate before publishing evidence");
    stageEvidenceBundle(bundle, { ghJson, ghRun, downloadTransfer });
    const runs = () =>
      paginatedItems(
        `repos/${EVIDENCE_REPOSITORY}/actions/workflows/${encodeURIComponent(EVIDENCE_WORKFLOW.split("/").at(-1))}/runs?event=workflow_dispatch&branch=${encodeURIComponent(config.branch)}`,
        "workflow_runs",
        ghJson,
      ).filter((run) => run.display_title === `Publish review evidence ${manifest.bundleId}`);
    const existing = runs();
    const ignored = new Set(
      existing
        .filter((run) => run.status === "completed" && run.conclusion !== "success")
        .map((run) => run.id),
    );
    let activeRunId = existing
      .filter((run) => !ignored.has(run.id))
      .sort((a, b) => a.id - b.id)[0]?.id;
    if (!existing.some((run) => !ignored.has(run.id))) {
      try {
        ghRun([
          "workflow",
          "run",
          EVIDENCE_WORKFLOW.split("/").at(-1),
          "--repo",
          EVIDENCE_REPOSITORY,
          "--ref",
          config.branch,
          "-f",
          `bundle_id=${manifest.bundleId}`,
        ]);
      } catch {
        throw new Error(
          `dispatch outcome uncertain; preserve bundle and resume ${manifest.bundleId}`,
        );
      }
    }
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const run = activeRunId
        ? ghJson(["api", `repos/${EVIDENCE_REPOSITORY}/actions/runs/${activeRunId}`])
        : runs()
            .filter((item) => !ignored.has(item.id))
            .sort((a, b) => a.id - b.id)[0];
      if (run) activeRunId = run.id;
      if (run?.status === "completed") {
        if (run.conclusion !== "success")
          throw new Error(
            `evidence workflow ${run.id} ${run.conclusion}; bundle retained for retry`,
          );
        const artifacts = paginatedItems(
          `repos/${EVIDENCE_REPOSITORY}/actions/runs/${run.id}/artifacts`,
          "artifacts",
          ghJson,
        ).filter((item) => item.name === `${EVIDENCE_PREFIX}${manifest.bundleId}`);
        if (artifacts.length !== 1)
          throw new Error("publication did not produce exactly one evidence artifact");
        const artifact = artifacts[0];
        const proof = {
          url: `https://github.com/${EVIDENCE_REPOSITORY}/actions/runs/${run.id}/artifacts/${artifact.id}`,
          runId: run.id,
          artifactId: artifact.id,
          sourceSha: manifest.sourceSha,
          digest: artifact.digest?.replace(/^sha256:/, ""),
          files: manifest.files,
        };
        const verified = verifyArtifactRecord({ artifact: proof }, { ghJson, download });
        if (verified.manifest.bundleId !== manifest.bundleId)
          throw new Error("published bundle identity mismatch");
        removeTransferBundle(manifest.bundleId, { ghJson, ghRun, downloadTransfer });
        discardSpoolBundle(spoolRoot, manifest.bundleId);
        return { artifact: proof, manifest };
      }
      await delay();
    }
    throw new Error(`publication still pending; resume ${manifest.bundleId}`);
  }

  function referencedArtifacts(body = "") {
    return [
      ...String(body).matchAll(
        new RegExp(
          String.raw`https://github\.com/${escapeRegExp(EVIDENCE_REPOSITORY)}/actions/runs/[1-9][0-9]*/artifacts/([1-9][0-9]*)\b`,
          "g",
        ),
      ),
    ].map((match) => Number(match[1]));
  }

  function retentionCandidates(artifacts, prs, now = Date.now()) {
    const cutoff = now - 30 * 86400000;
    return artifacts.filter((artifact) => {
      if (!new RegExp(`^${EVIDENCE_PREFIX}[a-f0-9]{64}$`).test(artifact.name)) return false;
      const refs = prs.filter((pr) => referencedArtifacts(pr.body).includes(artifact.id));
      if (refs.some((pr) => !["open", "closed"].includes(pr.state)))
        throw new Error("unknown referencing PR state; retention refused");
      if (refs.some((pr) => pr.state === "open")) return false;
      const times = refs.length
        ? refs.map((pr) => Date.parse(pr.closed_at))
        : [Date.parse(artifact.created_at)];
      if (times.some((time) => !Number.isFinite(time)))
        throw new Error("unknown artifact age or PR closure; retention refused");
      return Math.max(...times) < cutoff;
    });
  }

  function publisherRunState(run) {
    return JSON.stringify([
      run.id,
      run.repository?.full_name,
      run.head_repository?.full_name,
      run.path,
      run.head_branch,
      run.event,
      run.status,
      run.conclusion,
    ]);
  }

  function pruneEvidenceArtifacts({
    ghJson = githubJson,
    ghRun = ghCommand,
    download,
    now = Date.now(),
    apply = false,
    shouldRetain,
  } = {}) {
    if (shouldRetain !== undefined && typeof shouldRetain !== "function")
      throw new TypeError("shouldRetain must be a function");
    const listPrs = () => {
      return paginatedItems(`repos/${EVIDENCE_REPOSITORY}/pulls?state=all`, null, ghJson);
    };
    const artifacts = paginatedItems(
      `repos/${EVIDENCE_REPOSITORY}/actions/artifacts`,
      "artifacts",
      ghJson,
    );
    const candidates = retentionCandidates(artifacts, listPrs(), now);
    const deleted = [];
    for (const candidate of candidates) {
      const artifact = ghJson([
        "api",
        `repos/${EVIDENCE_REPOSITORY}/actions/artifacts/${candidate.id}`,
      ]);
      const run = ghJson([
        "api",
        `repos/${EVIDENCE_REPOSITORY}/actions/runs/${artifact.workflow_run?.id}`,
      ]);
      if (
        artifact.id !== candidate.id ||
        artifact.name !== candidate.name ||
        artifact.workflow_run?.id !== candidate.workflow_run?.id ||
        artifact.digest !== candidate.digest ||
        run.id !== artifact.workflow_run?.id ||
        run.status !== "completed" ||
        run.repository?.full_name !== EVIDENCE_REPOSITORY ||
        run.head_repository?.full_name !== EVIDENCE_REPOSITORY ||
        run.path !== EVIDENCE_WORKFLOW ||
        run.head_branch !== config.branch ||
        run.event !== "workflow_dispatch"
      )
        continue;
      const verifiedRunState = publisherRunState(run);
      const verified = verifyRetentionArtifactRecord(artifact, run, { ghJson, download, now });
      if (shouldRetain) {
        const retained = shouldRetain({
          ...structuredClone({ artifact, run, manifest: verified.manifest, now }),
          bytes: new Map(
            [...verified.bytes].map(([path, bytes]) => {
              const copy = Buffer.alloc(bytes.length);
              copy.set(bytes);
              return [path, copy];
            }),
          ),
        });
        if (typeof retained !== "boolean") {
          // An accidental async callback is still refused synchronously; consume
          // its rejection so it does not escape as an unhandled process error.
          Promise.resolve(retained).catch(() => {});
          throw new TypeError("shouldRetain must return a synchronous boolean");
        }
        if (retained) continue;
      }
      const finalArtifact = ghJson([
        "api",
        `repos/${EVIDENCE_REPOSITORY}/actions/artifacts/${artifact.id}`,
      ]);
      if (
        finalArtifact.id !== artifact.id ||
        finalArtifact.name !== artifact.name ||
        finalArtifact.workflow_run?.id !== artifact.workflow_run.id ||
        finalArtifact.digest !== artifact.digest ||
        finalArtifact.expired !== false ||
        finalArtifact.expires_at !== artifact.expires_at ||
        finalArtifact.size_in_bytes !== artifact.size_in_bytes
      )
        throw new Error("retention artifact identity changed before deletion");
      const finalRun = ghJson([
        "api",
        `repos/${EVIDENCE_REPOSITORY}/actions/runs/${artifact.workflow_run.id}`,
      ]);
      if (publisherRunState(finalRun) !== verifiedRunState)
        throw new Error("retention publisher run changed before deletion");
      if (!retentionCandidates([finalArtifact], listPrs(), now).length) continue;
      if (apply)
        ghRun([
          "api",
          "--method",
          "DELETE",
          `repos/${EVIDENCE_REPOSITORY}/actions/artifacts/${artifact.id}`,
        ]);
      deleted.push({ id: artifact.id, applied: apply });
    }
    return deleted;
  }
  return {
    evidenceSpoolRoot,
    TRANSFER_TAG,
    TRANSFER_MARKER,
    stageEvidenceBundle,
    removeTransferBundle,
    pruneEvidenceTransfers,
    readSpoolBundle,
    discardSpoolBundle,
    prepareEvidenceUpload,
    publishEvidence,
    referencedArtifacts,
    retentionCandidates,
    pruneEvidenceArtifacts,
  };
}
