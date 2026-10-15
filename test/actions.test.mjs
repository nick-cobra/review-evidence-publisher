import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseDocument } from "yaml";
import { runnerFixture } from "./runner-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
function document(path) {
  const d = parseDocument(readFileSync(new URL("../" + path, import.meta.url), "utf8"), {
    uniqueKeys: true,
  });
  assert.deepEqual(d.errors, []);
  return d.toJS({ maxAliasCount: 0 });
}
const shell = (script, env, cwd) =>
  spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
    cwd,
    encoding: "utf8",
    env,
  });

test("packaged publish Action executes the real CLI and always cleans its owned output", (t) => {
  const action = document("action.yml");
  assert.equal(action.runs.using, "composite");
  const f = runnerFixture(t, {
    branch: "trunk",
    workflow: ".github/workflows/custom-publisher.yml",
  });
  const prepare = action.runs.steps.find((step) => step.id === "prepare");
  const output = join(f.root, "outputs");
  writeFileSync(output, "");
  const env = {
    ...f.env,
    EVIDENCE_ACTION_ROOT: root,
    EVIDENCE_CONFIG: f.configPath,
    EVIDENCE_BUNDLE: f.manifest.bundleId,
    GITHUB_OUTPUT: output,
  };
  const result = shell(prepare.run, env, f.root);
  assert.equal(result.status, 0, result.stderr);
  const payload = readFileSync(output, "utf8")
    .trim()
    .replace(/^capture_path=/, "");
  assert.equal(
    JSON.parse(readFileSync(join(payload, "evidence-manifest.json"))).sourceSha,
    f.manifest.sourceSha,
  );
  const upload = action.runs.steps.find((step) => step.id === "upload");
  assert.equal(upload.uses, "actions/upload-artifact@v7");
  assert.equal(upload.with.overwrite, false);
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with.path, "${{ steps.prepare.outputs.capture_path }}/");
  assert.equal(action.inputs["retention-days"].default, "90");
  for (const name of ["artifact-id", "artifact-url", "artifact-digest"])
    assert.equal(action.outputs[name].value, `${"${{"} steps.upload.outputs.${name} }}`);
  const cleanup = action.runs.steps.at(-1);
  assert.equal(cleanup.if, "always() && steps.prepare.outputs.capture_path != ''");
  const cleaned = shell(cleanup.run, { ...env, EVIDENCE_CAPTURE_PATH: payload }, f.root);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.deepEqual(readdirSync(f.runner), []);
  const sentinel = join(f.root, "should-not-exist");
  const invalid = shell(prepare.run, { ...env, EVIDENCE_BUNDLE: `$(touch ${sentinel})` }, f.root);
  assert.notEqual(invalid.status, 0);
  assert.equal(existsSync(sentinel), false);
});

test("packaged prune Action previews by default and applies only explicit true", (t) => {
  const action = document("actions/prune/action.yml");
  assert.equal(action.inputs.apply.default, "false");
  const f = runnerFixture(t);
  const step = action.runs.steps.at(-1);
  const env = {
    ...f.env,
    EVIDENCE_ACTION_ROOT: join(root, "actions/prune"),
    EVIDENCE_CONFIG: f.configPath,
    GITHUB_EVENT_NAME: "schedule",
  };
  const preview = shell(step.run, { ...env, EVIDENCE_APPLY: "false" }, f.root);
  assert.equal(preview.status, 0, preview.stderr);
  assert.ok(f.readCalls().every((call) => !call.args.includes("DELETE")));
  const applied = shell(step.run, { ...env, EVIDENCE_APPLY: "true" }, f.root);
  assert.equal(applied.status, 0, applied.stderr);
  assert.ok(f.readCalls().some((call) => call.args.includes("DELETE")));
  const before = f.readCalls().length;
  assert.notEqual(shell(step.run, { ...env, EVIDENCE_APPLY: "invalid" }, f.root).status, 0);
  assert.equal(f.readCalls().length, before);
  assert.notEqual(
    shell(step.run, { ...env, EVIDENCE_APPLY: "true", GITHUB_REF: "refs/heads/feature" }, f.root)
      .status,
    0,
  );
  assert.equal(f.readCalls().length, before);
});

test("copyable and own workflows preserve protected publisher context and least privileges", () => {
  for (const path of [
    "examples/publish-review-evidence.yml",
    ".github/workflows/publish-review-evidence.yml",
  ]) {
    const d = document(path);
    assert.deepEqual(Object.keys(d.on), ["workflow_dispatch"]);
    assert.equal(d["run-name"], "Publish review evidence ${{ inputs.bundle_id }}");
    assert.deepEqual(d.permissions, { contents: "read" });
    assert.equal(d.concurrency["cancel-in-progress"], false);
    const job = d.jobs.publish;
    assert.equal(job.if, "github.ref == 'refs/heads/main'");
    const checkout = job.steps[0];
    assert.equal(checkout.with.ref, "${{ github.sha }}");
    assert.equal(checkout.with["persist-credentials"], false);
    assert.equal(job.steps.at(-1).with.bundle_id, "${{ inputs.bundle_id }}");
  }
  for (const path of [
    "examples/prune-review-evidence.yml",
    ".github/workflows/prune-review-evidence.yml",
  ]) {
    const d = document(path);
    assert.deepEqual(d.permissions, {
      contents: "write",
      actions: "write",
      "pull-requests": "read",
    });
    assert.equal(d.jobs.prune.if, "github.ref == 'refs/heads/main'");
    assert.equal(d.jobs.prune.steps.at(-1).with.apply, "true");
  }
  const ci = document(".github/workflows/test.yml");
  assert.deepEqual(ci.jobs.test.strategy.matrix.os, ["ubuntu-latest", "macos-latest"]);
  assert.deepEqual(ci.jobs.test.strategy.matrix.node, ["22", "24"]);
});
