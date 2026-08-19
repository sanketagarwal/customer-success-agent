import { createComposition } from '../src/mastra/composition/create-composition.js';
import { loadConfig } from '../src/mastra/config.js';

if (
  !process.env.OPENAI_API_KEY &&
  !process.env.ANTHROPIC_API_KEY &&
  !process.env.GOOGLE_API_KEY
) {
  throw new Error('Set the API key required by MODEL before running the optional model-memory demo');
}

const config = loadConfig({
  ...process.env,
  DATA_SOURCE: 'fixture',
  GENERATION_MODE: 'model',
  ENABLE_OBSERVATIONAL_MEMORY: 'true',
  ENABLE_SEMANTIC_RECALL: 'true',
  MASTRA_DB_URL: process.env.MODEL_MEMORY_DB_URL ?? 'file:./data/model-memory-demo.db',
});
const composition = createComposition(config);
const base = {
  tenantId: 'demo-tenant',
  accountId: '340734348989',
  asOf: config.fixtureNow,
};

try {
  const baseline = await composition.service.prepare({ runId: 'model-memory-baseline', ...base });
  const recalled = await composition.service.prepare({ runId: 'model-memory-recall', ...base });
  const events = await composition.operationalStore.listMonitoringEvents(base.tenantId);
  console.log(
    JSON.stringify(
      {
        model: config.model,
        workingMemory: true,
        observationalMemory: config.observationalMemory,
        semanticRecall: config.semanticRecall,
        baseline: { outcome: baseline.outcome, drift: baseline.drift?.direction ?? null },
        recalled: { outcome: recalled.outcome, drift: recalled.drift?.direction ?? null },
        usage: events.map(({ runId, inputTokens, outputTokens, totalTokens, costUsd }) => ({
          runId,
          inputTokens,
          outputTokens,
          totalTokens,
          costUsd,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  composition.operationalStore.close();
}
