# API and configuration

```js
import { readFileSync } from "node:fs";
import { createEvidencePublisher } from "review-evidence-publisher";

const config = JSON.parse(readFileSync("review-evidence.config.json", "utf8"));
const publisher = createEvidencePublisher(config);
const result = await publisher.publishEvidence({
  issue: 42,
  directory: process.argv[2],
});
console.log(result.artifact.url);
```

Use a trusted config from your repository, separate from selected capture content. Construction validates and copies it; `publisher.config` is frozen. Each instance owns its archive cache and process-local staged-proof authentication. Share one instance among consumers that exchange authenticated stages.

## Configuration

| Field            | Default                                          | Meaning                                                   |
| ---------------- | ------------------------------------------------ | --------------------------------------------------------- |
| `repository`     | Required                                         | Exact GitHub.com `owner/name`                             |
| `workflow`       | `.github/workflows/publish-review-evidence.yml`  | Publisher path under `.github/workflows/`                 |
| `branch`         | `main`                                           | Protected default branch used for dispatch and provenance |
| `visibility`     | `private`                                        | `private` or explicitly `public`; must match GitHub       |
| `transferTag`    | `review-evidence-transfer`                       | Dedicated operational prerelease/tag                      |
| `transferMarker` | `<!-- review-evidence-publisher-transfer:v1 -->` | Exact dedicated release body identifying that container   |
| `cacheNamespace` | `review-evidence-publisher/<owner>/<name>`       | Relative namespace below the user's `.cache` directory    |

Unknown fields are refused. Repository/workflow/branch/tag/cache names must be safe path/ref names; branch components use letters, numbers, `_`, `-`, `.` and optional `/` separators, without traversal, trailing dots or `.lock`. The transfer marker is one bounded HTML comment. GitHub.com is the fixed host for default `gh` executors, independently of inherited `GH_HOST`. GitHub Enterprise and Windows are outside the supported scope.

For a separate branch/workflow:

```json
{
  "repository": "your-org/your-repository",
  "branch": "trunk",
  "workflow": ".github/workflows/publish-captures.yaml",
  "visibility": "private"
}
```

Set the workflow branch guard to `trunk` and save it under that exact filename. Keep `run-name: Publish review evidence ${{ inputs.bundle_id }}` and the `bundle_id` dispatch input: recovery locates that run identity.

## Verify a received record

The CLI result is `{ artifact, manifest }`. The caller supplies the expected source commit independently of that received record:

```js
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createEvidencePublisher } from "review-evidence-publisher";

const publisher = createEvidencePublisher(
  JSON.parse(readFileSync("review-evidence.config.json", "utf8")),
);
const received = JSON.parse(readFileSync(process.argv[2], "utf8"));
const expectedSourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const verified = publisher.verifyArtifactRecord({
  artifact: { ...received.artifact, sourceSha: expectedSourceSha },
});
console.log(verified.manifest.bundleId);
```

Live proof requires positive safe integer `runId`/`artifactId`, a full lowercase expected `sourceSha`, a lowercase 64-character archive `digest`, and `files: [{ path, sha256 }]`. The complete archive is verified even if only some files are asserted. A record without an artifact returns `null`; callers must not treat that as verified evidence.

Use `stageDirectory` to obtain a private, read-only snapshot:

```js
const verified = publisher.verifyArtifactRecord(record, {
  stageDirectory: ownedTemporaryDirectory,
});
try {
  publisher.assertAuthenticatedEvidenceStage(verified.localEvidence);
  // Read verified.localEvidence.files[].localPath with your review tools.
} finally {
  publisher.removeStagedEvidence(verified.localEvidence.root);
}
```

Pass only the staging root returned by this instance to cleanup. Authentication is process-local and refuses forged, mutated or other-instance stage objects. It is comparison data, never executable authority. Retention verification never creates an authenticated stage and cannot turn an unsuccessful run into live proof.

## Methods

| Method                                                                   | Contract                                                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `publishEvidence({ directory, issue, cwd?, spoolRoot?, resume?, log? })` | Async clean/pushed snapshot, transfer, dispatch/reconciliation, full verified readback; returns `{artifact, manifest}`    |
| `snapshotEvidence(directory, { sourceSha, issue, createdAt? })`          | Bounded selected regular files; returns `{manifest, bytes: Map}`                                                          |
| `validateManifest(manifest)`                                             | Validate v1 identity, bounds and bundle hash                                                                              |
| `readEvidenceArchive(buffer, { sourceSha?, bundleId? }?)`                | Complete bounded ZIP/manifest/file verification; optional caller identity assertions                                      |
| `verifyArtifactRecord({artifact}, {stageDirectory?}?)`                   | Strict successful publisher provenance and full archive/source verification                                               |
| `assertAuthenticatedEvidenceStage(stage)`                                | Check unchanged same-instance process-local authentication                                                                |
| `removeStagedEvidence(root)`                                             | Remove the returned owned staging root, including read-only modes                                                         |
| `evidenceSpoolRoot()`                                                    | Configured user-cache namespace                                                                                           |
| `discardSpoolBundle(root, bundleId)`                                     | Retire one ownership-validated local recovery bundle                                                                      |
| `prepareEvidenceUpload(bundleId, {output})`                              | Validate a transfer into an owned runner output; CLI adds repository/ref/workflow/event checks                            |
| `verifyRetentionArtifactRecord(artifact, run, options?)`                 | Verify a completed publisher archive/source; returns `{artifact, manifest, bytes: Map}` without live-stage authentication |
| `pruneEvidenceArtifacts({apply?, now?, shouldRetain?}?)`                 | Preview/apply reference-aware verified artifact cleanup, with an optional synchronous retention veto                      |
| `pruneEvidenceTransfers({apply?, now?}?)`                                | Preview/apply dedicated-container transfer cleanup                                                                        |

Advanced compatibility exports include `readSpoolBundle`, `stageEvidenceBundle`, `removeTransferBundle`, `referencedArtifacts`, `retentionCandidates`, `verifyArtifactProvenance`, `verifyRetentionArtifactRecord`, `safeEvidencePath`, `sha256`, `githubJson`, archive timeout/cache helpers and fixed protocol constants. They do not implement Markdown review records, human approval or merge policy.

### Verified retention veto

A trusted caller may pass `shouldRetain({artifact, run, manifest, bytes, now})`
to `pruneEvidenceArtifacts`. The callback runs only for otherwise eligible
artefacts, after complete archive, file-hash, publisher and source verification.
`bytes` contains every verified payload file as a `Map<relativePath, Buffer>`;
the manifest file itself is separate. Metadata and payload bytes are isolated
copies, so mutating the callback context cannot change the internal deletion
target or verified state.

Return literal `true` to retain the artefact, or literal `false` to continue
through the existing final artefact/run/reference checks. A retained item is
omitted from the returned deletion list in both dry-run and apply. Omitting
the option preserves the ordinary 30-day/reference policy. The callback cannot
make a younger, referenced or unverified artefact eligible for deletion.

A supplied option must be a function. Callback errors propagate; non-boolean
results, including Promises and thenables, throw synchronously before that
item's DELETE. Async decisions are not awaited or accepted. Earlier successful
deletions are not rolled back when a later item fails. Retention verification
does not stage files or authenticate successful live proof, including when a
completed unsuccessful publisher run is eligible for ordinary deletion.

The generic CLI and bundled Actions keep their default behaviour. A project
adapter can supply its policy through the existing publisher injection seam;
capture data and JSON configuration cannot select executable callbacks.

Trusted transport hooks (`ghJson`, `ghRun`, `download`, `downloadTransfer`) support deterministic tests; publication also accepts `delay`/`maxPolls`. Hooks are caller code, never capture data. Default commands have bounded reads/timeouts. Recognised REST metadata GETs retry timeouts and HTTP 502/503/504 within three attempts and 90 seconds, including 250/500 ms backoff. `githubJson(args, {exec?, attempts?, now?, sleep?})` accepts a lower attempt limit of 1–3 and inert transport/clock hooks for tests. Parsing/validation failures and mutation/unrecognised commands are never retried. Archive downloads retain their existing timeout-only retry policy. See [operation limits](operation.md#transient-github-reads).
