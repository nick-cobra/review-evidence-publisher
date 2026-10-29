# Review Evidence Publisher

Publish locally collected screenshots, recordings and reports for a specific source commit as immutable GitHub Actions artifacts. Verify the workflow origin, archive digest and every file hash; recover an interrupted handoff with the same bundle identity.

Built from [CobraHQ](https://www.cobrahq.app/blog/engineering)'s engineering tooling. Useful when captures are made on a laptop or device host and reviewed on another machine, including coding-agent review workflows.

- Node.js 22+; macOS and Linux. CI covers Node 22/24 on both platforms.
- GitHub.com, with `gh`, `git`, `zip` and `unzip` installed.
- Zero runtime npm dependencies. No capture-supplied commands are executed.

For execution checkouts without `npm install`, use the [verified runtime distribution](docs/runtime-distribution.md). It provides a pinned archive, per-file manifest and standalone verifier without requiring `node_modules`.

## Quick start

Install the versioned GitHub package in an existing repository:

```sh
npm install --save-dev github:nick-cobra/review-evidence-publisher#v0.1.2
```

Create `review-evidence.config.json` using your repository's exact name:

```json
{
  "repository": "your-org/your-repository",
  "visibility": "private"
}
```

For a **public** repository, explicitly set `"visibility": "public"`. The observed visibility must match. Selected files pass through a dedicated GitHub prerelease, so public mode makes them public during that handoff as well as in the final artifact. Select and redact files before publication.

Copy [the publisher workflow](examples/publish-review-evidence.yml) to `.github/workflows/publish-review-evidence.yml` and [the optional cleanup workflow](examples/prune-review-evidence.yml) to `.github/workflows/prune-review-evidence.yml`. Commit and push the installation, config and workflows. The publisher must exist on the default branch before the first handoff.

The examples use `main`. For another default branch or publisher filename, set `branch`/`workflow` in the config and update the workflow's branch guard to match. Keep the documented `run-name` and `bundle_id` input. Pin Actions and dependencies to the release's full source commit for automated consumers.

Use your existing GitHub CLI login with the [required repository permissions](docs/operation.md#permissions). The tool reserves the `review-evidence-transfer` prerelease/tag for transport; account for that operational container in your application's release automation.

Here is a complete small report example. Add final screenshots or recordings from your normal capture tool to the same directory:

```sh
captures="$(mktemp -d)"
printf '%s\n' '{"scenario":"settings-save","result":"passed"}' > "$captures/report.json"
npx review-evidence --issue 42 --dir "$captures"
```

Run from a clean, pushed source checkout. `--issue` is a positive tracking number, which may identify an issue or PR; the package does not create or validate tickets. Captures should be outside the checkout or gitignored.

The command prints a JSON result containing `artifact.url`, `artifact.runId`, `artifact.artifactId`, `artifact.sourceSha`, the archive `digest`, file paths/hashes and the full manifest. It prints a bundle identity to stderr before dispatch, so interruption leaves a recovery handle.

```sh
npx review-evidence --resume <bundle-sha256>
npx review-evidence --discard <bundle-sha256>
```

Resume checks the existing transfer and run before dispatching again. Discard retires only the selected owned local bundle. Accepted transfer bytes are never overwritten. Original captures remain yours to retain until review finishes.

## How it works

1. Snapshot selected regular files from a clean candidate and construct a version-1 manifest with the pushed commit, tracking number and file hashes.
2. Keep a private local recovery bundle and transfer it through the dedicated GitHub prerelease container.
3. Dispatch the configured protected-default-branch publisher. It validates the complete transfer and uploads an immutable artifact from owned runner scratch.
4. Download and verify the artifact's repository, workflow, branch/event, successful run, identity, archive digest, manifest and every file before retiring the transfer and local spool.

The laptop and runner need no shared filesystem. The library verifies selected bytes and the associated source identity; it does **not** attest that a screenshot depicts that build or grant review/approval authority. Reviewers still inspect the content.

## Verification and retrieval

Use the returned artifact page or:

```sh
gh run download <run-id> --repo your-org/your-repository \
  --name review-evidence-<bundle-sha256> --dir /tmp/review-download
```

Artifact pages require GitHub sign-in, including for public repositories. A plain download does not perform this package's provenance/hash checks. The [API example](docs/api.md#verify-a-received-record) verifies a received record against an independently supplied expected commit and can stage read-only files for an automated reviewer.

GitHub's [artifact action](https://github.com/actions/upload-artifact) documents authenticated URLs and retention settings. The supplied workflow requests 90 days; repository/organisation limits may shorten it. Artifacts are temporary, including while a PR is open.

## Retention and limits

```sh
npx review-evidence --prune
npx review-evidence --prune --apply
```

The weekly workflow applies the same checks. Artifacts become eligible 30 days after the latest closure of all currently referencing PRs, or 30 days after creation if unreferenced. Open references protect against early cleanup, while GitHub's native expiry still applies. Complete archives from failed/cancelled publisher runs can be deleted after verification; they remain invalid as live review evidence. Abandoned transfer assets use the same 30-day grace.

Snapshots allow 1–1,000 files, at most 100 MiB per file and 200 MiB total. Supported extensions are PNG/JPEG/WebP/GIF/AVIF, MP4/MOV/WebM, JSON/XML/TXT/LOG/MD/CSV. Every path segment starts with an ASCII letter or number; remaining characters may include letters, numbers, `_`, `-` and `.`. Hidden/unsupported files, symlinks, special files, unsafe ZIP paths and undeclared files or mismatched archive contents are refused.

See [operation and recovery](docs/operation.md), [API/configuration reference](docs/api.md), and [contribution guidance](CONTRIBUTING.md). MIT licensed; [source release](https://github.com/nick-cobra/review-evidence-publisher/releases/tag/v0.1.2).
