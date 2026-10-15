import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createEvidencePublisher } from "../index.mjs";
import { evidenceFixture } from "./evidence-fixture.mjs";

test("trusted configuration binds snapshots and cache to an independent repository", (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "report.txt"), "synthetic report");
  const config = {
    repository: "example/independent-app",
    branch: "trunk",
    workflow: ".github/workflows/publish-captures.yaml",
  };
  const publisher = createEvidencePublisher(config);
  config.repository = "foreign/repo";
  assert.equal(
    publisher.snapshotEvidence(root, { sourceSha: "a".repeat(40), issue: 1 }).manifest.repository,
    "example/independent-app",
  );
  assert.equal(publisher.EVIDENCE_WORKFLOW, ".github/workflows/publish-captures.yaml");
  assert.equal(publisher.config.branch, "trunk");
  assert.equal(
    publisher.evidenceSpoolRoot(),
    join(homedir(), ".cache/review-evidence-publisher/example/independent-app"),
  );
});

test("constructor refuses unknown or unsafe trust settings", () => {
  for (const config of [
    undefined,
    {},
    { repository: "../repo" },
    { repository: "a/b/c" },
    { repository: "a/b", host: "foreign.invalid" },
    { repository: "a/b", workflow: "../ci.yml" },
    { repository: "a/b", branch: "foo..bar" },
    { repository: "a/b", branch: "-main" },
    { repository: "a/b", visibility: "auto" },
    { repository: "a/b", cacheNamespace: "../outside" },
    { repository: "a/b", transferTag: "../tag" },
    { repository: "a/b", transferMarker: "" },
  ]) {
    assert.throws(
      () => createEvidencePublisher(config),
      /configuration|repository|workflow|branch|visibility|cache|transfer/,
    );
  }
});

test("public transfer requires explicit expected visibility and observed match", () => {
  const configured = createEvidencePublisher({ repository: "acme/widget", visibility: "public" });
  assert.throws(
    () =>
      configured.stageEvidenceBundle(
        { manifest: {} },
        {
          ghJson: (args) => {
            if (args.at(-1) === "repos/acme/widget") return { private: false };
            throw new Error("release lookup reached");
          },
        },
      ),
    /release lookup reached/,
  );
  for (const visibility of ["private", "public"]) {
    const publisher = createEvidencePublisher({ repository: "acme/widget", visibility });
    let reads = 0;
    assert.throws(
      () =>
        publisher.stageEvidenceBundle(
          { manifest: {} },
          {
            ghJson: () => {
              reads++;
              return { private: visibility === "public" };
            },
          },
        ),
      /visibility|private/,
    );
    assert.equal(reads, 1);
  }
});

test("live proof requires an explicit expected source, not only a self-declared manifest", (t) => {
  const publisher = createEvidencePublisher({ repository: "acme/widget" });
  const fixture = evidenceFixture(publisher, t);
  for (const sourceSha of [undefined, "", "bad"]) {
    assert.throws(
      () =>
        publisher.verifyArtifactRecord(
          { artifact: { ...fixture.proof, sourceSha } },
          { ghJson: fixture.ghJson, download: () => fixture.archive },
        ),
      /expected source/,
    );
  }
});

test("publisher instances isolate archive IDs and authenticated stages", (t) => {
  const first = createEvidencePublisher({ repository: "acme/widget" });
  const second = createEvidencePublisher({ repository: "example/other" });
  const stageRoot = mkdtempSync(join(tmpdir(), "review-isolation-"));
  let stage;
  t.after(() => {
    if (stage) first.removeStagedEvidence(stage.root);
    rmSync(stageRoot, { recursive: true, force: true });
  });
  const a = evidenceFixture(first, t);
  const b = evidenceFixture(second, t);
  let downloads = 0;
  const firstResult = first.verifyArtifactRecord(a.record, {
    ghJson: a.ghJson,
    download: () => {
      downloads++;
      return a.archive;
    },
    stageDirectory: stageRoot,
  });
  stage = firstResult.localEvidence;
  const secondResult = second.verifyArtifactRecord(b.record, {
    ghJson: b.ghJson,
    download: () => {
      downloads++;
      return b.archive;
    },
  });
  assert.equal(downloads, 2);
  assert.equal(secondResult.manifest.repository, "example/other");
  first.assertAuthenticatedEvidenceStage(firstResult.localEvidence);
  assert.throws(
    () => second.assertAuthenticatedEvidenceStage(firstResult.localEvidence),
    /authentication/,
  );
});

test("default GitHub metadata executor ignores an inherited foreign host", (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-gh-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "gh"),
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({host:process.env.GH_HOST}));\n`,
  );
  chmodSync(join(root, "gh"), 0o700);
  const source = `import {createEvidencePublisher} from ${JSON.stringify(new URL("../index.mjs", import.meta.url).href)}; console.log(createEvidencePublisher({repository:'acme/widget'}).githubJson(['api','fixture']).host);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    env: { PATH: root, GH_HOST: "foreign.invalid" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "github.com");
});

test("explicit null and control characters are invalid trust configuration", () => {
  for (const [key, value] of [
    ["workflow", null],
    ["branch", null],
    ["visibility", null],
    ["repository", "acme/widget\n"],
    ["workflow", ".github/workflows/publish.yml\n"],
    ["branch", "main\n"],
    ["transferTag", "evidence\n"],
    ["transferMarker", "<!-- evidence:v1 -->\n"],
    ["cacheNamespace", "evidence/cache\n"],
  ])
    assert.throws(
      () => createEvidencePublisher({ repository: "acme/widget", [key]: value }),
      /configuration/,
    );
});

test("retention uses a custom repository, workflow and slash branch through final deletion", (t) => {
  const publisher = createEvidencePublisher({
    repository: "example/app.v2",
    branch: "releases/review",
    workflow: ".github/workflows/captures.yaml",
  });
  const fixture = evidenceFixture(publisher, t);
  fixture.artifact.created_at = "2026-01-01T00:00:00Z";
  fixture.run.conclusion = "cancelled";
  const own = `https://github.com/example/app.v2/actions/runs/123/artifacts/456`;
  const lookalike = `https://github.com/example/appXv2/actions/runs/123/artifacts/456`;
  let references = [{ state: "open", body: lookalike }];
  const deleted = [];
  const settings = {
    apply: true,
    now: Date.parse("2026-10-15T00:00:00Z"),
    download: () => fixture.archive,
    ghRun: (args) => deleted.push(args),
    ghJson: (args) => {
      const endpoint = args.at(-1);
      assert.ok(endpoint.startsWith("repos/example/app.v2/"));
      if (endpoint.includes("/artifacts?")) return { artifacts: [fixture.artifact] };
      if (endpoint.includes("/pulls?")) return references;
      if (endpoint.includes("/git/commits/")) return { sha: fixture.manifest.sourceSha };
      return fixture.ghJson(args);
    },
  };
  assert.deepEqual(publisher.pruneEvidenceArtifacts(settings), [{ id: 456, applied: true }]);
  assert.equal(deleted.length, 1);
  references = [{ state: "open", body: own }];
  assert.deepEqual(publisher.pruneEvidenceArtifacts(settings), []);
  assert.equal(deleted.length, 1);
});

test("protocol source identities refuse line breaks and coercible non-strings", (t) => {
  const p = createEvidencePublisher({ repository: "acme/widget" });
  const f = evidenceFixture(p, t);
  for (const sourceSha of ["a".repeat(40) + "\n", ["a".repeat(40)]]) {
    const { bundleId, ...content } = f.manifest;
    content.sourceSha = sourceSha;
    assert.throws(
      () => p.validateManifest({ ...content, bundleId: p.sha256(JSON.stringify(content)) }),
      /manifest identity/,
    );
  }
});

test("safe evidence paths refuse trailing control characters", () => {
  const p = createEvidencePublisher({ repository: "acme/widget" });
  for (const path of ["image.png\n", "image.png\r", "nested/image.png\n"])
    assert.equal(p.safeEvidencePath(path), false);
});
