import { resolve } from 'node:path';
import { z } from 'zod';
const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');
const environmentSchema = z.object({
  DATA_SOURCE: z.enum(['fixture', 'hubspot']).default('fixture'),
  TENANT_ID: z.string().default('demo-tenant'),
  FIXTURE_PATH: z.string().default('./data/fixtures/accounts.json'),
  MASTRA_DB_URL: z.string().default('file:./mastra.db'),
  TURSO_AUTH_TOKEN: z.string().optional(),
  MODEL: z.string().default('openai/gpt-5-mini'),
  GENERATION_MODE: z.enum(['deterministic', 'model']).default('deterministic'),
  MODEL_INPUT_COST_PER_MILLION: z.coerce.number().nonnegative().default(0),
  MODEL_OUTPUT_COST_PER_MILLION: z.coerce.number().nonnegative().default(0),
  ENABLE_OBSERVATIONAL_MEMORY: booleanString,
  ENABLE_SEMANTIC_RECALL: booleanString,
  EMBEDDING_MODEL: z.string().default('openai/text-embedding-3-small'),
  CUSTOMER_SUCCESS_CRON: z.string().default('0 9 * * 1'),
  CUSTOMER_SUCCESS_TIMEZONE: z.string().default('UTC'),
  MAX_ACCOUNT_CONCURRENCY: z.coerce.number().int().min(1).max(25).default(4),
  SIGNALS_API_URL: z.union([z.literal('').transform(() => undefined), z.url()]).optional(),
  SIGNALS_API_TOKEN: z.string().optional(),
  HUBSPOT_PRIVATE_APP_TOKEN: z.string().optional(),
  HUBSPOT_BASE_URL: z.url().default('https://api.hubapi.com'),
  HUBSPOT_RENEWAL_PROPERTY: z.string().default('renewal_date'),
});
export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const values = environmentSchema.parse(environment);
  if (values.DATA_SOURCE === 'hubspot' && !values.HUBSPOT_PRIVATE_APP_TOKEN) {
    throw new Error('HUBSPOT_PRIVATE_APP_TOKEN is required when DATA_SOURCE=hubspot');
  }
  return {
    dataSource: values.DATA_SOURCE,
    tenantId: values.TENANT_ID,
    fixturePath: resolve(environment.INIT_CWD ?? process.cwd(), values.FIXTURE_PATH),
    databaseUrl: values.MASTRA_DB_URL,
    tursoAuthToken: values.TURSO_AUTH_TOKEN,
    model: values.MODEL,
    generationMode: values.GENERATION_MODE,
    inputCost: values.MODEL_INPUT_COST_PER_MILLION,
    outputCost: values.MODEL_OUTPUT_COST_PER_MILLION,
    observationalMemory: values.ENABLE_OBSERVATIONAL_MEMORY,
    semanticRecall: values.ENABLE_SEMANTIC_RECALL,
    embeddingModel: values.EMBEDDING_MODEL,
    cron: values.CUSTOMER_SUCCESS_CRON,
    timezone: values.CUSTOMER_SUCCESS_TIMEZONE,
    maxConcurrency: values.MAX_ACCOUNT_CONCURRENCY,
    signalsApiUrl: values.SIGNALS_API_URL,
    signalsApiToken: values.SIGNALS_API_TOKEN,
    hubspotToken: values.HUBSPOT_PRIVATE_APP_TOKEN,
    hubspotBaseUrl: values.HUBSPOT_BASE_URL,
    hubspotRenewalProperty: values.HUBSPOT_RENEWAL_PROPERTY,
  };
}
export type Config = ReturnType<typeof loadConfig>;
