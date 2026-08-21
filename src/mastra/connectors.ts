import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { AppConfig } from './config.js';
import { HubSpotConnector } from './hubspot.js';
import {
  accountSchema,
  crmWriteSchema,
  notesResultSchema,
  snapshotSchema,
  supportResultSchema,
  usageResultSchema,
  type Account,
  type CrmWrite,
  type BillingData,
  type NotesData,
  type ReadResult,
  type Review,
  type SupportData,
  type TimeWindow,
  type UsageData,
} from './schemas.js';

export interface Query {
  tenantId: string;
  accountId: string;
  window: TimeWindow;
}

export interface CrmWriteInput {
  tenantId: string;
  accountId: string;
  runId: string;
  review: Review;
}

export interface CustomerSuccessConnectors {
  listAccounts(tenantId: string): Promise<readonly Account[]>;
  readUsage(query: Query): Promise<ReadResult<UsageData>>;
  readSupport(query: Query): Promise<ReadResult<SupportData>>;
  readBilling(query: Query): Promise<ReadResult<BillingData>>;
  readCrmNotes(query: Query): Promise<ReadResult<NotesData>>;
  writeToCrm(input: CrmWriteInput): Promise<CrmWrite>;
}

const fixtureBookSchema = z.object({
  accounts: z.array(accountSchema),
  snapshots: z.record(z.string(), snapshotSchema),
});

const inWindow = (value: string, window: TimeWindow) =>
  Date.parse(value) >= Date.parse(window.start) && Date.parse(value) <= Date.parse(window.end);

const stableId = (prefix: string, value: string) =>
  `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;

export class FixtureConnector implements CustomerSuccessConnectors {
  private book?: Promise<z.infer<typeof fixtureBookSchema>>;
  private readonly writes = new Map<string, CrmWrite>();

  constructor(private readonly path: string) {}

  private load() {
    this.book ??= readFile(this.path, 'utf8').then(value => fixtureBookSchema.parse(JSON.parse(value)));
    return this.book;
  }

  private async snapshot(query: Query) {
    const snapshot = (await this.load()).snapshots[query.accountId];
    return snapshot?.tenantId === query.tenantId ? snapshot : null;
  }

  async listAccounts(tenantId: string) {
    return (await this.load()).accounts.filter(account => account.tenantId === tenantId);
  }

  async readUsage(query: Query) {
    const result = (await this.snapshot(query))?.usage;
    if (!result || result.status === 'empty') return { status: 'empty' as const };
    if (result.status === 'unavailable') return result;
    const points = result.data.points.filter(point => inWindow(point.timestamp, query.window));
    return points.length
      ? usageResultSchema.parse({ status: 'available', data: { ...result.data, window: query.window, points } })
      : { status: 'empty' as const };
  }

  async readSupport(query: Query) {
    const result = (await this.snapshot(query))?.support;
    if (!result || result.status === 'empty') return { status: 'empty' as const };
    if (result.status === 'unavailable') return result;
    const tickets = result.data.tickets.filter(ticket => inWindow(ticket.createdAt, query.window));
    return tickets.length
      ? supportResultSchema.parse({ status: 'available', data: { ...result.data, window: query.window, tickets } })
      : { status: 'empty' as const };
  }

  async readBilling(query: Query) {
    const result = (await this.snapshot(query))?.billing;
    if (!result || result.status === 'empty') return { status: 'empty' as const };
    if (result.status === 'unavailable') return result;
    return inWindow(result.data.asOf, query.window) ? result : { status: 'empty' as const };
  }

  async readCrmNotes(query: Query) {
    const result = (await this.snapshot(query))?.crm;
    if (!result || result.status === 'empty') return { status: 'empty' as const };
    if (result.status === 'unavailable') return result;
    const notes = result.data.notes.filter(note => inWindow(note.createdAt, query.window));
    return notes.length
      ? notesResultSchema.parse({ status: 'available', data: { ...result.data, window: query.window, notes } })
      : { status: 'empty' as const };
  }

  async writeToCrm(input: CrmWriteInput) {
    const key = `${input.tenantId}:${input.accountId}:${input.runId}`;
    const existing = this.writes.get(key);
    if (existing) return { ...existing, created: false };
    const result = crmWriteSchema.parse({
      noteId: stableId('fixture-note', input.runId),
      taskIds: input.review.plan.actions.map(action => stableId('fixture-task', `${input.runId}:${action.id}`)),
      created: true,
    });
    this.writes.set(key, result);
    return result;
  }
}

export function createConnectors(config: AppConfig, overrides: Partial<CustomerSuccessConnectors> = {}) {
  const fixture = new FixtureConnector(config.fixturePath);
  const crm =
    config.crmProvider === 'hubspot'
      ? new HubSpotConnector({
          tenantId: config.tenantId,
          token: config.hubspotToken!,
          baseUrl: config.hubspotBaseUrl,
          renewalProperty: config.hubspotRenewalProperty,
        })
      : fixture;

  return {
    listAccounts: overrides.listAccounts ?? crm.listAccounts.bind(crm),
    readUsage: overrides.readUsage ?? fixture.readUsage.bind(fixture),
    readSupport: overrides.readSupport ?? fixture.readSupport.bind(fixture),
    readBilling: overrides.readBilling ?? fixture.readBilling.bind(fixture),
    readCrmNotes: overrides.readCrmNotes ?? crm.readCrmNotes.bind(crm),
    writeToCrm: overrides.writeToCrm ?? crm.writeToCrm.bind(crm),
  } satisfies CustomerSuccessConnectors;
}
