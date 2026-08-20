# Contributing

Before opening a pull request, install from the lockfile and run the complete
release gate:

```bash
npm ci
npm run validate
npm audit --omit=dev --audit-level=high
```

Keep source adapters behind the interfaces in `src/mastra/ports`, add contract
tests for new providers, and never commit credentials or production customer
data.

The Mastra packages are pinned as one tested compatibility set. Upgrade them
together. The deployer override avoids a virtual-entry resolver regression in
the 1.60 deployer; remove it only after a clean build on the replacement.

For inclusion in the official catalog, propose the finished template under
[`/templates`](https://github.com/mastra-ai/mastra/tree/main/templates) in the
Mastra monorepo. Official templates may later be synced to standalone
repositories.
