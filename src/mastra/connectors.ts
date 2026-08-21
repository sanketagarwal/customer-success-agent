import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { AppConfig } from './config.js';
import { HubSpotConnector } from './hubspot.js';
import {
  accountSchema,
  billingResultSchema,
  crmWriteSchema,
  notesResultSchema,
  snapshotSchema,
  supportResultSchema,
  usageResultSchema,
  type Account,
  type BillingData,
  type CrmWrite,
  type NotesData,
  type ReadResult,
  type Review,
  type SupportData,
  type TimeWindow,
  type UsageData,
} from './schemas.js';
import type { State } from './state.js';

export interface Query {
  tenantId: string;
  accountId: string;
  window: TimeWindow;
}

export interface Connectors {
  listAccounts(tenantId: string): Promise<readonly Account[]>;
  readUsage(query: Query): Promise<ReadResult<UsageData>>;
  readSupport(query: Query): Promise<ReadResult<SupportData>>;
  readBilling(query: Query): Promise<ReadResult<BillingData>>;
  readCrmNotes(query: Query): Promise<ReadResult<NotesData>>;
  writeToCrm(input: { tenantId: string; accountId: string; runId: string; review: Review }): Promise<CrmWrite>;
}

const fixtureSchema = z.object({
  accounts: z.array(accountSchema),
  snapshots: z.record(z.string(), snapshotSchema.pick({ usage: true, support: true, billing: true, crm: true })),
});
const inWindow = (date: string, { start, end }: TimeWindow) => {
  const time = Date.parse(date);
  return time >= Date.parse(start) && time <= Date.parse(end);
};
const id = (prefix: string, value: string) =>
  `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;

export class FixtureConnector implements Connectors {
  private data?: Promise<z.infer<typeof fixtureSchema>>;
  private readonly writes = new Map<string, CrmWrite>();

  constructor(private readonly path: string) {}

  private load() {
    return this.data ??= readFile(this.path, 'utf8').then(value => fixtureSchema.parse(JSON.parse(value)));
  }

  private async source(accountId: string) {
    return (await this.load()).snapshots[accountId];
  }

  async listAccounts() {
    return (await this.load()).accounts;
  }

  async readUsage(query: Query) {
    const source = (await this.source(query.accountId))?.usage;
    if (source?.status !== 'available') return source ?? { status: 'empty' as const };
    const data = source.data.filter(point => inWindow(point.timestamp, query.window));
    return data.length ? usageResultSchema.parse({ status: 'available', data }) : { status: 'empty' as const };
  }

  async readSupport(query: Query) {
    const source = (await this.source(query.accountId))?.support;
    if (source?.status !== 'available') return source ?? { status: 'empty' as const };
    const data = source.data.filter(ticket => inWindow(ticket.createdAt, query.window));
    return data.length ? supportResultSchema.parse({ status: 'available', data }) : { status: 'empty' as const };
  }

  async readBilling(query: Query) {
    const source = (await this.source(query.accountId))?.billing;
    return source?.status === 'available' && !inWindow(source.data.asOf, query.window)
      ? { status: 'empty' as const }
      : source ?? billingResultSchema.parse({ status: 'empty' });
  }

  async readCrmNotes(query: Query) {
    const source = (await this.source(query.accountId))?.crm;
    if (source?.status !== 'available') return source ?? { status: 'empty' as const };
    const data = source.data.filter(note => inWindow(note.createdAt, query.window));
    return data.length ? notesResultSchema.parse({ status: 'available', data }) : { status: 'empty' as const };
  }

  async writeToCrm(input: Parameters<Connectors['writeToCrm']>[0]) {
    const key = `${input.tenantId}:${input.accountId}:${input.runId}`;
    const existing = this.writes.get(key);
    if (existing) return { ...existing, created: false };
    const write = crmWriteSchema.parse({
      noteId: id('fixture-note', key),
      taskIds: input.review.plan.actions.map(action => id('fixture-task', `${key}:${action.id}`)),
      created: true,
    });
    this.writes.set(key, write);
    return write;
  }
}

export function createConnectors(config: AppConfig, state: State, overrides: Partial<Connectors> = {}) {
  const fixture = new FixtureConnector(config.fixturePath);
  const crm: Pick<Connectors, 'listAccounts' | 'readCrmNotes' | 'writeToCrm'> = config.crmProvider === 'hubspot'
    ? new HubSpotConnector(config, state)
    : fixture;
  return {
    listAccounts: overrides.listAccounts ?? crm.listAccounts.bind(crm),
    readUsage: overrides.readUsage ?? fixture.readUsage.bind(fixture),
    readSupport: overrides.readSupport ?? fixture.readSupport.bind(fixture),
    readBilling: overrides.readBilling ?? fixture.readBilling.bind(fixture),
    readCrmNotes: overrides.readCrmNotes ?? crm.readCrmNotes.bind(crm),
    writeToCrm: overrides.writeToCrm ?? crm.writeToCrm.bind(crm),
  } satisfies Connectors;
}
