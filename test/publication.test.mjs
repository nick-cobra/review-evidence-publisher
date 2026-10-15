import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createEvidencePublisher } from "../index.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareEvidenceUpload,
  publishEvidence,
  pruneEvidenceArtifacts,
  retentionCandidates,
  stageEvidenceBundle,
  pruneEvidenceTransfers,
  discardSpoolBundle,
} from "./fixture-publisher.mjs";
import {
  sha256,
  snapshotEvidence,
  EVIDENCE_PREFIX,
  EVIDENCE_WORKFLOW,
  clearEvidenceArchiveCache,
  verifyArtifactRecord,
} from "./fixture-publisher.mjs";

test("explicit discard retires an owned interrupted bundle without trusting partial contents", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-evidence-discard-")));
  try {
    const spool = join(root, "spool");
    mkdirSync(spool, { mode: 0o700 });
    const external = join(root, "external");
    mkdirSync(external);
    writeFileSync(join(external, "keep.txt"), "original");
    for (const contents of ["absent", "malformed"]) {
      const id = sha256(Buffer.from(contents));
      const directory = join(spool, id);
      const payload = join(directory, "payload");
      mkdirSync(payload, { recursive: true, mode: 0o700 });
      writeFileSync(join(payload, "partial.png"), "partial capture");
      if (contents !== "absent") writeFileSync(join(payload, "evidence-manifest.json"), contents);
      symlinkSync(external, join(payload, "external-link"));
      discardSpoolBundle(spool, id);
      assert.equal(readdirSync(spool).includes(id), false);
      assert.equal(readFileSync(join(external, "keep.txt"), "utf8"), "original");
    }
    const snapshot = snapshotEvidence(external, { sourceSha: "a".repeat(40), issue: 1 });
    const changedId = snapshot.manifest.bundleId;
    const changedPayload = join(spool, changedId, "payload");
    mkdirSync(changedPayload, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(changedPayload, "evidence-manifest.json"),
      JSON.stringify(snapshot.manifest),
    );
    writeFileSync(join(changedPayload, "keep.txt"), "damaged capture");
    discardSpoolBundle(spool, changedId);
    assert.equal(readdirSync(spool).includes(changedId), false);
    const otherId = "b".repeat(64);
    mkdirSync(join(spool, otherId));
    const linkedId = "c".repeat(64);
    symlinkSync(external, join(spool, linkedId));
    assert.throws(() => discardSpoolBundle(spool, linkedId), /unsafe evidence spool bundle/);
    assert.throws(() => discardSpoolBundle(spool, "../external"), /invalid evidence bundle ID/);
    assert.equal(readdirSync(spool).includes(otherId), true);
    assert.equal(readFileSync(join(external, "keep.txt"), "utf8"), "original");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const config of [
  { repository: "acme/widget" },
  {
    repository: "example/independent-app",
    branch: "trunk",
    workflow: ".github/workflows/publish-captures.yaml",
    visibility: "public",
    transferTag: "capture-transfer",
    transferMarker: "<!-- custom-capture-transfer:v1 -->",
  },
])
  test(`publication and uncertain-dispatch recovery in ${config.repository}`, async (t) => {
    const {
      publishEvidence,
      prepareEvidenceUpload,
      verifyArtifactRecord,
      clearEvidenceArchiveCache,
      EVIDENCE_PREFIX,
      sha256,
    } = createEvidencePublisher(config);
    const repository = config.repository;
    const branch = config.branch ?? "main";
    const workflow = config.workflow ?? ".github/workflows/publish-review-evidence.yml";
    const githubNow = Date.parse("2026-10-11T10:00:00Z");
    t.mock.method(Date, "now", () => githubNow + 3600000);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "review-evidence-test-")));
    try {
      const cwd = join(root, "repo");
      const directory = join(root, "captures");
      const spoolRoot = join(root, "spool");
      mkdirSync(cwd);
      mkdirSync(directory);
      mkdirSync(spoolRoot, { mode: 0o700 });
      execFileSync("git", ["init", "--quiet"], { cwd });
      execFileSync("git", ["config", "core.hooksPath", join(root, "disabled-hooks")], { cwd });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "fixture",
        ],
        { cwd },
      );
      const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd,
        encoding: "utf8",
      }).trim();
      writeFileSync(join(directory, "home.png"), Buffer.from("synthetic screenshot bytes"));
      let dispatches = 0,
        manifest,
        archive,
        artifact,
        transferAsset,
        transferBytes,
        releaseExists = false;
      const run = {
        id: 123,
        repository: { full_name: repository },
        head_repository: { full_name: repository },
        event: "workflow_dispatch",
        head_branch: branch,
        path: workflow,
        status: "completed",
        conclusion: "success",
        created_at: new Date(githubNow).toISOString(),
      };
      const release = {
        id: 77,
        tag_name: config.transferTag ?? "review-evidence-transfer",
        draft: false,
        prerelease: true,
        body: config.transferMarker ?? "<!-- review-evidence-publisher-transfer:v1 -->",
      };
      const ghRun = (args) => {
        if (args[0] === "release" && args[1] === "create") {
          releaseExists = true;
          return;
        }
        if (args[0] === "release" && args[1] === "upload") {
          transferBytes = readFileSync(args[3]);
          const bundle = readdirSync(spoolRoot)[0];
          transferAsset = {
            id: 789,
            name: `${EVIDENCE_PREFIX}${bundle}.zip`,
            state: "uploaded",
            size: transferBytes.length,
            digest: `sha256:${sha256(transferBytes)}`,
          };
          return;
        }
        if (args[0] === "api" && args.includes("DELETE")) {
          transferAsset = null;
          return;
        }
        assert.equal(args[0], "workflow");
        assert.equal(args[2], workflow.split("/").at(-1));
        assert.equal(args[args.indexOf("--ref") + 1], branch);
        dispatches++;
        const bundle = readdirSync(spoolRoot)[0];
        const payload = join(spoolRoot, bundle, "payload");
        const prepared = join(root, "runner-upload");
        prepareEvidenceUpload(bundle, {
          root: join(root, "other-runner-user-spool"),
          output: prepared,
          ghJson,
          downloadTransfer: () => transferBytes,
        });
        manifest = JSON.parse(readFileSync(join(payload, "evidence-manifest.json")));
        const zip = join(root, "published.zip");
        execFileSync("zip", ["-q", "-r", zip, "."], { cwd: prepared });
        archive = readFileSync(zip);
        run.display_title = `Publish review evidence ${bundle}`;
        artifact = {
          id: 456,
          name: `${EVIDENCE_PREFIX}${bundle}`,
          workflow_run: { id: 123 },
          expired: false,
          expires_at: "2099-01-01T00:00:00Z",
          size_in_bytes: archive.length,
          digest: `sha256:${sha256(archive)}`,
        };
      };
      const ghJson = (args) => {
        const endpoint = args.at(-1);
        assert.ok(
          endpoint.startsWith(`repos/${repository}`),
          `wrong repository route: ${endpoint}`,
        );
        if (endpoint === `repos/${repository}`)
          return { private: (config.visibility ?? "private") === "private" };
        if (endpoint.includes("/releases/tags/")) {
          if (!releaseExists) throw new Error("HTTP 404");
          return release;
        }
        if (endpoint.includes("/releases/77/assets")) return transferAsset ? [transferAsset] : [];
        if (endpoint.includes("/git/commits/")) return { sha: sourceSha };
        if (endpoint.includes("/workflows/") && endpoint.includes("/runs")) {
          assert.equal(
            new URL(endpoint, "https://api.github.com/").searchParams.get("branch"),
            branch,
          );
          assert.ok(endpoint.includes(`/workflows/${workflow.split("/").at(-1)}/runs?`));
          const created = new URL(endpoint, "https://api.github.com/").searchParams.get("created");
          const includesRun = !created || Date.parse(created.replace(/^>=/, "")) <= githubNow;
          return { workflow_runs: dispatches && includesRun ? [run] : [] };
        }
        if (endpoint.includes("/runs/123/artifacts?"))
          return { artifacts: artifact ? [artifact] : [] };
        if (endpoint.endsWith("/artifacts/456")) return artifact;
        if (endpoint.endsWith("/runs/123")) return run;
        throw new Error(`unexpected GH boundary: ${endpoint}`);
      };
      const settings = {
        cwd,
        directory,
        issue: 1,
        spoolRoot,
        ghRun,
        ghJson,
        download: () => archive,
        downloadTransfer: () => transferBytes,
        delay: async () => {},
        maxPolls: 2,
      };
      const firstDispatch = ghRun;
      await assert.rejects(
        publishEvidence({
          ...settings,
          ghRun: (args) => {
            firstDispatch(args);
            if (args[0] === "workflow") throw new Error("response lost after acceptance");
          },
        }),
        /uncertain/,
      );
      const retained = readdirSync(spoolRoot);
      assert.equal(retained.length, 1, "uncertain dispatch retains the original immutable bundle");
      let published;
      try {
        published = await publishEvidence({ ...settings, resume: retained[0] });
      } finally {
        assert.equal(dispatches, 1, "resume finds the accepted run despite sender clock skew");
      }
      assert.equal(transferAsset, null, "verified publication removes its transfer asset");
      assert.equal(published.manifest.sourceSha, sourceSha);
      assert.equal(published.manifest.createdAt, "2026-10-11T11:00:00.000Z");
      assert.equal(
        published.artifact.url,
        `https://github.com/${repository}/actions/runs/123/artifacts/456`,
      );
      assert.deepEqual(readdirSync(spoolRoot), [], "only verified publication retires its spool");
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }), "");
      assert.equal(manifest.files[0].sha256, sha256(readFileSync(join(directory, "home.png"))));

      writeFileSync(join(cwd, "dirty.txt"), "dirty");
      await assert.rejects(publishEvidence(settings), /clean/);
      assert.equal(dispatches, 1);

      const record = { artifact: { ...published.artifact, sourceSha, files: manifest.files } };
      // A verified archive is memoised by artifact id, so a download that hands back different bytes is
      // only observable on a cold fetch; evidence-artifacts.test.mjs covers the warm path.
      clearEvidenceArchiveCache();
      assert.throws(
        () => verifyArtifactRecord(record, { ghJson, download: () => Buffer.from("tampered") }),
        /digest/,
      );
      artifact.expired = true;
      assert.throws(
        () => verifyArtifactRecord(record, { ghJson, download: () => archive }),
        /expired/,
      );
      artifact.expired = false;
      run.head_branch = "feature";
      assert.throws(
        () => verifyArtifactRecord(record, { ghJson, download: () => archive }),
        /only evidence workflow/,
      );
      run.head_branch = branch;
      assert.throws(
        () =>
          verifyArtifactRecord(
            { artifact: { ...record.artifact, sourceSha: "f".repeat(40) } },
            { ghJson, download: () => archive },
          ),
        /candidate/,
      );
      assert.throws(
        () =>
          verifyArtifactRecord(
            {
              artifact: {
                ...record.artifact,
                files: [{ path: "home.png", sha256: "f".repeat(64) }],
              },
            },
            { ghJson, download: () => archive },
          ),
        /screenshot absent/,
      );
      run.repository.full_name = "foreign/repo";
      assert.throws(
        () => verifyArtifactRecord(record, { ghJson, download: () => archive }),
        /only evidence workflow/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

function retentionFixture(t) {
  clearEvidenceArchiveCache();
  const root = mkdtempSync(join(tmpdir(), "review-evidence-retention-"));
  t.after(() => {
    clearEvidenceArchiveCache();
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "report.txt"), "synthetic review report");
  const { manifest } = snapshotEvidence(root, { sourceSha: "a".repeat(40), issue: 1 });
  writeFileSync(join(root, "evidence-manifest.json"), JSON.stringify(manifest));
  const zipPath = join(root, "bundle.zip");
  execFileSync("zip", ["-q", zipPath, "report.txt", "evidence-manifest.json"], { cwd: root });
  const archive = readFileSync(zipPath);
  const artifact = {
    id: 456,
    name: `${EVIDENCE_PREFIX}${manifest.bundleId}`,
    workflow_run: { id: 123 },
    created_at: "2026-01-01T00:00:00Z",
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    size_in_bytes: archive.length,
    digest: `sha256:${sha256(archive)}`,
  };
  const run = {
    id: 123,
    status: "completed",
    repository: { full_name: "acme/widget" },
    head_repository: { full_name: "acme/widget" },
    path: EVIDENCE_WORKFLOW,
    head_branch: "main",
    event: "workflow_dispatch",
    conclusion: "success",
  };
  const deleted = [];
  const ghJson = (args) => {
    const endpoint = args.at(-1);
    if (endpoint.includes("/pulls?")) return [];
    if (endpoint.includes("/artifacts?")) return { artifacts: [artifact] };
    if (endpoint.endsWith("/artifacts/456")) return artifact;
    if (endpoint.endsWith("/runs/123")) return run;
    if (endpoint.endsWith(`/git/commits/${manifest.sourceSha}`)) return { sha: manifest.sourceSha };
    throw new Error(`unexpected fixture API: ${endpoint}`);
  };
  return {
    artifact,
    run,
    archive,
    manifest,
    deleted,
    settings: {
      ghJson,
      download: () => archive,
      ghRun: (args) => deleted.push(args),
      now: Date.parse("2026-10-11T00:00:00Z"),
      apply: true,
    },
  };
}

test("retention removes verified uploads from failed or cancelled completed runs without accepting live proof", (t) => {
  const fixture = retentionFixture(t);
  for (const conclusion of ["failure", "cancelled"]) {
    fixture.run.conclusion = conclusion;
    assert.deepEqual(pruneEvidenceArtifacts(fixture.settings), [{ id: 456, applied: true }]);
    assert.throws(
      () =>
        verifyArtifactRecord(
          {
            artifact: {
              artifactId: 456,
              runId: 123,
              digest: sha256(fixture.archive),
              sourceSha: fixture.manifest.sourceSha,
              files: fixture.manifest.files,
            },
          },
          fixture.settings,
        ),
      /successful main-only/,
    );
  }
  assert.equal(fixture.deleted.length, 2);
});

test("retention verifies archive bytes before deleting even a successful publisher artifact", (t) => {
  const fixture = retentionFixture(t);
  assert.throws(
    () =>
      pruneEvidenceArtifacts({
        ...fixture.settings,
        download: () => Buffer.from("tampered archive"),
      }),
    /digest/,
  );
  assert.deepEqual(fixture.deleted, []);
});

test("retention requires explicit unexpired metadata at the final artifact reread", (t) => {
  for (const conclusion of ["success", "failure", "cancelled"]) {
    for (const expired of [undefined, null, 0, true, "false"]) {
      const { settings, artifact, run, deleted } = retentionFixture(t);
      run.conclusion = conclusion;
      let reads = 0;
      const finalArtifact = { ...artifact };
      if (expired === undefined) delete finalArtifact.expired;
      else finalArtifact.expired = expired;
      assert.throws(
        () =>
          pruneEvidenceArtifacts({
            ...settings,
            ghJson: (args) => {
              if (args.at(-1).endsWith("/artifacts/456") && ++reads === 2) return finalArtifact;
              return settings.ghJson(args);
            },
          }),
        /identity changed/,
        `${conclusion}: final expired=${String(expired)} must refuse deletion`,
      );
      assert.equal(reads, 2);
      assert.deepEqual(deleted, []);
    }
    const valid = retentionFixture(t);
    valid.run.conclusion = conclusion;
    assert.deepEqual(pruneEvidenceArtifacts(valid.settings), [{ id: 456, applied: true }]);
    assert.equal(valid.deleted.length, 1);
  }
});

test("retention refuses changed identity, unknown source and incomplete or unbounded listings", (t) => {
  const { settings, artifact, deleted } = retentionFixture(t);
  let reads = 0;
  assert.throws(
    () =>
      pruneEvidenceArtifacts({
        ...settings,
        ghJson: (args) => {
          if (args.at(-1).endsWith("/artifacts/456") && ++reads > 1)
            return { ...artifact, digest: `sha256:${"f".repeat(64)}` };
          return settings.ghJson(args);
        },
      }),
    /identity changed/,
  );
  assert.throws(
    () =>
      pruneEvidenceArtifacts({
        ...settings,
        ghJson: (args) =>
          args.at(-1).includes("/git/commits/") ? { sha: "f".repeat(40) } : settings.ghJson(args),
      }),
    /source commit identity/,
  );
  assert.throws(
    () =>
      pruneEvidenceArtifacts({
        ...settings,
        ghJson: (args) => (args.at(-1).includes("/pulls?") ? {} : settings.ghJson(args)),
      }),
    /incomplete GitHub PR/,
  );
  let pages = 0;
  assert.throws(
    () =>
      pruneEvidenceArtifacts({
        ...settings,
        ghJson: (args) => {
          if (args.at(-1).includes("/artifacts?")) {
            pages++;
            return { artifacts: Array(100).fill(artifact) };
          }
          return settings.ghJson(args);
        },
      }),
    /pagination bound/,
  );
  assert.equal(pages, 100);
  assert.deepEqual(deleted, []);
});

test("retention verifies complete manifest files and refuses unknown run conclusions", (t) => {
  const { settings, artifact, run, archive, deleted } = retentionFixture(t);
  const badArchive = Buffer.from(archive);
  // Keep the ZIP structurally readable while changing the uncompressed report checksum.
  const report = badArchive.indexOf(Buffer.from("synthetic review report"));
  assert.ok(report > 0);
  badArchive[report] ^= 1;
  artifact.digest = `sha256:${sha256(badArchive)}`;
  assert.throws(
    () =>
      pruneEvidenceArtifacts({
        ...settings,
        download: () => badArchive,
      }),
    /unzip|digest|Command failed/,
  );
  artifact.digest = `sha256:${sha256(archive)}`;
  run.conclusion = null;
  assert.throws(() => pruneEvidenceArtifacts(settings), /identity\/conclusion/);
  run.status = "in_progress";
  assert.deepEqual(pruneEvidenceArtifacts(settings), []);
  assert.deepEqual(deleted, []);
});

test("retention refuses incomplete artifact metadata before deletion", (t) => {
  const { settings, artifact, deleted } = retentionFixture(t);
  for (const field of ["size_in_bytes", "expired", "expires_at", "digest"]) {
    const original = artifact[field];
    delete artifact[field];
    assert.throws(() => pruneEvidenceArtifacts(settings), /identity|expired/);
    artifact[field] = original;
  }
  assert.deepEqual(deleted, []);
});

test("retention rechecks publisher activity and provenance after archive verification", (t) => {
  for (const change of [
    (run) => {
      run.status = "in_progress";
    },
    (run) => {
      run.conclusion = null;
    },
    (run) => {
      run.path = ".github/workflows/ci.yml";
    },
    (run) => {
      run.head_branch = "feature";
    },
    (run) => {
      run.repository.full_name = "foreign/repo";
    },
  ]) {
    const fixture = retentionFixture(t);
    assert.throws(
      () =>
        pruneEvidenceArtifacts({
          ...fixture.settings,
          download: () => {
            change(fixture.run);
            return fixture.archive;
          },
        }),
      /publisher run changed/,
    );
    assert.deepEqual(fixture.deleted, []);
  }
});

test("retention rechecks active references and publisher ownership at the delete boundary", (t) => {
  const { artifact, run, settings: fixtureSettings } = retentionFixture(t);
  let prReads = 0;
  const deleted = [];
  const ghJson = (args) => {
    const endpoint = args.at(-1);
    if (endpoint.includes("/pulls?")) {
      prReads++;
      return [
        {
          state: prReads > 1 ? "open" : "closed",
          closed_at: "2026-01-02T00:00:00Z",
          body: "https://github.com/acme/widget/actions/runs/123/artifacts/456",
        },
      ];
    }
    if (endpoint.includes("/artifacts?")) return { artifacts: [artifact] };
    if (endpoint.endsWith("/artifacts/456")) return artifact;
    if (endpoint.endsWith("/runs/123")) return run;
    return fixtureSettings.ghJson(args);
  };
  const settings = {
    ...fixtureSettings,
    ghJson,
    ghRun: (args) => deleted.push(args),
  };
  assert.deepEqual(pruneEvidenceArtifacts(settings), []);
  assert.deepEqual(deleted, []);
  prReads = -100;
  assert.deepEqual(pruneEvidenceArtifacts(settings), [{ id: 456, applied: true }]);
  assert.equal(deleted.length, 1);
  run.path = ".github/workflows/ci.yml";
  assert.deepEqual(pruneEvidenceArtifacts(settings), []);
  assert.equal(deleted.length, 1);
  assert.throws(
    () =>
      pruneEvidenceArtifacts({
        ...settings,
        ghJson: () => {
          throw new Error("API unavailable");
        },
      }),
    /API unavailable/,
  );
  assert.equal(deleted.length, 1);
});

test("retention protects open references and waits for the latest referencing PR closure", () => {
  const artifact = (id) => ({
    id,
    name: `${EVIDENCE_PREFIX}${"a".repeat(64)}`,
    created_at: "2026-01-01T00:00:00Z",
  });
  const reference = (id) => `https://github.com/acme/widget/actions/runs/123/artifacts/${id}`;
  const prs = [
    { state: "open", body: reference(1), closed_at: null },
    { state: "closed", body: reference(2), closed_at: "2026-08-01T00:00:00Z" },
    { state: "closed", body: reference(3), closed_at: "2026-08-01T00:00:00Z" },
    { state: "closed", body: reference(3), closed_at: "2026-10-10T00:00:00Z" },
  ];
  assert.deepEqual(
    retentionCandidates(
      [artifact(1), artifact(2), artifact(3), artifact(4), { ...artifact(5), name: "ci-report" }],
      prs,
      Date.parse("2026-10-11T00:00:00Z"),
    ).map((item) => item.id),
    [2, 4],
  );
  assert.throws(
    () =>
      retentionCandidates(
        [artifact(1)],
        [{ state: "closed", body: reference(1), closed_at: "invalid" }],
      ),
    /closure/,
  );
});

test("snapshot rejects links and unsupported data and does not alter captures", () => {
  const root = mkdtempSync(join(tmpdir(), "review-evidence-path-test-"));
  try {
    writeFileSync(join(root, "home.png"), "fixture");
    const settings = { sourceSha: "a".repeat(40), issue: 1 };
    assert.equal(snapshotEvidence(root, settings).manifest.files.length, 1);
    symlinkSync(join(root, "home.png"), join(root, "link.png"));
    assert.throws(() => snapshotEvidence(root, settings), /symlink/);
    rmSync(join(root, "link.png"));
    writeFileSync(join(root, "execute.sh"), "echo fixture");
    assert.throws(() => snapshotEvidence(root, settings), /unsupported/);
    assert.equal(readFileSync(join(root, "home.png"), "utf8"), "fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private GitHub transfer reconciles a lost upload response and prunes only validated old bundles", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-evidence-transfer-test-")));
  try {
    const captures = join(root, "captures");
    mkdirSync(captures);
    writeFileSync(join(captures, "smoke.png"), "synthetic fixture");
    const snapshot = snapshotEvidence(captures, { sourceSha: "a".repeat(40), issue: 1 });
    const payload = join(root, "payload");
    mkdirSync(payload);
    writeFileSync(join(payload, "smoke.png"), snapshot.bytes.get("smoke.png"));
    writeFileSync(join(payload, "evidence-manifest.json"), JSON.stringify(snapshot.manifest));
    const bundle = { manifest: snapshot.manifest, payload, directory: root };
    const release = {
      id: 77,
      tag_name: "review-evidence-transfer",
      draft: false,
      prerelease: true,
      body: "<!-- review-evidence-publisher-transfer:v1 -->",
    };
    let asset,
      archive,
      uploads = 0,
      privateRepo = true;
    const deleted = [];
    const ghJson = (args) => {
      const endpoint = args.at(-1);
      if (endpoint.endsWith("acme/widget")) return { private: privateRepo };
      if (endpoint.includes("/releases/tags/")) return release;
      if (endpoint.includes("/releases/77/assets"))
        return [asset, { id: 9, name: "unrelated.zip" }].filter(Boolean);
      if (endpoint.endsWith("/releases/assets/789")) return asset;
      throw new Error(`unexpected transfer API ${endpoint}`);
    };
    const ghRun = (args) => {
      if (args[0] === "release") {
        uploads++;
        archive = readFileSync(args[3]);
        asset = {
          id: 789,
          name: `${EVIDENCE_PREFIX}${snapshot.manifest.bundleId}.zip`,
          state: "uploaded",
          size: archive.length,
          digest: `sha256:${sha256(archive)}`,
          created_at: "2026-01-01T00:00:00Z",
        };
        throw new Error("response lost after upload accepted");
      }
      deleted.push(args.at(-1));
    };
    const settings = { ghJson, ghRun, downloadTransfer: () => archive };
    assert.throws(() => stageEvidenceBundle(bundle, settings), /response lost/);
    assert.equal(stageEvidenceBundle(bundle, settings).id, 789);
    assert.equal(uploads, 1, "resume never overwrites or reuploads accepted bytes");
    assert.equal(readFileSync(join(payload, "smoke.png"), "utf8"), "synthetic fixture");
    assert.deepEqual(
      pruneEvidenceTransfers({ ...settings, now: Date.parse("2026-01-15"), apply: true }),
      [],
    );
    assert.deepEqual(
      pruneEvidenceTransfers({ ...settings, now: Date.parse("2026-10-11"), apply: true }),
      [{ id: 789, applied: true }],
    );
    assert.deepEqual(deleted, ["repos/acme/widget/releases/assets/789"]);
    assert.throws(
      () =>
        pruneEvidenceTransfers({
          ...settings,
          downloadTransfer: () => Buffer.from("changed"),
          apply: true,
        }),
      /digest/,
    );
    assert.equal(deleted.length, 1);
    asset = { ...asset, state: "starter", size: 0, digest: null };
    assert.deepEqual(
      pruneEvidenceTransfers({
        ...settings,
        downloadTransfer: () => assert.fail("empty partial uploads have no bytes"),
        apply: true,
      }),
      [{ id: 789, applied: true }],
    );
    assert.equal(deleted.length, 2);
    privateRepo = false;
    assert.throws(() => stageEvidenceBundle(bundle, settings), /private/);
    privateRepo = true;
    release.body = "different container";
    assert.throws(() => stageEvidenceBundle(bundle, settings), /container/);
    assert.equal(uploads, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
