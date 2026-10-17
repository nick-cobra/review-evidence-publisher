# Runtime distribution without npm install

Use this option when an execution checkout deliberately has no `node_modules`.
Node.js 22+ is still required. The runtime's GitHub/ZIP operations retain their
normal `gh`, `git`, `zip` and `unzip` prerequisites; verification and extraction
of this distribution use Node built-ins only and make no network requests.

Each release supplies:

- `review-evidence-publisher-v0.1.2-runtime.tar`: the fixed runtime inventory,
  package metadata, README, MIT licence and `runtime-manifest.json`.
- A `.tar.sha256` file and a `.manifest.json` file for inspection.
- `verify-runtime.mjs`: a standalone verifier/extractor, identical to
  `bin/runtime.mjs` at the release's full source commit.

The archive contains regular files only. It excludes tests, development
dependencies, repository configuration and workflow files. Copy workflows from
the release's [examples](../examples/) separately if needed.

## Pin and verify before executing

Select a reviewed upstream release and record its **full source commit**,
**archive SHA-256** and **verifier SHA-256** in your own trusted repository.
The release notes publish these values. Review their source and changes through
your normal trust process. A checksum or manifest downloaded beside arbitrary
code does not authenticate that code, and the manifest's source field is a
declaration checked against your pin, not independent source attestation.

Download the archive and verifier from that release. Before running the verifier,
check its bytes against your independently selected verifier pin:

```sh
printf '%s  verify-runtime.mjs\n' '<pinned-verifier-sha256>' | shasum -a 256 -c -
node verify-runtime.mjs verify \
  --archive review-evidence-publisher-v0.1.2-runtime.tar \
  --sha256 '<pinned-archive-sha256>' \
  --source-sha '<pinned-full-source-commit>' \
  --version 0.1.2 \
  --output ./vendor/review-evidence-publisher
```

On systems without `shasum`, `sha256sum -c -` accepts the same checksum line.
Alternatively, obtain the verifier directly from the independently reviewed
source commit and check it against your pin. Do not execute a verifier taken
from an unverified archive.

Verification checks the archive digest before parsing, the exact source/version,
canonical manifest and fixed inventory, and every file's size and SHA-256. The
bounded reader accepts only the exporter's narrow POSIX ustar format: regular
files, fixed safe paths/modes, no links, duplicate/extra entries, prefixes or
extended records. Missing, changed, unsafe or incomplete contents refuse before
an output directory is created. Limits are 256 KiB per file and 2 MiB per archive.

`--output` must name a new directory whose parent already exists. Existing
directories and links are never overwritten. Omit `--output` for read-only archive
verification. No archived JavaScript is loaded during verification. The output
includes the manifest so the inventory/provenance can be reviewed and retained.
Filesystem operations assume the caller controls the destination parent; they
are not a transaction against another process running as the same OS user.

## Use the verified runtime

Keep your configuration outside the copied upstream directory:

```js
import { createEvidencePublisher } from "./vendor/review-evidence-publisher/index.mjs";

export const publisher = createEvidencePublisher({ repository: "your-org/your-repository" });
```

The ordinary CLI works without installation:

```sh
node vendor/review-evidence-publisher/bin/review-evidence.mjs --help
node vendor/review-evidence-publisher/bin/review-evidence.mjs \
  --config review-evidence.config.json --issue 42 --dir /tmp/final-captures
```

The runtime never downloads its own replacement. Your repository owns its
configuration, deployment integrity checks and approval policy. Existing npm
installation, manifest v1, publication and recovery remain supported.

## Update a vendored runtime

1. Review the new upstream release/source diff and select its new independent
   source/archive/verifier pins.
2. Verify and extract into a **new** directory with the new version and pins.
3. Review the manifest and complete file diff. Consume upstream files unchanged;
   put project-specific behaviour in your own configuration/adapters.
4. Replace the old tracked snapshot through your normal repository review,
   update recorded pins/inventory checks together, and exercise your consumers.

## Maintainer export

From a source checkout containing the committed release version:

```sh
node bin/runtime.mjs export --source . --output /tmp/review-evidence-runtime-release
```

The command reads only the fixed files from immutable Git `HEAD`, refuses tracked
links/missing files and writes four new release assets plus a JSON receipt. It
does not include working-tree changes or create a tag/release. Repeated exports
of the same commit produce identical archive and manifest bytes. Retain the
receipt's pins in the release notes and verify a downloaded copy before use.
