import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const VERIFY_SHA = "a".repeat(40);
export function evidenceFixture(artifacts, t) {
  const root = mkdtempSync(join(tmpdir(), "review-evidence-verify-"));
  t?.after(() => rmSync(root, { recursive: true, force: true }));
  const payload = join(root, "payload");
  mkdirSync(join(payload, "android"), { recursive: true });
  const png = Buffer.from("verified-png-bytes");
  writeFileSync(join(payload, "android/home.png"), png);
  const document = Buffer.from('{"journey":"installed","sourceSha":"' + VERIFY_SHA + '"}');
  writeFileSync(join(payload, "journey.json"), document);
  const files = [
    { path: "android/home.png", bytes: png.length, sha256: artifacts.sha256(png) },
    { path: "journey.json", bytes: document.length, sha256: artifacts.sha256(document) },
  ];
  const content = {
    version: 1,
    repository: artifacts.EVIDENCE_REPOSITORY,
    sourceSha: VERIFY_SHA,
    issue: 1,
    createdAt: "2026-10-11T11:00:00.000Z",
    files,
  };
  const manifest = { ...content, bundleId: artifacts.sha256(JSON.stringify(content)) };
  writeFileSync(join(payload, "evidence-manifest.json"), JSON.stringify(manifest));
  const zip = join(root, "evidence.zip");
  execFileSync("zip", ["-q", "-r", zip, "."], { cwd: payload });
  const archive = readFileSync(zip);
  const run = {
    id: 123,
    repository: { full_name: artifacts.EVIDENCE_REPOSITORY },
    head_repository: { full_name: artifacts.EVIDENCE_REPOSITORY },
    event: "workflow_dispatch",
    head_branch: artifacts.config?.branch ?? "main",
    path: artifacts.EVIDENCE_WORKFLOW,
    status: "completed",
    conclusion: "success",
  };
  const artifact = {
    id: 456,
    name: `${artifacts.EVIDENCE_PREFIX}${manifest.bundleId}`,
    workflow_run: { id: 123 },
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    size_in_bytes: archive.length,
    digest: `sha256:${artifacts.sha256(archive)}`,
  };
  const ghJson = (args) => {
    const endpoint = args.at(-1);
    if (endpoint.endsWith("/artifacts/456")) return artifact;
    if (endpoint.endsWith("/runs/123")) return run;
    throw new Error(`unexpected GH boundary: ${endpoint}`);
  };
  const proof = {
    runId: 123,
    artifactId: 456,
    digest: artifacts.sha256(archive),
    sourceSha: VERIFY_SHA,
    files,
  };
  return { archive, artifact, run, ghJson, proof, manifest, record: { artifact: proof } };
}
