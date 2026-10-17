# Operation and recovery

## Permissions

Use an existing GitHub CLI login authorised for the configured repository, or an appropriately scoped token through `GH_TOKEN`.

| Actor               | Required repository access                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Local publisher     | Contents read/write for the dedicated transfer prerelease/assets; Actions read/write for dispatch and artifact readback |
| Publisher workflow  | `contents: read`; upload-artifact uses GitHub's job artifact runtime                                                    |
| Local/weekly pruner | Contents write, Actions write, pull requests read                                                                       |
| Live verifier       | Contents/Actions read                                                                                                   |

The supplied workflows declare these job permissions. They check out the protected default branch at `github.sha` without persisting checkout credentials. Runner preparation additionally checks `GITHUB_REPOSITORY`, `GITHUB_REF`, `GITHUB_EVENT_NAME`, `GITHUB_WORKFLOW_REF`, `GITHUB_ACTIONS` and `RUNNER_TEMP` before downloading anything.

The dedicated `review-evidence-transfer` prerelease/tag points to an existing source commit. Its selected ZIP assets are temporary transport, and the release body must exactly match the configured marker. Integrate that tag with your application's release/deployment filters. The tool never pushes capture files into Git or changes your application release.

Public repository mode requires explicit configuration and makes transfer assets public. Private mode refuses a public repository. Neither mode redacts files automatically. Choose synthetic or suitably redacted evidence before publication.

## CLI

`review-evidence` reads `review-evidence.config.json` from the current directory. Use `--config <path>` for another trusted JSON file.

```sh
npx review-evidence --help
npx review-evidence --issue 42 --dir /tmp/final-captures
npx review-evidence --resume <bundle-sha256>
npx review-evidence --discard <bundle-sha256>
npx review-evidence --prune
npx review-evidence --prune --apply
```

Select one operation. `--apply` belongs only to retention; resume cannot be mixed with a new source directory/issue. `--prepare <bundle>` and `--cleanup <payload-path>` are runner operations used by the packaged publishing Action. They refuse other workflow/repository/ref/event contexts. Cleanup accepts only one exact, owned, non-symlinked `review-evidence-*` child under `RUNNER_TEMP` ending in `/payload`.

## Transient GitHub reads

Recognised REST metadata GET requests retry timeouts and HTTP 502, 503 and 504 responses within one shared limit of three attempts and 90 seconds. Each command has at most 30 seconds, reduced to the remaining deadline; backoff waits are 250 ms and 500 ms. Callers may lower the attempt limit. Authentication/permission failures, malformed JSON and provenance/hash validation errors are not retried. Mutations and unrecognised commands are never automatically replayed by this helper, including after a timeout.

If reads still fail, the CLI exits with the bundle retained. Use the `--resume <bundle-sha256>` identity printed before dispatch; resumption reconciles the same transfer and existing run. Archive-download timeout retries retain their separate existing limits.

## Interrupted publication

The local bundle is private under `~/.cache/review-evidence-publisher/<owner>/<repository>/<bundle>/`. Its manifest and selected bytes are validated on recovery. The command prints the bundle identity before attempting dispatch.

Resume re-reads the dedicated release, verifies any accepted asset, and reconciles an existing active/successful run with the bundle run-name before dispatching again. A failed/cancelled run can be retried using the same bundle. An uncertain response never causes accepted bytes to be overwritten.

An upstream failed upload can leave an empty GitHub `starter` asset. Resume preserves it for 10 minutes, beyond the bounded upload timeout, before replacing only that exact empty asset. A nonempty or mismatched asset is never treated as an empty failed upload.

Discard removes one selected owned local bundle, including an interrupted write with a damaged or absent manifest. It leaves original captures alone. Abandoned remote transfers are handled by retention. Retain original captures until review finishes; deleted/expired GitHub artifacts cannot be restored by this package.

## Retention

The supplied publisher requests 90-day artifact retention, subject to GitHub repository/organisation limits. Native expiry applies to open PRs too. Artifact pages require GitHub sign-in even for public repositories. See [upload-artifact](https://github.com/actions/upload-artifact) and [GitHub's retention settings](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization).

The supplied weekly pruner previews by default as an Action; the example scheduled workflow explicitly uses `apply: "true"`. It considers only the exact publisher hash namespace. A candidate is eligible 30 days after the latest closure of all PRs currently referencing it, or 30 days after artifact creation if there are no references. The weekly schedule removes eligible items on its next run. Open references prevent early deletion.

Before deletion, it verifies repository/head repository, exact publisher workflow/default branch/dispatch event, completed run, immutable artifact identity, archive digest, complete bounded manifest/files, bundle and pushed source. A final artifact, run/activity and PR-reference read must still match. Complete abandoned uploads from failed/cancelled runs can be cleaned up; live verification still requires success. Abandoned transfers must match the dedicated container, hash namespace and verified archive; empty failed starters have no archive to verify.

Malformed, tampered, expired or incomplete metadata/archive reads fail closed. Listing is bounded to 100 pages of 100 items; an incomplete/excess listing stops cleanup. GitHub has no atomic transaction joining PR/run state with artifact deletion. A rerun or reference added after the last read can require replacement evidence. Unrelated CI artifacts are untouched.

## Boundaries

The manifest associates caller-selected bytes with a clean pushed commit. Hashes and workflow provenance establish those identities; they do not establish that the capture was produced by that build, that its content is correct, or that a human approved it. Keep capture procedures, semantic review and approval rules in your own tooling.
