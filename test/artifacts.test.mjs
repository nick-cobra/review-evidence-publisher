import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEvidencePublisher } from "../index.mjs";
import { evidenceFixture as makeFixture } from "./evidence-fixture.mjs";
const artifacts = createEvidencePublisher({ repository: "acme/widget" });
const evidenceFixture = (t) => makeFixture(artifacts, t);

const VERIFY_SHA = "a".repeat(40);

const timeoutFailure = () =>
  Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT", signal: "SIGTERM" });

const verify = (record, { ghJson, download }) =>
  artifacts.verifyArtifactRecord(record, {
    ghJson,
    download,
    now: Date.parse("2026-10-13T00:00:00Z"),
  });

test("one verified artifact downloads its archive once per process", (t) => {
  const fixture = evidenceFixture(t);
  artifacts.clearEvidenceArchiveCache();
  let downloads = 0;
  const download = (artifactId) => {
    assert.equal(artifactId, 456);
    downloads += 1;
    return fixture.archive;
  };
  const first = verify(fixture.record, { ghJson: fixture.ghJson, download });
  const second = verify(fixture.record, { ghJson: fixture.ghJson, download });
  assert.equal(first.manifest.issue, 1);
  assert.equal(second.manifest.issue, 1);
  assert.equal(downloads, 1, "a merge that verifies the same record twice re-downloads nothing");
});

test("a reused archive still refuses a disagreeing digest, candidate SHA and screenshot", (t) => {
  const fixture = evidenceFixture(t);
  artifacts.clearEvidenceArchiveCache();
  let downloads = 0;
  const download = () => {
    downloads += 1;
    return fixture.archive;
  };
  const settings = { ghJson: fixture.ghJson, download };
  verify(fixture.record, settings);
  const declaredDigest = "f".repeat(64);
  assert.throws(
    () => verify({ artifact: { ...fixture.proof, digest: "e".repeat(64) } }, settings),
    /digest/,
    "a record that names a digest the live artifact does not have is refused before any download",
  );
  fixture.artifact.digest = `sha256:${declaredDigest}`;
  assert.throws(
    () => verify({ artifact: { ...fixture.proof, digest: declaredDigest } }, settings),
    /downloaded artifact archive digest mismatch/,
    "cached bytes are still hashed against the declared digest",
  );
  fixture.artifact.digest = `sha256:${artifacts.sha256(fixture.archive)}`;
  assert.throws(
    () => verify({ artifact: { ...fixture.proof, sourceSha: "e".repeat(40) } }, settings),
    /candidate/,
  );
  assert.throws(
    () =>
      verify(
        {
          artifact: {
            ...fixture.proof,
            files: [{ path: "android/absent.png", sha256: "e".repeat(64) }],
          },
        },
        settings,
      ),
    /screenshot absent/,
  );
  assert.equal(downloads, 1, "refusals reuse the archive, they do not weaken it");
});

test("an oversized archive and a mismatched bundle are still refused", (t) => {
  const fixture = evidenceFixture(t);
  artifacts.clearEvidenceArchiveCache();
  let downloads = 0;
  const download = () => {
    downloads += 1;
    return fixture.archive;
  };
  const settings = { ghJson: fixture.ghJson, download };
  verify(fixture.record, settings);
  fixture.artifact.size_in_bytes = artifacts.MAX_BYTES + 10 * 1024 * 1024;
  assert.throws(() => verify(fixture.record, settings), /oversized/);
  fixture.artifact.size_in_bytes = fixture.archive.length;
  fixture.artifact.name = `${artifacts.EVIDENCE_PREFIX}${"f".repeat(64)}`;
  assert.throws(() => verify(fixture.record, settings), /bundle identity mismatch/);
  assert.equal(downloads, 1, "both refusals read the manifest they already hold");
});

test("an archive expired after its first verification is still refused", (t) => {
  const fixture = evidenceFixture(t);
  artifacts.clearEvidenceArchiveCache();
  let downloads = 0;
  const download = () => {
    downloads += 1;
    return fixture.archive;
  };
  const settings = { ghJson: fixture.ghJson, download };
  verify(fixture.record, settings);
  fixture.artifact.expired = true;
  assert.throws(() => verify(fixture.record, settings), /expired/);
  assert.equal(downloads, 1);
});

test("a download that times out once retries and still verifies the record", (t) => {
  const fixture = evidenceFixture(t);
  artifacts.clearEvidenceArchiveCache();
  let attempts = 0;
  const download = () => {
    attempts += 1;
    if (attempts === 1) throw timeoutFailure();
    return fixture.archive;
  };
  const verified = verify(fixture.record, { ghJson: fixture.ghJson, download });
  assert.equal(verified.manifest.issue, 1);
  assert.equal(attempts, 2, "one transient runner stall must not fail the gate");
});

test("a download that never completes fails closed after a bounded number of attempts", (t) => {
  const fixture = evidenceFixture(t);
  artifacts.clearEvidenceArchiveCache();
  let attempts = 0;
  const download = () => {
    attempts += 1;
    throw timeoutFailure();
  };
  assert.throws(
    () => verify(fixture.record, { ghJson: fixture.ghJson, download }),
    /timed out/,
    "an archive that never arrives can never be reported as verified",
  );
  assert.equal(attempts, artifacts.ARCHIVE_DOWNLOAD_ATTEMPTS);
  assert.ok(
    artifacts.ARCHIVE_DOWNLOAD_ATTEMPTS >= 2 && artifacts.ARCHIVE_DOWNLOAD_ATTEMPTS <= 5,
    "the retry is bounded so a stalled runner cannot hang the gate",
  );
});

test("a refusal that is not a timeout is never retried", (t) => {
  const fixture = evidenceFixture(t);
  artifacts.clearEvidenceArchiveCache();
  let attempts = 0;
  const download = () => {
    attempts += 1;
    throw new Error("gh: Resource not accessible by integration (HTTP 403)");
  };
  assert.throws(
    () => verify(fixture.record, { ghJson: fixture.ghJson, download }),
    /403/,
    "a permission refusal is a fact, not a stall",
  );
  assert.equal(attempts, 1);
});

test("the archive timeout scales with the artifact and stays bounded", () => {
  assert.equal(artifacts.archiveDownloadTimeout(1), artifacts.ARCHIVE_TIMEOUT_FLOOR_MS);
  assert.ok(
    artifacts.archiveDownloadTimeout(17.52 * 1024 * 1024) > artifacts.ARCHIVE_TIMEOUT_FLOOR_MS,
    "the 17.52 MB archive that timed out at the floor must get more than the floor",
  );
  assert.ok(
    artifacts.archiveDownloadTimeout(6.75 * 1024 * 1024) > artifacts.ARCHIVE_TIMEOUT_FLOOR_MS,
    "the 6.75 MB archive that also timed out must not stay at the floor",
  );
  assert.ok(
    artifacts.archiveDownloadTimeout(20 * 1024 * 1024) >=
      artifacts.archiveDownloadTimeout(6 * 1024 * 1024),
  );
  assert.equal(
    artifacts.archiveDownloadTimeout(2 * 1024 * 1024 * 1024),
    artifacts.ARCHIVE_TIMEOUT_CEILING_MS,
  );
});

test("the GitHub metadata read retries a timeout and never retries a refusal", () => {
  const ok = { id: 456 };
  let timedOut = 0;
  assert.deepEqual(
    artifacts.githubJson(["api", "repos/acme/widget/actions/artifacts/456"], {
      exec: () => {
        timedOut += 1;
        if (timedOut === 1) throw timeoutFailure();
        return JSON.stringify(ok);
      },
    }),
    ok,
  );
  assert.equal(timedOut, 2);
  let refused = 0;
  assert.throws(
    () =>
      artifacts.githubJson(["api", "repos/acme/widget/actions/artifacts/456"], {
        exec: () => {
          refused += 1;
          throw new Error("gh: Not Found (HTTP 404)");
        },
      }),
    /404/,
  );
  assert.equal(refused, 1, "a 404 is not retried into a slower failure");
});

test("verified evidence becomes identical offline image/document data with read-only modes", (t) => {
  const f = evidenceFixture();
  artifacts.clearEvidenceArchiveCache();
  const stageDirectory = mkdtempSync(join(tmpdir(), "review-stage-test-"));
  t.after(() => rmSync(stageDirectory, { recursive: true, force: true }));
  const result = artifacts.verifyArtifactRecord(f.record, {
    ghJson: f.ghJson,
    download: () => f.archive,
    stageDirectory,
  });
  assert.ok(
    result.localEvidence,
    "authenticated bytes must be materialised, not a remote reference",
  );
  const local = result.localEvidence;
  t.after(() => artifacts.removeStagedEvidence(local.root));
  assert.equal(local.sourceSha, VERIFY_SHA);
  assert.equal(local.archiveSha256, f.proof.digest);
  assert.equal(local.bundleId, f.artifact.name.slice(artifacts.EVIDENCE_PREFIX.length));
  assert.equal(lstatSync(local.root).mode & 0o777, 0o500);
  for (const file of local.files) {
    assert.equal(lstatSync(file.localPath).mode & 0o777, 0o400);
    assert.equal(artifacts.sha256(readFileSync(file.localPath)), file.sha256);
  }
  const consumer = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import {readFileSync} from "node:fs"; process.stdout.write(readFileSync(process.argv[1]));',
      local.files[0].localPath,
    ],
    { encoding: "utf8", env: {} },
  );
  assert.equal(consumer.status, 0, consumer.stderr);
  assert.equal(consumer.stdout, "verified-png-bytes");
  assert.equal(JSON.parse(readFileSync(local.files[1].localPath, "utf8")).journey, "installed");
  artifacts.removeStagedEvidence(local.root);
  assert.equal(existsSync(local.root), false);
});

test("preparation refusals leave no staged files", () => {
  const f = evidenceFixture();
  const stageDirectory = mkdtempSync(join(tmpdir(), "review-stage-test-"));
  try {
    for (const download of [
      () => "https://remote.invalid/archive.zip",
      () => Buffer.from("bad bytes"),
    ]) {
      artifacts.clearEvidenceArchiveCache();
      assert.throws(
        () =>
          artifacts.verifyArtifactRecord(f.record, { ghJson: f.ghJson, download, stageDirectory }),
        /archive|bytes|digest/,
      );
    }
    for (const proof of [
      { ...f.proof, sourceSha: "f".repeat(40) },
      { ...f.proof, digest: "f".repeat(64) },
      { ...f.proof, files: [{ path: "missing.png", sha256: "f".repeat(64) }] },
    ]) {
      artifacts.clearEvidenceArchiveCache();
      assert.throws(() =>
        artifacts.verifyArtifactRecord(
          { artifact: proof },
          { ghJson: f.ghJson, download: () => f.archive, stageDirectory },
        ),
      );
    }
    assert.deepEqual(execFileSync("ls", ["-A", stageDirectory], { encoding: "utf8" }), "");
  } finally {
    rmSync(stageDirectory, { recursive: true, force: true });
  }
});

test("ZIP symlinks and special files are refused even when their payload digest matches", (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-evidence-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payload = join(root, "payload");
  mkdirSync(payload);
  writeFileSync(join(root, "target"), "verified-png-bytes");
  symlinkSync("../target", join(payload, "home.png"));
  const bytes = Buffer.from("../target");
  const content = {
    version: 1,
    repository: artifacts.EVIDENCE_REPOSITORY,
    sourceSha: VERIFY_SHA,
    issue: 1,
    createdAt: "2026-10-13T12:00:00Z",
    files: [{ path: "home.png", bytes: bytes.length, sha256: artifacts.sha256(bytes) }],
  };
  writeFileSync(
    join(payload, artifacts.MANIFEST_FILE),
    JSON.stringify({ ...content, bundleId: artifacts.sha256(JSON.stringify(content)) }),
  );
  const zip = join(root, "link.zip");
  execFileSync("zip", ["-q", "-y", zip, "home.png", artifacts.MANIFEST_FILE], { cwd: payload });
  const archive = readFileSync(zip);
  assert.throws(() => artifacts.readEvidenceArchive(archive), /symlink|regular|special|type/);
  const special = Buffer.from(archive);
  const central = special.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  special.writeUInt32LE((0o010644 << 16) >>> 0, central + 38);
  assert.throws(() => artifacts.readEvidenceArchive(special), /regular|special|type/);
});

test("bounded archive entry inventory rejects missing, extra, duplicate and unsafe evidence", () => {
  const f = evidenceFixture();
  const png = "verified-png-bytes";
  const doc = '{"journey":"installed","sourceSha":"' + VERIFY_SHA + '"}';
  const entries = [
    [artifacts.MANIFEST_FILE, JSON.stringify(f.manifest)],
    ["android/home.png", png],
    ["journey.json", doc],
  ];
  const archiveFor = (rows) =>
    execFileSync(
      "python3",
      [
        "-c",
        'import json,sys,zipfile,io; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); [z.writestr(p,v) for p,v in json.load(sys.stdin)]; z.close(); sys.stdout.buffer.write(b.getvalue())',
      ],
      { input: JSON.stringify(rows) },
    );
  for (const rows of [
    entries.slice(0, 2),
    [...entries, ["extra.txt", "undeclared"]],
    [...entries, entries[1]],
    [...entries, ["android/", ""], ["android/", ""]],
    [entries[0], ["../home.png", png], entries[2]],
    [entries[0], ["/home.png", png], entries[2]],
    [entries[0], ["android/home.png", "different bytes"], entries[2]],
    [
      [artifacts.MANIFEST_FILE, JSON.stringify({ ...f.manifest, bundleId: "f".repeat(64) })],
      ...entries.slice(1),
    ],
  ]) {
    assert.throws(
      () => artifacts.readEvidenceArchive(archiveFor(rows)),
      /manifest|digest|unsafe|duplicate/,
    );
  }
});
