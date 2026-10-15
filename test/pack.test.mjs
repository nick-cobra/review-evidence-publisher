import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerFixture } from "./runner-fixture.mjs";

test("packed zero-dependency runtime installs offline and runs in an independent consumer", (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-pack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const npmConfig = join(root, "npmrc");
  writeFileSync(npmConfig, "");
  const env = {
    PATH: process.env.PATH,
    npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: npmConfig,
    npm_config_globalconfig: join(root, "global-npmrc"),
    npm_config_update_notifier: "false",
  };
  writeFileSync(env.npm_config_globalconfig, "");
  const source = fileURLToPath(new URL("../", import.meta.url));
  const [pack] = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], {
      cwd: source,
      encoding: "utf8",
      timeout: 30000,
      env,
    }),
  );
  const paths = pack.files.map((file) => file.path);
  for (const path of [
    "index.mjs",
    "bin/review-evidence.mjs",
    "lib/config.mjs",
    "lib/artifacts.mjs",
    "lib/publication.mjs",
    "lib/publisher.mjs",
    "lib/cli.mjs",
    "action.yml",
    "actions/prune/action.yml",
    "README.md",
    "LICENSE",
    "docs/api.md",
    "examples/publish-review-evidence.yml",
  ])
    assert.ok(paths.includes(path), path);
  assert.ok(
    paths.every(
      (path) =>
        !path.startsWith("test/") &&
        !path.startsWith("node_modules/") &&
        !path.startsWith(".github/") &&
        !path.includes(".ui-evidence"),
    ),
  );
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(root, pack.filename),
    ],
    { cwd: consumer, encoding: "utf8", timeout: 30000, env },
  );
  const installed = join(consumer, "node_modules/review-evidence-publisher");
  const metadata = JSON.parse(readFileSync(join(installed, "package.json")));
  assert.deepEqual(metadata.dependencies ?? {}, {});
  const data = join(consumer, "captures");
  mkdirSync(data);
  writeFileSync(join(data, "report.json"), '{"result":"passed"}');
  const script = `import {createEvidencePublisher} from 'review-evidence-publisher'; const p=createEvidencePublisher({repository:'other-org/separate-app',branch:'trunk',workflow:'.github/workflows/captures.yaml'}); console.log(JSON.stringify(p.snapshotEvidence(${JSON.stringify(data)},{sourceSha:'c'.repeat(40),issue:42}).manifest));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: consumer,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout);
  assert.equal(manifest.repository, "other-org/separate-app");
  assert.equal(manifest.sourceSha, "c".repeat(40));
  assert.equal(manifest.files[0].path, "report.json");
  const linked = spawnSync(join(consumer, "node_modules/.bin/review-evidence"), ["--help"], {
    cwd: consumer,
    encoding: "utf8",
  });
  assert.equal(linked.status, 0, linked.stderr);
  assert.match(linked.stdout, /Usage/);
  const bin = join(installed, "bin/review-evidence.mjs");
  const f = runnerFixture(t, { branch: "trunk", workflow: ".github/workflows/captures.yaml" }, bin);
  const prepared = f.execute(["--prepare", f.manifest.bundleId]);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(
    JSON.parse(readFileSync(join(prepared.stdout.trim(), "evidence-manifest.json"))).bundleId,
    f.manifest.bundleId,
  );
  assert.equal(f.execute(["--cleanup", prepared.stdout.trim()]).status, 0);
});
