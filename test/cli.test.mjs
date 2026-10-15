import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  chmodSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvidencePublisher } from "../index.mjs";
import { evidenceFixture } from "./evidence-fixture.mjs";

import { runnerFixture } from "./runner-fixture.mjs";
const bin = fileURLToPath(new URL("../bin/review-evidence.mjs", import.meta.url));
test("CLI prepares a custom-branch runner snapshot and cleans only its owned scratch", (t) => {
  const f = runnerFixture(t, {
    branch: "trunk",
    workflow: ".github/workflows/publish-captures.yaml",
  });
  const result = f.execute(["--prepare", f.manifest.bundleId]);
  assert.equal(result.status, 0, result.stderr);
  const payload = result.stdout.trim();
  assert.equal(
    JSON.parse(readFileSync(join(payload, "evidence-manifest.json"))).bundleId,
    f.manifest.bundleId,
  );
  assert.equal(readFileSync(join(payload, "android/home.png"), "utf8"), "verified-png-bytes");
  const cleaned = f.execute(["--cleanup", payload]);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.deepEqual(readdirSync(f.runner), []);
  assert.ok(f.readCalls().every((c) => c.host === "github.com"));
});

for (const [name, changes] of [
  ["repository", { GITHUB_REPOSITORY: "foreign/repo" }],
  ["branch", { GITHUB_REF: "refs/heads/feature" }],
  ["event", { GITHUB_EVENT_NAME: "pull_request" }],
  [
    "workflow",
    {
      GITHUB_WORKFLOW_REF: "example/independent-app/.github/workflows/foreign.yml@refs/heads/main",
    },
  ],
])
  test(`CLI refuses wrong ${name} before transfer access`, (t) => {
    const f = runnerFixture(t);
    const result = f.execute(["--prepare", f.manifest.bundleId], changes);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /publisher|context/);
    assert.deepEqual(f.readCalls(), []);
    assert.deepEqual(readdirSync(f.runner), []);
  });

test("CLI refuses ignored publication flags on runner operations before doing work", (t) => {
  const f = runnerFixture(t);
  for (const args of [
    ["--prepare", f.manifest.bundleId, "--issue", "1"],
    ["--prepare", f.manifest.bundleId, "--apply"],
    ["--prune", "--dir", f.root],
    ["--resume", f.manifest.bundleId, "--issue", "1"],
  ]) {
    const result = f.execute(args);
    assert.notEqual(result.status, 0, result.stdout);
  }
  assert.deepEqual(f.readCalls(), []);
});

test("CLI cleanup preserves outside and symlink targets", (t) => {
  const f = runnerFixture(t);
  const outside = join(f.root, "review-evidence-external");
  mkdirSync(join(outside, "payload"), { recursive: true });
  writeFileSync(join(outside, "payload/keep.txt"), "retained");
  assert.notEqual(f.execute(["--cleanup", join(outside, "payload")]).status, 0);
  const alias = join(f.runner, "review-evidence-alias");
  symlinkSync(outside, alias);
  assert.notEqual(f.execute(["--cleanup", join(alias, "payload")]).status, 0);
  assert.equal(readFileSync(join(outside, "payload/keep.txt"), "utf8"), "retained");
});

test("help works without a config and local retention preview does not require runner context", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-help-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const help = spawnSync(process.execPath, [bin, "--help"], { cwd: root, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage/);
  const f = runnerFixture(t);
  const preview = f.execute(["--prune"], {
    GITHUB_ACTIONS: "",
    GITHUB_REF: "",
    GITHUB_WORKFLOW_REF: "",
    GITHUB_EVENT_NAME: "",
  });
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout).artifacts, []);
});

test("default artifact download executor uses the configured GitHub.com boundary", (t) => {
  const f = runnerFixture(t);
  const source = `import fs from 'node:fs'; import {createEvidencePublisher} from ${JSON.stringify(new URL("../index.mjs", import.meta.url).href)}; const p=createEvidencePublisher(${JSON.stringify(f.config)}); console.log(p.verifyArtifactRecord(${JSON.stringify(f.archiveFixture.record)}).manifest.bundleId);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: f.root,
    encoding: "utf8",
    env: f.env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), f.manifest.bundleId);
  assert.ok(f.readCalls().some((c) => c.args.at(-1).endsWith("/zip")));
  assert.ok(f.readCalls().every((c) => c.host === "github.com"));
});
