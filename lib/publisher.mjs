import { normaliseConfig } from "./config.mjs";
import { createArtifactTools } from "./artifacts.mjs";
import { createPublicationTools } from "./publication.mjs";
export function createEvidencePublisher(input) {
  const config = normaliseConfig(input);
  const artifacts = createArtifactTools(config);
  return Object.freeze({ config, ...artifacts, ...createPublicationTools(config, artifacts) });
}
