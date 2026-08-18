import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type {
  AccountQuery,
  BillingRepository,
  CrmRepository,
  SupportRepository,
  UsageRepository,
} from '../../ports/index.js';
import {
  accountSchema,
  billingStatusSchema,
  crmNotesSchema,
  sourceSnapshotSchema,
  supportHistorySchema,
  usageSeriesSchema,
  type Account,
  type BillingStatus,
  type CrmNotes,
  type SourceReadResult,
  type SourceSnapshot,
  type SupportHistory,
  type UsageSeries,
} from '../../schemas/index.js';

const fixtureBookSchema = z.object({
  accounts: z.array(accountSchema),
  snapshots: z.record(z.string(), sourceSnapshotSchema),
});

type FixtureBook = z.infer<typeof fixtureBookSchema>;

export interface FixtureRepositoryOptions {
  sourceTenantId?: string;
}

function inside(timestamp: string, query: AccountQuery): boolean {
  return Date.parse(timestamp) >= Date.parse(query.window.start) &&
    Date.parse(timestamp) <= Date.parse(query.window.end);
}

export class FixtureRepositories
  implements UsageRepository, SupportRepository, BillingRepository, CrmRepository
{
  private bookPromise?: Promise<FixtureBook>;

  constructor(
    private readonly fixturePath: string,
    private readonly options: FixtureRepositoryOptions = {},
  ) {}

  private load(): Promise<FixtureBook> {
    this.bookPromise ??= readFile(this.fixturePath, 'utf8').then((value) =>
      fixtureBookSchema.parse(JSON.parse(value)),
    );
    return this.bookPromise;
  }

  private async snapshot(query: AccountQuery): Promise<SourceSnapshot | null> {
    const book = await this.load();
    const snapshot = book.snapshots[query.accountId];
    const sourceTenantId = this.options.sourceTenantId ?? query.tenantId;
    if (!snapshot || snapshot.tenantId !== sourceTenantId) return null;
    return snapshot;
  }

  async listAccounts(tenantId: string): Promise<readonly Account[]> {
    const book = await this.load();
    return book.accounts.filter((account) => account.tenantId === tenantId);
  }

  async getUsage(query: AccountQuery): Promise<SourceReadResult<UsageSeries>> {
    const snapshot = await this.snapshot(query);
    if (!snapshot || snapshot.usage.status === 'empty') return { status: 'empty' };
    if (snapshot.usage.status === 'unavailable') return snapshot.usage;
    const points = snapshot.usage.data.points.filter((point) => inside(point.timestamp, query));
    if (points.length === 0) return { status: 'empty' };
    return {
      status: 'available',
      data: usageSeriesSchema.parse({
        ...snapshot.usage.data,
        tenantId: query.tenantId,
        accountId: query.accountId,
        window: query.window,
        points,
      }),
    };
  }

  async getSupportHistory(query: AccountQuery): Promise<SourceReadResult<SupportHistory>> {
    const snapshot = await this.snapshot(query);
    if (!snapshot || snapshot.support.status === 'empty') return { status: 'empty' };
    if (snapshot.support.status === 'unavailable') return snapshot.support;
    const tickets = snapshot.support.data.tickets.filter((ticket) => inside(ticket.createdAt, query));
    if (tickets.length === 0) return { status: 'empty' };
    return {
      status: 'available',
      data: supportHistorySchema.parse({
        ...snapshot.support.data,
        tenantId: query.tenantId,
        accountId: query.accountId,
        window: query.window,
        tickets,
      }),
    };
  }

  async getBillingStatus(query: AccountQuery): Promise<SourceReadResult<BillingStatus>> {
    const snapshot = await this.snapshot(query);
    if (!snapshot || snapshot.billing.status === 'empty') return { status: 'empty' };
    if (snapshot.billing.status === 'unavailable') return snapshot.billing;
    if (!inside(snapshot.billing.data.asOf, query)) return { status: 'empty' };
    return {
      status: 'available',
      data: billingStatusSchema.parse({
        ...snapshot.billing.data,
        tenantId: query.tenantId,
        accountId: query.accountId,
      }),
    };
  }

  async getCrmNotes(query: AccountQuery): Promise<SourceReadResult<CrmNotes>> {
    const snapshot = await this.snapshot(query);
    if (!snapshot || snapshot.crm.status === 'empty') return { status: 'empty' };
    if (snapshot.crm.status === 'unavailable') return snapshot.crm;
    const notes = snapshot.crm.data.notes.filter((note) => inside(note.createdAt, query));
    if (notes.length === 0) return { status: 'empty' };
    return {
      status: 'available',
      data: crmNotesSchema.parse({
        ...snapshot.crm.data,
        tenantId: query.tenantId,
        accountId: query.accountId,
        window: query.window,
        notes,
      }),
    };
  }
}
