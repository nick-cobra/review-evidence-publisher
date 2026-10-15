export const isHexHash = (value, length) =>
  typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value);
export const isArchiveDigest = (value) =>
  typeof value === "string" && value.startsWith("sha256:") && isHexHash(value.slice(7), 64);
