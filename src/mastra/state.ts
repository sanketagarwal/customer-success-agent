import { createClient, type Client } from '@libsql/client';

import { monitoringEventSchema, reviewSchema, type MonitoringEvent, type Review } from './schemas.js';

export interface CustomerSuccessState {
  getReview(tenantId: string, accountId: string): Promise<Review | null>;
  saveReview(review: Review): Promise<void>;
  record(event: MonitoringEvent): Promise<void>;
  events(tenantId?: string): Promise<readonly MonitoringEvent[]>;
  close?(): void;
}

export interface WriteIntentStore {
  claimWrite(key: string): Promise<boolean>;
  getWrite(key: string): Promise<{ status: 'pending' | 'complete'; remoteId: string | null } | null>;
  completeWrite(key: string, remoteId: string): Promise<void>;
  releaseWrite(key: string): Promise<void>;
}

const key = (tenantId: string, accountId: string) => `${tenantId}\u0000${accountId}`;

export class MemoryState implements CustomerSuccessState, WriteIntentStore {
  private readonly reviews = new Map<string, Review>();
  private readonly log: MonitoringEvent[] = [];
  private readonly writes = new Map<string, { status: 'pending' | 'complete'; remoteId: string | null }>();

  async getReview(tenantId: string, accountId: string) {
    return structuredClone(this.reviews.get(key(tenantId, accountId)) ?? null);
  }

  async saveReview(review: Review) {
    this.reviews.set(key(review.assessment.tenantId, review.assessment.accountId), structuredClone(review));
  }

  async record(event: MonitoringEvent) {
    this.log.push(structuredClone(monitoringEventSchema.parse(event)));
  }

  async events(tenantId?: string) {
    return structuredClone(this.log.filter(event => !tenantId || event.tenantId === tenantId));
  }

  async claimWrite(key: string) {
    if (this.writes.has(key)) return false;
    this.writes.set(key, { status: 'pending', remoteId: null });
    return true;
  }

  async getWrite(key: string) {
    return this.writes.get(key) ?? null;
  }

  async completeWrite(key: string, remoteId: string) {
    this.writes.set(key, { status: 'complete', remoteId });
  }

  async releaseWrite(key: string) {
    if (this.writes.get(key)?.status === 'pending') this.writes.delete(key);
  }
}

export class LibSqlState implements CustomerSuccessState, WriteIntentStore {
  private readonly client: Client;
  private readonly ready: Promise<void>;

  constructor(url: string, authToken?: string) {
    this.client = createClient({ url, ...(authToken ? { authToken } : {}) });
    this.ready = this.client.batch([
      `CREATE TABLE IF NOT EXISTS cs_reviews (
        account_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS cs_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, payload TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS cs_write_intents (
        write_key TEXT PRIMARY KEY, status TEXT NOT NULL, remote_id TEXT
      )`,
    ], 'write').then(() => undefined);
  }

  async getReview(tenantId: string, accountId: string) {
    await this.ready;
    const result = await this.client.execute({
      sql: 'SELECT payload FROM cs_reviews WHERE account_key = ?',
      args: [key(tenantId, accountId)],
    });
    const payload = result.rows[0]?.payload;
    return typeof payload === 'string' ? reviewSchema.parse(JSON.parse(payload)) : null;
  }

  async saveReview(review: Review) {
    await this.ready;
    const assessment = review.assessment;
    await this.client.execute({
      sql: `INSERT INTO cs_reviews (account_key, payload, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(account_key) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`,
      args: [key(assessment.tenantId, assessment.accountId), JSON.stringify(review), assessment.asOf],
    });
  }

  async record(event: MonitoringEvent) {
    await this.ready;
    const parsed = monitoringEventSchema.parse(event);
    await this.client.execute({
      sql: 'INSERT INTO cs_events (tenant_id, payload) VALUES (?, ?)',
      args: [parsed.tenantId, JSON.stringify(parsed)],
    });
  }

  async events(tenantId?: string) {
    await this.ready;
    const result = tenantId
      ? await this.client.execute({ sql: 'SELECT payload FROM cs_events WHERE tenant_id = ? ORDER BY id', args: [tenantId] })
      : await this.client.execute('SELECT payload FROM cs_events ORDER BY id');
    return result.rows.map(row => monitoringEventSchema.parse(JSON.parse(String(row.payload))));
  }

  async claimWrite(key: string) {
    await this.ready;
    const result = await this.client.execute({
      sql: "INSERT OR IGNORE INTO cs_write_intents (write_key, status) VALUES (?, 'pending')",
      args: [key],
    });
    return result.rowsAffected === 1;
  }

  async getWrite(key: string) {
    await this.ready;
    const result = await this.client.execute({
      sql: 'SELECT status, remote_id FROM cs_write_intents WHERE write_key = ?',
      args: [key],
    });
    const row = result.rows[0];
    if (!row) return null;
    return { status: String(row.status) === 'complete' ? 'complete' as const : 'pending' as const, remoteId: row.remote_id ? String(row.remote_id) : null };
  }

  async completeWrite(key: string, remoteId: string) {
    await this.ready;
    await this.client.execute({
      sql: `INSERT INTO cs_write_intents (write_key, status, remote_id) VALUES (?, 'complete', ?)
            ON CONFLICT(write_key) DO UPDATE SET status = 'complete', remote_id = excluded.remote_id`,
      args: [key, remoteId],
    });
  }

  async releaseWrite(key: string) {
    await this.ready;
    await this.client.execute({
      sql: "DELETE FROM cs_write_intents WHERE write_key = ? AND status = 'pending'",
      args: [key],
    });
  }

  close() {
    this.client.close();
  }
}

export function monitoringSummary(events: readonly MonitoringEvent[]) {
  const summarize = (values: readonly MonitoringEvent[]) => {
    const latency = values.map(event => event.latencyMs).sort((a, b) => a - b);
    const sum = (field: 'acceptedRecommendations' | 'inputTokens' | 'outputTokens' | 'costUsd') =>
      values.reduce((total, event) => total + event[field], 0);
    return {
      reviews: values.filter(event => event.phase === 'review').length,
      approvals: values.filter(event => event.phase === 'approval').length,
      acceptedRecommendations: sum('acceptedRecommendations'),
      outreachApprovals: values.filter(event => event.outreachApproved).length,
      humanFeedback: values.filter(event => event.feedback).length,
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      costUsd: sum('costUsd'),
      averageLatencyMs: latency.length ? latency.reduce((total, value) => total + value, 0) / latency.length : 0,
      p95LatencyMs: latency[Math.max(0, Math.ceil(latency.length * 0.95) - 1)] ?? 0,
    };
  };
  const accounts = [...new Set(events.map(event => event.accountId))].sort().map(accountId => {
    const accountEvents = events.filter(event => event.accountId === accountId);
    const latest = accountEvents.filter(event => event.phase === 'review').at(-1);
    return {
      accountId,
      riskScore: latest?.riskScore ?? null,
      scoreDelta: latest?.scoreDelta ?? null,
      ...summarize(accountEvents),
    };
  });
  return { totals: summarize(events), accounts };
}
