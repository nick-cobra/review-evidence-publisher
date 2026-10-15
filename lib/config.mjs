const fields = new Set([
  "repository",
  "workflow",
  "branch",
  "visibility",
  "transferTag",
  "transferMarker",
  "cacheNamespace",
]);

export function normaliseConfig(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error("publisher configuration must be a trusted object");
  for (const [name, value] of Object.entries(input)) {
    if (!fields.has(name)) throw new Error(`unknown publisher configuration field: ${name}`);
    if (value === null || (typeof value === "string" && /[\u0000-\u001f\u007f]/.test(value)))
      throw new Error(`invalid publisher configuration field: ${name}`);
  }
  const { repository } = input;
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
    [".", ".."].includes(repository.split("/")[1])
  )
    throw new Error("repository must be a GitHub.com owner/name");
  const config = {
    repository,
    workflow: input.workflow ?? ".github/workflows/publish-review-evidence.yml",
    branch: input.branch ?? "main",
    visibility: input.visibility ?? "private",
    transferTag: input.transferTag ?? "review-evidence-transfer",
    transferMarker: input.transferMarker ?? "<!-- review-evidence-publisher-transfer:v1 -->",
    cacheNamespace: input.cacheNamespace ?? `review-evidence-publisher/${repository}`,
  };
  if (
    typeof config.workflow !== "string" ||
    !/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.ya?ml$/.test(config.workflow)
  )
    throw new Error("workflow must be one .github/workflows YAML file");
  if (
    typeof config.branch !== "string" ||
    config.branch.length > 240 ||
    config.branch.includes("..") ||
    !config.branch
      .split("/")
      .every(
        (part) =>
          /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) &&
          !part.endsWith(".") &&
          !part.endsWith(".lock"),
      )
  )
    throw new Error("branch must be a safe default-branch name");
  if (!["private", "public"].includes(config.visibility))
    throw new Error("visibility must be private or explicitly public");
  if (
    typeof config.transferTag !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(config.transferTag)
  )
    throw new Error("invalid transfer tag");
  if (
    typeof config.transferMarker !== "string" ||
    config.transferMarker.length > 512 ||
    !/^<!--[A-Za-z0-9_: ./-]+-->$/.test(config.transferMarker)
  )
    throw new Error("invalid transfer marker");
  if (
    typeof config.cacheNamespace !== "string" ||
    config.cacheNamespace.length > 240 ||
    !config.cacheNamespace
      .split("/")
      .every((part) => /^[A-Za-z0-9_.-]{1,100}$/.test(part) && ![".", ".."].includes(part))
  )
    throw new Error("cache namespace must stay below the user cache directory");
  return Object.freeze(config);
}

export const githubEnvironment = () => ({ ...process.env, GH_HOST: "github.com" });
export const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
