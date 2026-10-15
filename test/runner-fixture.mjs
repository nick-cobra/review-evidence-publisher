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

const bin = fileURLToPath(new URL("../bin/review-evidence.mjs", import.meta.url));
export function runnerFixture(t, overrides = {}, binPath = bin) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-cli-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { repository: "example/independent-app", visibility: "public", ...overrides };
  const publisher = createEvidencePublisher(config);
  const archiveFixture = evidenceFixture(publisher, t);
  const { manifest, archive, artifact, run } = archiveFixture;
  const configPath = join(root, "review-evidence.config.json");
  const archivePath = join(root, "transfer.zip");
  const calls = join(root, "gh-calls.jsonl");
  const tools = join(root, "tools");
  const runner = join(root, "runner");
  mkdirSync(tools);
  mkdirSync(runner);
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(archivePath, archive);
  const release = {
    id: 77,
    tag_name: publisher.TRANSFER_TAG,
    body: publisher.TRANSFER_MARKER,
    draft: false,
    prerelease: true,
  };
  const asset = {
    id: 789,
    name: `review-evidence-${manifest.bundleId}.zip`,
    size: archive.length,
    digest: `sha256:${publisher.sha256(archive)}`,
    state: "uploaded",
    created_at: "2026-01-01T00:00:00Z",
  };
  const prefix = `repos/${config.repository}`;
  const script = `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2); const endpoint=args.at(-1);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,host:process.env.GH_HOST})+'\\n');
if(endpoint===${JSON.stringify(prefix)}) console.log(JSON.stringify({private:false}));
else if(endpoint===${JSON.stringify(prefix + "/releases/tags/" + publisher.TRANSFER_TAG)}) console.log(JSON.stringify(${JSON.stringify(release)}));
else if(endpoint.startsWith(${JSON.stringify(prefix + "/releases/77/assets?")})) console.log(JSON.stringify([${JSON.stringify(asset)}]));
else if(endpoint===${JSON.stringify(prefix + "/releases/assets/789")}) { if(args.includes('Accept: application/octet-stream')) process.stdout.write(fs.readFileSync(${JSON.stringify(archivePath)})); else console.log(JSON.stringify(${JSON.stringify(asset)})); }
else if(endpoint===${JSON.stringify(prefix + "/actions/artifacts/456/zip")}) process.stdout.write(fs.readFileSync(${JSON.stringify(archivePath)}));
else if(endpoint===${JSON.stringify(prefix + "/git/commits/" + manifest.sourceSha)}) console.log(JSON.stringify({sha:${JSON.stringify(manifest.sourceSha)}}));
else if(endpoint===${JSON.stringify(prefix + "/actions/artifacts/456")}) console.log(JSON.stringify(${JSON.stringify(artifact)}));
else if(endpoint===${JSON.stringify(prefix + "/actions/runs/123")}) console.log(JSON.stringify(${JSON.stringify(run)}));
else if(endpoint.startsWith(${JSON.stringify(prefix + "/actions/artifacts?")})) console.log(JSON.stringify({artifacts:[]}));
else if(endpoint.startsWith(${JSON.stringify(prefix + "/pulls?")})) console.log('[]');
else { console.error('unexpected fixture endpoint'); process.exitCode=1; }
`;
  writeFileSync(join(tools, "gh"), script);
  chmodSync(join(tools, "gh"), 0o700);
  const branch = config.branch ?? "main";
  const workflow = config.workflow ?? ".github/workflows/publish-review-evidence.yml";
  const env = {
    PATH: `${tools}:${process.env.PATH}`,
    RUNNER_TEMP: runner,
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: config.repository,
    GITHUB_REF: `refs/heads/${branch}`,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: `${config.repository}/${workflow}@refs/heads/${branch}`,
    GH_HOST: "foreign.invalid",
  };
  const execute = (args, changes = {}) =>
    spawnSync(process.execPath, [binPath, "--config", configPath, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, ...changes },
    });
  const readCalls = () =>
    existsSync(calls)
      ? readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s))
      : [];
  return {
    root,
    runner,
    config,
    publisher,
    execute,
    readCalls,
    manifest,
    archive,
    env,
    configPath,
    archiveFixture,
  };
}
