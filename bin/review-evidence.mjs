#!/usr/bin/env node
import { runEvidenceCli } from "../index.mjs";
try {
  await runEvidenceCli();
} catch (error) {
  console.error(`Evidence: ${error.message}`);
  process.exitCode = 1;
}
