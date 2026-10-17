#!/usr/bin/env node
// Standalone release exporter/verifier. Uses Node built-ins only; never loads archived code.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const FILES = [
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
const MANIFEST = "runtime-manifest.json";
const MAX_FILE = 256 * 1024;
const MAX_ARCHIVE = 2 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const serialise = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const fail = (message) => {
  throw new Error(`runtime: ${message}`);
};
const mode = (name) => (name.startsWith("bin/") ? 0o755 : 0o644);
const isHash = (value, length) =>
  typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value);
const isVersion = (value) =>
  typeof value === "string" && value === value.trim() && /^\d+\.\d+\.\d+$/.test(value);

function regularBytes(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > limit) fail("expected a bounded regular file");
    const data = Buffer.alloc(limit + 1);
    let size = 0;
    for (let count; size < data.length; size += count) {
      count = readSync(fd, data, size, data.length - size, null);
      if (!count) break;
    }
    const after = fstatSync(fd);
    if (
      size !== before.size ||
      size > limit ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      fail("file changed or exceeded its bound");
    return data.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

// Deliberately narrow POSIX ustar: short fixed names, regular files, no extensions or links.
function makeTar(entries) {
  const chunks = [];
  for (const [name, data] of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "ascii");
    const octal = (value, offset, width) =>
      header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, width, "ascii");
    octal(mode(name), 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(data.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.write(
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
      8,
      "ascii",
    );
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

function readTar(archive) {
  if (archive.length < 1024 || archive.length % 512) fail("invalid runtime archive length");
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (archive.length - offset < 1024 || !archive.subarray(offset).every((byte) => byte === 0))
        fail("invalid runtime archive terminator");
      return entries;
    }
    const text = (start, width) =>
      header
        .subarray(start, start + width)
        .toString("utf8")
        .split("\0")[0];
    const octal = (start, width) => {
      const raw = header.subarray(start, start + width).toString("ascii");
      if (!/^[0-7]+[\0 ]*$/.test(raw)) fail("invalid runtime archive numeric field");
      return parseInt(raw, 8);
    };
    const checksum = Buffer.from(header);
    checksum.fill(32, 148, 156);
    if (octal(148, 8) !== checksum.reduce((sum, byte) => sum + byte, 0))
      fail("runtime archive header checksum mismatch");
    const name = text(0, 100);
    if (
      text(257, 6) !== "ustar" ||
      text(263, 2) !== "00" ||
      text(345, 155) ||
      text(157, 100) ||
      header[156] !== 48 ||
      ![MANIFEST, ...FILES].includes(name) ||
      entries.has(name) ||
      octal(100, 8) !== mode(name)
    )
      fail("unsafe, duplicate or unexpected runtime archive entry");
    const size = octal(124, 12);
    const end = offset + 512 + size;
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (
      size < 1 ||
      size > MAX_FILE ||
      next > archive.length ||
      !archive.subarray(end, next).every((byte) => byte === 0)
    )
      fail("invalid or oversized runtime archive entry");
    entries.set(name, archive.subarray(offset + 512, end));
    offset = next;
  }
  fail("missing runtime archive terminator");
}

export function exportRuntime({ sourceRoot = process.cwd(), outputDirectory } = {}) {
  if (!outputDirectory) fail("export requires an output directory");
  const git = (args) =>
    execFileSync("git", args, { cwd: sourceRoot, timeout: 30000, maxBuffer: MAX_FILE + 1 });
  const sourceSha = git(["rev-parse", "--verify", "HEAD"]).toString().trim();
  if (!isHash(sourceSha, 40)) fail("invalid runtime source commit");
  const entries = new Map();
  for (const path of FILES) {
    const tree = git(["ls-tree", sourceSha, "--", path]).toString().trim();
    if (
      !new RegExp(`^100(?:644|755) blob [a-f0-9]{40}\\t${path.replaceAll(".", "\\.")}$`).test(tree)
    )
      fail(`expected a regular committed runtime file: ${path}`);
    const bytes = git(["cat-file", "blob", `${sourceSha}:${path}`]);
    if (!bytes.length || bytes.length > MAX_FILE) fail("oversized runtime source file");
    entries.set(path, bytes);
  }
  const metadata = JSON.parse(entries.get("package.json"));
  if (
    metadata.name !== "review-evidence-publisher" ||
    !isVersion(metadata.version) ||
    Object.keys(metadata.dependencies ?? {}).length
  )
    fail("unexpected runtime package identity/dependencies");
  const manifest = {
    schemaVersion: 1,
    package: metadata.name,
    version: metadata.version,
    sourceSha,
    files: [...entries].map(([path, data]) => ({ path, bytes: data.length, sha256: hash(data) })),
  };
  const manifestBytes = serialise(manifest);
  const archive = makeTar([[MANIFEST, manifestBytes], ...entries]);
  if (archive.length > MAX_ARCHIVE) fail("runtime archive exceeds its bound");
  const name = `review-evidence-publisher-v${metadata.version}-runtime`;
  const output = resolve(outputDirectory);
  mkdirSync(output, { mode: 0o700 });
  try {
    writeFileSync(join(output, `${name}.tar`), archive, { flag: "wx", mode: 0o644 });
    writeFileSync(join(output, `${name}.tar.sha256`), `${hash(archive)}  ${name}.tar\n`, {
      flag: "wx",
      mode: 0o644,
    });
    writeFileSync(join(output, `${name}.manifest.json`), manifestBytes, {
      flag: "wx",
      mode: 0o644,
    });
    writeFileSync(join(output, "verify-runtime.mjs"), entries.get("bin/runtime.mjs"), {
      flag: "wx",
      mode: 0o644,
    });
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
  return {
    archive: join(output, `${name}.tar`),
    sha256: hash(archive),
    manifestSha256: hash(manifestBytes),
    verifierSha256: hash(entries.get("bin/runtime.mjs")),
    sourceSha,
    version: metadata.version,
    manifest,
  };
}

export function verifyRuntime({
  archivePath,
  expectedSha256,
  expectedSourceSha,
  expectedVersion,
  outputDirectory,
} = {}) {
  if (
    !archivePath ||
    !isHash(expectedSha256, 64) ||
    !isHash(expectedSourceSha, 40) ||
    !isVersion(expectedVersion)
  )
    fail("verification requires independently pinned archive SHA-256, source SHA and version");
  const archive = regularBytes(archivePath, MAX_ARCHIVE);
  if (hash(archive) !== expectedSha256) fail("runtime archive SHA-256 mismatch");
  const entries = readTar(archive);
  if (entries.size !== FILES.length + 1 || !entries.has(MANIFEST))
    fail("incomplete runtime inventory");
  let manifest;
  try {
    manifest = JSON.parse(entries.get(MANIFEST));
  } catch {
    fail("invalid runtime manifest JSON");
  }
  if (
    !serialise(manifest).equals(entries.get(MANIFEST)) ||
    JSON.stringify(Object.keys(manifest)) !==
      JSON.stringify(["schemaVersion", "package", "version", "sourceSha", "files"]) ||
    manifest.schemaVersion !== 1 ||
    manifest.package !== "review-evidence-publisher" ||
    manifest.sourceSha !== expectedSourceSha ||
    manifest.version !== expectedVersion ||
    !Array.isArray(manifest.files) ||
    JSON.stringify(manifest.files.map((file) => file?.path)) !== JSON.stringify(FILES)
  )
    fail("runtime manifest identity/inventory mismatch");
  for (const file of manifest.files) {
    const bytes = entries.get(file.path);
    if (!bytes || file.bytes !== bytes.length || file.sha256 !== hash(bytes))
      fail(`runtime file digest mismatch: ${file.path}`);
  }
  const metadata = JSON.parse(entries.get("package.json"));
  if (
    metadata.name !== manifest.package ||
    metadata.version !== expectedVersion ||
    Object.keys(metadata.dependencies ?? {}).length
  )
    fail("runtime package metadata mismatch");
  // No archived code is imported. Validate every byte before creating an exclusive output root.
  if (outputDirectory) {
    const output = resolve(outputDirectory);
    mkdirSync(output, { mode: 0o700 });
    try {
      for (const [path, bytes] of entries) {
        mkdirSync(dirname(join(output, path)), { recursive: true, mode: 0o755 });
        writeFileSync(join(output, path), bytes, { flag: "wx", mode: mode(path) });
      }
    } catch (error) {
      rmSync(output, { recursive: true, force: true });
      throw error;
    }
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (!command || command === "--help") {
      console.log(
        "Runtime distribution (Node.js 22+, no npm install):\nExport: node runtime.mjs export --source <checkout> --output <new-directory>\nVerify/extract: node verify-runtime.mjs verify --archive <runtime.tar> --sha256 <pinned-sha256> --source-sha <pinned-commit> --version <version> [--output <new-directory>]",
      );
    } else {
      const { values } = parseArgs({
        args,
        options: Object.fromEntries(
          ["source", "output", "archive", "sha256", "source-sha", "version"].map((key) => [
            key,
            { type: "string" },
          ]),
        ),
      });
      const allowed =
        command === "export"
          ? ["source", "output"]
          : command === "verify"
            ? ["output", "archive", "sha256", "source-sha", "version"]
            : [];
      if (!allowed.length || Object.keys(values).some((key) => !allowed.includes(key)))
        fail("select export or verify with its supported arguments");
      console.log(
        JSON.stringify(
          command === "export"
            ? exportRuntime({ sourceRoot: values.source, outputDirectory: values.output })
            : verifyRuntime({
                archivePath: values.archive,
                expectedSha256: values.sha256,
                expectedSourceSha: values["source-sha"],
                expectedVersion: values.version,
                outputDirectory: values.output,
              }),
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
