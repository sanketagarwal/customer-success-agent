# Evals

Run the deterministic eval gate with:

```bash
npm run evals
```

The registered Mastra scorers cover:

- risk-factor extraction
- account-plan quality
- unsupported-claim detection
- outreach personalization
- action relevance

Positive fixtures must score `1`; deliberately unsupported, irrelevant, or generic outputs must score `0`. The definitions live in `src/mastra/scorers.ts` and are also available from Studio.
