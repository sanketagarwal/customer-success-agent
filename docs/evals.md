# Evals

The test suite runs the deterministic eval gate:

```bash
npm test
```

The registered Mastra scorers cover:

- risk-factor extraction
- account-plan quality
- unsupported-claim detection
- outreach personalization
- action relevance

Positive fixtures must score `1`; deliberately unsupported, irrelevant, generic, or misrouted outputs must score `0`. The scorers are registered in Studio and defined in `src/mastra/scorers.ts`.
