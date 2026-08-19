import { createClient, type Client } from '@libsql/client';

import type {
  AccountMemoryStore,
  ApprovalStore,
  CrmWriteIntent,
  CrmWriteIntentStore,
  IdempotencyRecord,
  IdempotencyStore,
  MonitoringStore,
} from '../ports/index.js';
import {
  accountMemorySchema,
  approvalDecisionSchema,
  approvalRequestSchema,
  monitoringEventSchema,
  type AccountMemory,
  type ApprovalDecision,
  type ApprovalRequest,
  type MonitoringEvent,
} from '../schemas/index.js';
import { scopeKey } from '../invariants/index.js';

export class InMemoryOperationalStore
  implements AccountMemoryStore, ApprovalStore, IdempotencyStore, CrmWriteIntentStore, MonitoringStore
{
  private readonly memories = new Map<string, AccountMemory>();
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly decisions = new Map<string, ApprovalDecision>();
  private readonly writes = new Map<string, IdempotencyRecord>();
  private readonly intents = new Map<string, CrmWriteIntent>();
  private readonly monitoringEvents: MonitoringEvent[] = [];

  get(tenantId: string, accountId: string): Promise<AccountMemory | null>;
  get(key: string): Promise<IdempotencyRecord | null>;
  async get(
    tenantOrKey: string,
    accountId?: string,
  ): Promise<AccountMemory | IdempotencyRecord | null> {
    if (accountId === undefined) return this.writes.get(tenantOrKey) ?? null;
    return this.memories.get(scopeKey(tenantOrKey, accountId)) ?? null;
  }

  async put(memory: AccountMemory): Promise<void> {
    const parsed = accountMemorySchema.parse(memory);
    this.memories.set(parsed.scopeKey, structuredClone(parsed));
  }

  async saveRequest(request: ApprovalRequest): Promise<void> {
    const parsed = approvalRequestSchema.parse(request);
    this.requests.set(parsed.runId, structuredClone(parsed));
  }

  async saveDecision(runId: string, decision: ApprovalDecision): Promise<void> {
    this.decisions.set(runId, structuredClone(approvalDecisionSchema.parse(decision)));
  }

  async getRequest(runId: string): Promise<ApprovalRequest | null> {
    return this.requests.get(runId) ?? null;
  }

  async getDecision(runId: string): Promise<ApprovalDecision | null> {
    return this.decisions.get(runId) ?? null;
  }

  async save(record: IdempotencyRecord): Promise<void> {
    this.writes.set(record.key, structuredClone(record));
  }

  async claim(key: string, attemptedAt: string): Promise<boolean> {
    if (this.intents.has(key)) return false;
    this.intents.set(key, { key, status: 'pending', writeId: null, updatedAt: attemptedAt });
    return true;
  }

  async getIntent(key: string): Promise<CrmWriteIntent | null> {
    return this.intents.get(key) ?? null;
  }

  async completeIntent(key: string, writeId: string, completedAt: string): Promise<void> {
    this.intents.set(key, { key, status: 'completed', writeId, updatedAt: completedAt });
  }

  async releaseIntent(key: string): Promise<void> {
    if (this.intents.get(key)?.status === 'pending') this.intents.delete(key);
  }

  async recordMonitoringEvent(event: MonitoringEvent): Promise<void> {
    this.monitoringEvents.push(structuredClone(monitoringEventSchema.parse(event)));
  }

  async listMonitoringEvents(tenantId?: string): Promise<readonly MonitoringEvent[]> {
    return this.monitoringEvents
      .filter((event) => !tenantId || event.tenantId === tenantId)
      .map((event) => structuredClone(event));
  }
}

export class LibSqlOperationalStore
  implements AccountMemoryStore, ApprovalStore, IdempotencyStore, CrmWriteIntentStore, MonitoringStore
{
  private readonly client: Client;
  private readonly initialized: Promise<void>;

  constructor(url: string, authToken?: string) {
    this.client = createClient({ url, ...(authToken ? { authToken } : {}) });
    this.initialized = this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.client.batch(
      [
        `CREATE TABLE IF NOT EXISTS cs_account_memory (
          scope_key TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS cs_approval_requests (
          run_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS cs_approval_decisions (
          run_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS cs_idempotency (
          key TEXT PRIMARY KEY,
          write_id TEXT NOT NULL,
          written_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS cs_crm_write_intents (
          key TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
          write_id TEXT,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS cs_monitoring_events (
          event_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          payload TEXT NOT NULL
        )`,
      ],
      'write',
    );
  }

  get(tenantId: string, accountId: string): Promise<AccountMemory | null>;
  get(key: string): Promise<IdempotencyRecord | null>;
  async get(
    tenantOrKey: string,
    accountId?: string,
  ): Promise<AccountMemory | IdempotencyRecord | null> {
    await this.initialized;
    if (accountId === undefined) {
      const result = await this.client.execute({
        sql: 'SELECT key, write_id, written_at FROM cs_idempotency WHERE key = ?',
        args: [tenantOrKey],
      });
      const row = result.rows[0];
      if (!row) return null;
      return {
        key: String(row.key),
        writeId: String(row.write_id),
        writtenAt: String(row.written_at),
      };
    }
    const key = scopeKey(tenantOrKey, accountId);
    const result = await this.client.execute({
      sql: 'SELECT payload FROM cs_account_memory WHERE scope_key = ?',
      args: [key],
    });
    const payload = result.rows[0]?.payload;
    return typeof payload === 'string' ? accountMemorySchema.parse(JSON.parse(payload)) : null;
  }

  async put(memory: AccountMemory): Promise<void> {
    await this.initialized;
    const parsed = accountMemorySchema.parse(memory);
    await this.client.execute({
      sql: `INSERT INTO cs_account_memory (scope_key, payload, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(scope_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      args: [parsed.scopeKey, JSON.stringify(parsed), parsed.updatedAt],
    });
  }

  async saveRequest(request: ApprovalRequest): Promise<void> {
    await this.initialized;
    const parsed = approvalRequestSchema.parse(request);
    await this.client.execute({
      sql: `INSERT INTO cs_approval_requests (run_id, payload) VALUES (?, ?)
            ON CONFLICT(run_id) DO UPDATE SET payload = excluded.payload`,
      args: [parsed.runId, JSON.stringify(parsed)],
    });
  }

  async saveDecision(runId: string, decision: ApprovalDecision): Promise<void> {
    await this.initialized;
    const parsed = approvalDecisionSchema.parse(decision);
    await this.client.execute({
      sql: `INSERT INTO cs_approval_decisions (run_id, payload) VALUES (?, ?)
            ON CONFLICT(run_id) DO UPDATE SET payload = excluded.payload`,
      args: [runId, JSON.stringify(parsed)],
    });
  }

  async getRequest(runId: string): Promise<ApprovalRequest | null> {
    await this.initialized;
    const result = await this.client.execute({
      sql: 'SELECT payload FROM cs_approval_requests WHERE run_id = ?',
      args: [runId],
    });
    const payload = result.rows[0]?.payload;
    return typeof payload === 'string' ? approvalRequestSchema.parse(JSON.parse(payload)) : null;
  }

  async getDecision(runId: string): Promise<ApprovalDecision | null> {
    await this.initialized;
    const result = await this.client.execute({
      sql: 'SELECT payload FROM cs_approval_decisions WHERE run_id = ?',
      args: [runId],
    });
    const payload = result.rows[0]?.payload;
    return typeof payload === 'string' ? approvalDecisionSchema.parse(JSON.parse(payload)) : null;
  }

  async save(record: IdempotencyRecord): Promise<void> {
    await this.initialized;
    await this.client.execute({
      sql: 'INSERT OR IGNORE INTO cs_idempotency (key, write_id, written_at) VALUES (?, ?, ?)',
      args: [record.key, record.writeId, record.writtenAt],
    });
  }

  async claim(key: string, attemptedAt: string): Promise<boolean> {
    await this.initialized;
    const result = await this.client.execute({
      sql: `INSERT OR IGNORE INTO cs_crm_write_intents (key, status, write_id, updated_at)
            VALUES (?, 'pending', NULL, ?)`,
      args: [key, attemptedAt],
    });
    return result.rowsAffected === 1;
  }

  async getIntent(key: string): Promise<CrmWriteIntent | null> {
    await this.initialized;
    const result = await this.client.execute({
      sql: 'SELECT key, status, write_id, updated_at FROM cs_crm_write_intents WHERE key = ?',
      args: [key],
    });
    const row = result.rows[0];
    if (!row) return null;
    return {
      key: String(row.key),
      status: String(row.status) === 'completed' ? 'completed' : 'pending',
      writeId: row.write_id === null ? null : String(row.write_id),
      updatedAt: String(row.updated_at),
    };
  }

  async completeIntent(key: string, writeId: string, completedAt: string): Promise<void> {
    await this.initialized;
    await this.client.execute({
      sql: `INSERT INTO cs_crm_write_intents (key, status, write_id, updated_at)
            VALUES (?, 'completed', ?, ?)
            ON CONFLICT(key) DO UPDATE SET
              status = 'completed', write_id = excluded.write_id, updated_at = excluded.updated_at`,
      args: [key, writeId, completedAt],
    });
  }

  async releaseIntent(key: string): Promise<void> {
    await this.initialized;
    await this.client.execute({
      sql: "DELETE FROM cs_crm_write_intents WHERE key = ? AND status = 'pending'",
      args: [key],
    });
  }

  async recordMonitoringEvent(event: MonitoringEvent): Promise<void> {
    await this.initialized;
    const parsed = monitoringEventSchema.parse(event);
    await this.client.execute({
      sql: `INSERT OR REPLACE INTO cs_monitoring_events (event_id, tenant_id, recorded_at, payload)
            VALUES (?, ?, ?, ?)`,
      args: [parsed.eventId, parsed.tenantId, parsed.recordedAt, JSON.stringify(parsed)],
    });
  }

  async listMonitoringEvents(tenantId?: string): Promise<readonly MonitoringEvent[]> {
    await this.initialized;
    const result = tenantId
      ? await this.client.execute({
          sql: 'SELECT payload FROM cs_monitoring_events WHERE tenant_id = ? ORDER BY recorded_at, rowid',
          args: [tenantId],
        })
      : await this.client.execute(
          'SELECT payload FROM cs_monitoring_events ORDER BY recorded_at, rowid',
        );
    return result.rows.map((row) => monitoringEventSchema.parse(JSON.parse(String(row.payload))));
  }

  close(): void {
    this.client.close();
  }
}
