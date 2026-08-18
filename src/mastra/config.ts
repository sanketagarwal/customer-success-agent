import { resolve } from 'node:path';

import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const configSchema = z.object({
  DATA_SOURCE: z.enum(['fixture', 'hubspot']).default('fixture'),
  TENANT_ID: z.string().min(1).default('demo-tenant'),
  FIXTURE_TENANT_ID: z.string().min(1).default('demo-tenant'),
  FIXTURE_PATH: z.string().default('./data/fixtures/accounts.json'),
  FIXTURE_NOW: z.iso.datetime({ offset: true }).default('2026-08-17T09:00:00.000Z'),
  MASTRA_DB_URL: z.string().default('file:./mastra.db'),
  TURSO_AUTH_TOKEN: z.string().optional(),
  CUSTOMER_SUCCESS_CRON: z.string().default('0 9 * * 1'),
  CUSTOMER_SUCCESS_TIMEZONE: z.string().default('UTC'),
  MAX_ACCOUNT_CONCURRENCY: z.coerce.number().int().min(1).max(25).default(4),
  GENERATION_MODE: z.enum(['deterministic', 'model']).default('deterministic'),
  MODEL: z.string().min(1).default('openai/gpt-5-mini'),
  ENABLE_OBSERVATIONAL_MEMORY: booleanString,
  ENABLE_SEMANTIC_RECALL: booleanString,
  EMBEDDING_MODEL: z.string().min(1).default('openai/text-embedding-3-small'),
  HUBSPOT_PRIVATE_APP_TOKEN: z.string().optional(),
  HUBSPOT_BASE_URL: z.url().default('https://api.hubapi.com'),
  HUBSPOT_RENEWAL_PROPERTY: z.string().min(1).default('renewal_date'),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = configSchema.parse(environment);
  if (parsed.DATA_SOURCE === 'hubspot' && !parsed.HUBSPOT_PRIVATE_APP_TOKEN) {
    throw new Error('HUBSPOT_PRIVATE_APP_TOKEN is required when DATA_SOURCE=hubspot');
  }
  const projectDirectory = environment.INIT_CWD ?? environment.PWD ?? process.cwd();
  return {
    dataSource: parsed.DATA_SOURCE,
    tenantId: parsed.TENANT_ID,
    fixtureTenantId: parsed.FIXTURE_TENANT_ID,
    fixturePath: resolve(projectDirectory, parsed.FIXTURE_PATH),
    fixtureNow: parsed.FIXTURE_NOW,
    databaseUrl: parsed.MASTRA_DB_URL,
    tursoAuthToken: parsed.TURSO_AUTH_TOKEN,
    cron: parsed.CUSTOMER_SUCCESS_CRON,
    timezone: parsed.CUSTOMER_SUCCESS_TIMEZONE,
    maxAccountConcurrency: parsed.MAX_ACCOUNT_CONCURRENCY,
    generationMode: parsed.GENERATION_MODE,
    model: parsed.MODEL,
    observationalMemory: parsed.ENABLE_OBSERVATIONAL_MEMORY,
    semanticRecall: parsed.ENABLE_SEMANTIC_RECALL,
    embeddingModel: parsed.EMBEDDING_MODEL,
    hubspotToken: parsed.HUBSPOT_PRIVATE_APP_TOKEN,
    hubspotBaseUrl: parsed.HUBSPOT_BASE_URL,
    hubspotRenewalProperty: parsed.HUBSPOT_RENEWAL_PROPERTY,
  };
}
