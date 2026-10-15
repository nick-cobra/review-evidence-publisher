import { lstatSync, mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { createEvidencePublisher } from "./publisher.mjs";

function publisherContext(config) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== config.repository ||
    process.env.GITHUB_REF !== `refs/heads/${config.branch}` ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_WORKFLOW_REF !==
      `${config.repository}/${config.workflow}@refs/heads/${config.branch}` ||
    !process.env.RUNNER_TEMP
  )
    throw new Error("runner operation requires the configured default-branch publisher context");
}

export async function runEvidenceCli(argv = process.argv.slice(2), { publisher } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      issue: { type: "string" },
      dir: { type: "string" },
      resume: { type: "string" },
      discard: { type: "string" },
      prepare: { type: "string" },
      cleanup: { type: "string" },
      prune: { type: "boolean" },
      apply: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const operations = ["resume", "discard", "prepare", "cleanup", "prune", "help"].filter(
    (key) => values[key] !== undefined,
  );
  if (operations.length > 1) throw new Error("select one evidence operation");
  const mode = operations[0] ?? "publish";
  const allowed = {
    publish: ["issue", "dir"],
    resume: ["resume"],
    discard: ["discard"],
    prepare: ["prepare"],
    cleanup: ["cleanup"],
    prune: ["prune", "apply"],
    help: ["help"],
  }[mode];
  for (const key of Object.keys(values))
    if (key !== "config" && !allowed.includes(key))
      throw new Error(`unexpected --${key} for ${mode}`);
  if (mode === "help") {
    console.log(
      "Usage: review-evidence [--config <trusted.json>] --issue <number> --dir <captures>\nRecovery: --resume <bundle> | --discard <bundle>\nRetention: --prune [--apply]\nRunner: --prepare <bundle> | --cleanup <payload-path>",
    );
    return;
  }
  if (
    mode === "publish" &&
    (!/^[1-9][0-9]*$/.test(values.issue ?? "") ||
      !Number.isSafeInteger(Number(values.issue)) ||
      !values.dir)
  )
    throw new Error("provide --issue and --dir, or one --resume bundle");
  if (publisher && values.config)
    throw new Error("--config cannot override a fixed publisher instance");
  publisher ??= createEvidencePublisher(
    JSON.parse(readFileSync(values.config ?? "review-evidence.config.json", "utf8")),
  );
  const { config } = publisher;
  if (mode === "prepare") {
    publisherContext(config);
    const scratch = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), "review-evidence-"));
    const output = join(scratch, "payload");
    try {
      publisher.prepareEvidenceUpload(values.prepare, { output });
    } catch (error) {
      rmSync(scratch, { recursive: true });
      throw error;
    }
    console.log(output);
  } else if (mode === "cleanup") {
    publisherContext(config);
    const root = realpathSync(process.env.RUNNER_TEMP);
    const target = dirname(values.cleanup);
    if (
      basename(values.cleanup) !== "payload" ||
      dirname(target) !== root ||
      !/^review-evidence-[A-Za-z0-9]+$/.test(basename(target)) ||
      lstatSync(target).isSymbolicLink() ||
      realpathSync(target) !== target ||
      lstatSync(target).uid !== process.getuid()
    )
      throw new Error("unsafe runner scratch cleanup");
    rmSync(target, { recursive: true });
  } else if (mode === "discard") {
    publisher.discardSpoolBundle(publisher.evidenceSpoolRoot(), values.discard);
    console.log("Discarded the validated local bundle.");
  } else if (mode === "prune") {
    if (
      process.env.GITHUB_ACTIONS === "true" &&
      (process.env.GITHUB_REPOSITORY !== config.repository ||
        process.env.GITHUB_REF !== `refs/heads/${config.branch}` ||
        !["schedule", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME))
    )
      throw new Error("retention requires the configured default-branch repository context");
    console.log(
      JSON.stringify(
        {
          artifacts: publisher.pruneEvidenceArtifacts({ apply: values.apply }),
          transfers: publisher.pruneEvidenceTransfers({ apply: values.apply }),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      JSON.stringify(
        await publisher.publishEvidence({
          directory: values.dir,
          issue: values.issue,
          resume: values.resume,
          log: (line) => console.error(line),
        }),
        null,
        2,
      ),
    );
  }
}
