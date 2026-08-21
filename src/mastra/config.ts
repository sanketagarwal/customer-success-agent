import { resolve } from 'node:path';

import { z } from 'zod';

const boolean = z.enum(['true', 'false']).default('false').transform(value => value === 'true');
const schema = z.object({
  CRM_PROVIDER: z.enum(['fixture', 'hubspot']).default('fixture'),
  TENANT_ID: z.string().default('demo-tenant'),
  FIXTURE_PATH: z.string().default('./data/fixtures/accounts.json'),
  FIXTURE_NOW: z.iso.datetime({ offset: true }).default('2026-08-17T09:00:00.000Z'),
  MASTRA_DB_URL: z.string().default('file:./mastra.db'),
  TURSO_AUTH_TOKEN: z.string().optional(),
  CUSTOMER_SUCCESS_CRON: z.string().default('0 9 * * 1'),
  CUSTOMER_SUCCESS_TIMEZONE: z.string().default('UTC'),
  GENERATION_MODE: z.enum(['model', 'fixture']).default('model'),
  MODEL: z.string().default('openai/gpt-5-mini'),
  MODEL_INPUT_COST_PER_MILLION: z.coerce.number().nonnegative().default(0),
  MODEL_OUTPUT_COST_PER_MILLION: z.coerce.number().nonnegative().default(0),
  ENABLE_OBSERVATIONAL_MEMORY: boolean,
  ENABLE_SEMANTIC_RECALL: boolean,
  EMBEDDING_MODEL: z.string().default('openai/text-embedding-3-small'),
  HUBSPOT_PRIVATE_APP_TOKEN: z.string().optional(),
  HUBSPOT_BASE_URL: z.url().default('https://api.hubapi.com'),
  HUBSPOT_RENEWAL_PROPERTY: z.string().default('renewal_date'),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const value = schema.parse(environment);
  if (value.CRM_PROVIDER === 'hubspot' && !value.HUBSPOT_PRIVATE_APP_TOKEN) {
    throw new Error('HUBSPOT_PRIVATE_APP_TOKEN is required when CRM_PROVIDER=hubspot');
  }
  const root = environment.INIT_CWD ?? environment.PWD ?? process.cwd();
  return {
    crmProvider: value.CRM_PROVIDER,
    tenantId: value.TENANT_ID,
    fixturePath: resolve(root, value.FIXTURE_PATH),
    fixtureNow: value.FIXTURE_NOW,
    databaseUrl: value.MASTRA_DB_URL,
    tursoAuthToken: value.TURSO_AUTH_TOKEN,
    cron: value.CUSTOMER_SUCCESS_CRON,
    timezone: value.CUSTOMER_SUCCESS_TIMEZONE,
    generationMode: value.GENERATION_MODE,
    model: value.MODEL,
    modelInputCostPerMillion: value.MODEL_INPUT_COST_PER_MILLION,
    modelOutputCostPerMillion: value.MODEL_OUTPUT_COST_PER_MILLION,
    observationalMemory: value.ENABLE_OBSERVATIONAL_MEMORY,
    semanticRecall: value.ENABLE_SEMANTIC_RECALL,
    embeddingModel: value.EMBEDDING_MODEL,
    hubspotToken: value.HUBSPOT_PRIVATE_APP_TOKEN,
    hubspotBaseUrl: value.HUBSPOT_BASE_URL,
    hubspotRenewalProperty: value.HUBSPOT_RENEWAL_PROPERTY,
  };
}
