import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exportRuntime, verifyRuntime } from "../bin/runtime.mjs";

const source = fileURLToPath(new URL("../", import.meta.url));
const files = [
  "LICENSE",
  "README.md",
  "bin/review-evidence.mjs",
  "bin/runtime.mjs",
  "index.mjs",
  "lib/artifacts.mjs",
  "lib/cli.mjs",
  "lib/config.mjs",
  "lib/identity.mjs",
  "lib/publication.mjs",
  "lib/publisher.mjs",
  "package.json",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "review-runtime-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  for (const file of files) {
    mkdirSync(dirname(join(checkout, file)), { recursive: true });
    cpSync(join(source, file), join(checkout, file));
  }
  const git = (args) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: checkout,
      encoding: "utf8",
    }).trim();
  git(["init", "--quiet"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "runtime fixture",
  ]);
  const result = exportRuntime({ sourceRoot: checkout, outputDirectory: join(root, "release") });
  const options = {
    archivePath: result.archive,
    expectedSha256: result.sha256,
    expectedSourceSha: git(["rev-parse", "HEAD"]),
    expectedVersion: JSON.parse(readFileSync(join(checkout, "package.json"))).version,
  };
  return { root, checkout, git, result, options };
}

test("official runtime export is reproducible and works in a clean no-install consumer", (t) => {
  const f = fixture(t);
  const second = exportRuntime({ sourceRoot: f.checkout, outputDirectory: join(f.root, "second") });
  assert.deepEqual(readFileSync(second.archive), readFileSync(f.result.archive));
  const listed = execFileSync("tar", ["-tf", f.result.archive], { encoding: "utf8" })
    .trim()
    .split("\n");
  assert.deepEqual(listed, ["runtime-manifest.json", ...files]);
  const outputDirectory = join(f.root, "consumer");
  const manifest = verifyRuntime({ ...f.options, outputDirectory });
  assert.equal(manifest.sourceSha, f.options.expectedSourceSha);
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    files,
  );
  for (const file of files)
    assert.deepEqual(
      readFileSync(join(outputDirectory, file)),
      readFileSync(join(f.checkout, file)),
    );
  assert.equal(existsSync(join(outputDirectory, "node_modules")), false);
  const captures = join(f.root, "captures");
  mkdirSync(captures);
  writeFileSync(join(captures, "report.json"), '{"result":"passed"}');
  const script = `import {createEvidencePublisher} from ${JSON.stringify(pathToFileURL(join(outputDirectory, "index.mjs")).href)}; const p=createEvidencePublisher({repository:'example/consumer'}); console.log(JSON.stringify(p.snapshotEvidence(${JSON.stringify(captures)},{sourceSha:'c'.repeat(40),issue:42}).manifest));`;
  const env = { PATH: dirname(process.execPath), HOME: f.root };
  const consumer = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: outputDirectory,
    env,
    encoding: "utf8",
  });
  assert.equal(consumer.status, 0, consumer.stderr);
  assert.equal(JSON.parse(consumer.stdout).repository, "example/consumer");
  const cli = spawnSync(
    process.execPath,
    [join(outputDirectory, "bin/review-evidence.mjs"), "--help"],
    { cwd: outputDirectory, env, encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Usage/);
  const verifier = spawnSync(
    process.execPath,
    [
      join(f.root, "release/verify-runtime.mjs"),
      "verify",
      "--archive",
      f.result.archive,
      "--sha256",
      f.options.expectedSha256,
      "--source-sha",
      f.options.expectedSourceSha,
      "--version",
      f.options.expectedVersion,
      "--output",
      join(f.root, "standalone"),
    ],
    { cwd: f.root, env, encoding: "utf8" },
  );
  assert.equal(verifier.status, 0, verifier.stderr);
  assert.equal(JSON.parse(verifier.stdout).sourceSha, manifest.sourceSha);
});

test("runtime extraction requires independent archive/source/version pins and never overwrites", (t) => {
  const f = fixture(t);
  for (const change of [
    { expectedSha256: "f".repeat(64) },
    { expectedSourceSha: "f".repeat(40) },
    { expectedVersion: "9.9.9" },
    { expectedSha256: undefined },
    { expectedSourceSha: "f".repeat(40) + "\n" },
    { expectedVersion: f.options.expectedVersion + "\n" },
  ]) {
    const outputDirectory = join(f.root, "refused");
    assert.throws(() => verifyRuntime({ ...f.options, ...change, outputDirectory }), /runtime/);
    assert.equal(existsSync(outputDirectory), false);
  }
  const outputDirectory = join(f.root, "existing");
  mkdirSync(outputDirectory);
  writeFileSync(join(outputDirectory, "keep"), "original");
  assert.throws(() => verifyRuntime({ ...f.options, outputDirectory }), /exist/i);
  assert.equal(readFileSync(join(outputDirectory, "keep"), "utf8"), "original");
});

for (const mutation of [
  "traversal",
  "absolute",
  "symlink",
  "hardlink",
  "duplicate",
  "unexpected",
  "missing",
  "modified",
  "manifest",
  "checksum",
  "truncated",
])
  test(`runtime verifier refuses ${mutation} before writing files`, (t) => {
    const f = fixture(t);
    const archivePath = join(f.root, "invalid.tar");
    // An independent standard-library writer changes an otherwise valid distribution.
    const python = `import io,json,tarfile,sys\nsource,target,mutation=sys.argv[1:]\nwith tarfile.open(source) as old:\n entries=[(m,old.extractfile(m).read()) for m in old.getmembers()]\nif mutation=='checksum':\n data=bytearray(open(source,'rb').read());data[0]^=1;open(target,'wb').write(data);sys.exit()\nif mutation=='truncated':\n open(target,'wb').write(open(source,'rb').read()[:-1024]);sys.exit()\nif mutation=='missing': entries.pop()\nif mutation=='duplicate': entries.append(entries[-1])\nif mutation=='unexpected':\n m=tarfile.TarInfo('unexpected.mjs');entries.append((m,b'never execute'))\nif mutation in ('traversal','absolute','symlink','hardlink'):\n m,data=entries[-1];m.name='../escaped' if mutation=='traversal' else '/escaped' if mutation=='absolute' else m.name\n if mutation in ('symlink','hardlink'): m.type=tarfile.SYMTYPE if mutation=='symlink' else tarfile.LNKTYPE;m.linkname='../escaped';data=b''\n entries[-1]=(m,data)\nif mutation=='modified': entries[-1]=(entries[-1][0],b'modified bytes')\nif mutation=='manifest':\n m,data=entries[0];manifest=json.loads(data);manifest['files'][0]['sha256']='f'*64;entries[0]=(m,(json.dumps(manifest,indent=2)+'\\n').encode())\nwith tarfile.open(target,'w',format=tarfile.USTAR_FORMAT) as new:\n for m,data in entries:\n  m.size=len(data);new.addfile(m,io.BytesIO(data))\n`;
    execFileSync("python3", ["-c", python, f.result.archive, archivePath, mutation]);
    const outputDirectory = join(f.root, "refused");
    assert.throws(
      () =>
        verifyRuntime({
          ...f.options,
          archivePath,
          expectedSha256: sha256(readFileSync(archivePath)),
          outputDirectory,
        }),
      /runtime/,
    );
    assert.equal(existsSync(outputDirectory), false);
    assert.equal(existsSync(join(f.root, "escaped")), false);
  });

test("runtime export refuses tracked links and output replacement", (t) => {
  const f = fixture(t);
  assert.throws(
    () => exportRuntime({ sourceRoot: f.checkout, outputDirectory: join(f.root, "release") }),
    /exist/i,
  );
  rmSync(join(f.checkout, "index.mjs"));
  symlinkSync("LICENSE", join(f.checkout, "index.mjs"));
  f.git(["add", "index.mjs"]);
  f.git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "linked source",
  ]);
  assert.throws(
    () => exportRuntime({ sourceRoot: f.checkout, outputDirectory: join(f.root, "bad-release") }),
    /regular.*runtime|runtime.*regular/,
  );
});

test("runtime verification refuses oversized and linked archive inputs without output", (t) => {
  const f = fixture(t);
  const archivePath = join(f.root, "oversized.tar");
  writeFileSync(archivePath, Buffer.alloc(2 * 1024 * 1024 + 1));
  const outputDirectory = join(f.root, "refused");
  assert.throws(() => verifyRuntime({ ...f.options, archivePath, outputDirectory }), /bounded/);
  rmSync(archivePath);
  symlinkSync(f.result.archive, archivePath);
  assert.throws(() => verifyRuntime({ ...f.options, archivePath, outputDirectory }), /ELOOP/);
  assert.equal(existsSync(outputDirectory), false);
});
