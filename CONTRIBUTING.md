# Contributing

Use Node.js 22 or 24 on macOS/Linux with Git, GitHub CLI, zip and unzip available.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --ignore-scripts --dry-run
```

The runtime has no npm dependencies; YAML is used only by development tests. Tests use temporary repositories, synthetic archives and inert GitHub transports. They must not require credentials, a live device or network access beyond installing development dependencies.

Include a focused regression for behaviour changes. Cover the real publication/verification/CLI boundary, preserve manifest-v1 compatibility, and exercise invalid inputs without substituting an unrelated validation failure. Keep private captures, credentials and production records out of source, issues and test fixtures.

Changing the protocol or trust model needs an explicit compatibility decision. Keep unsuccessful-run deletion separate from successful live proof. Upstream runtime updates should be consumed by exact source commit; release tags are not rewritten.
