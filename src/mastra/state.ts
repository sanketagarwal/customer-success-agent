import { createClient, type Client } from '@libsql/client';

import { monitoringEventSchema, reviewSchema, type MonitoringEvent, type Review } from './schemas.js';

type Intent = { status: 'pending' | 'complete'; remoteId: string | null };

export interface State {
  getReview(tenantId: string, accountId: string): Promise<Review | null>;
  saveReview(tenantId: string, accountId: string, review: Review): Promise<void>;
  record(tenantId: string, event: MonitoringEvent): Promise<void>;
  events(tenantId: string): Promise<readonly MonitoringEvent[]>;
  claimWrite(key: string): Promise<boolean>;
  getWrite(key: string): Promise<Intent | null>;
  completeWrite(key: string, remoteId: string): Promise<void>;
  releaseWrite(key: string): Promise<void>;
  close?(): void;
}

const accountKey = (tenantId: string, accountId: string) => `${tenantId}\0${accountId}`;

export class LibSqlState implements State {
  private readonly client: Client;
  private readonly ready: Promise<unknown>;

  constructor(url: string) {
    this.client = createClient({ url });
    this.ready = this.client.batch([
      'CREATE TABLE IF NOT EXISTS cs_reviews (account_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS cs_events (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, payload TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS cs_write_intents (write_key TEXT PRIMARY KEY, status TEXT NOT NULL, remote_id TEXT)',
    ], 'write');
  }

  private async execute(sql: string, args: (string | number)[] = []) {
    await this.ready;
    return this.client.execute({ sql, args });
  }

  async getReview(tenantId: string, accountId: string) {
    const row = (await this.execute('SELECT payload FROM cs_reviews WHERE account_key = ?', [accountKey(tenantId, accountId)])).rows[0];
    if (!row) return null;
    const parsed = reviewSchema.safeParse(JSON.parse(String(row.payload)));
    return parsed.success ? parsed.data : null;
  }

  async saveReview(tenantId: string, accountId: string, review: Review) {
    await this.execute(
      `INSERT INTO cs_reviews (account_key, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(account_key) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`,
      [accountKey(tenantId, accountId), JSON.stringify(review), review.asOf],
    );
  }

  async record(tenantId: string, event: MonitoringEvent) {
    await this.execute('INSERT INTO cs_events (tenant_id, payload) VALUES (?, ?)', [
      tenantId,
      JSON.stringify(monitoringEventSchema.parse(event)),
    ]);
  }

  async events(tenantId: string) {
    const rows = (await this.execute('SELECT payload FROM cs_events WHERE tenant_id = ? ORDER BY id', [tenantId])).rows;
    return rows.map(row => monitoringEventSchema.parse(JSON.parse(String(row.payload))));
  }

  async claimWrite(key: string) {
    return (await this.execute("INSERT OR IGNORE INTO cs_write_intents (write_key, status) VALUES (?, 'pending')", [key])).rowsAffected === 1;
  }

  async getWrite(key: string) {
    const row = (await this.execute('SELECT status, remote_id FROM cs_write_intents WHERE write_key = ?', [key])).rows[0];
    return row ? {
      status: String(row.status) === 'complete' ? 'complete' as const : 'pending' as const,
      remoteId: row.remote_id ? String(row.remote_id) : null,
    } : null;
  }

  async completeWrite(key: string, remoteId: string) {
    await this.execute(
      "INSERT INTO cs_write_intents VALUES (?, 'complete', ?) ON CONFLICT(write_key) DO UPDATE SET status='complete', remote_id=excluded.remote_id",
      [key, remoteId],
    );
  }

  async releaseWrite(key: string) {
    await this.execute("DELETE FROM cs_write_intents WHERE write_key = ? AND status = 'pending'", [key]);
  }

  close() {
    this.client.close();
  }
}

export function monitoringSummary(events: readonly MonitoringEvent[]) {
  const summarize = (items: readonly MonitoringEvent[]) => {
    const latency = items.map(event => event.latencyMs).sort((a, b) => a - b);
    const sum = (field: 'acceptedRecommendations' | 'inputTokens' | 'outputTokens' | 'costUsd') =>
      items.reduce((total, event) => total + event[field], 0);
    return {
      reviews: items.filter(event => event.phase === 'review').length,
      approvals: items.filter(event => event.phase === 'approval').length,
      acceptedRecommendations: sum('acceptedRecommendations'),
      outreachApprovals: items.filter(event => event.outreachApproved).length,
      humanFeedback: items.filter(event => event.feedback).length,
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      costUsd: sum('costUsd'),
      averageLatencyMs: latency.length ? latency.reduce((sum, value) => sum + value, 0) / latency.length : 0,
      p95LatencyMs: latency[Math.max(0, Math.ceil(latency.length * 0.95) - 1)] ?? 0,
    };
  };
  const accounts = [...new Set(events.map(event => event.accountId))].sort().map(accountId => {
    const items = events.filter(event => event.accountId === accountId);
    const latest = items.filter(event => event.phase === 'review').at(-1);
    return { accountId, riskScore: latest?.riskScore ?? null, scoreDelta: latest?.scoreDelta ?? null, ...summarize(items) };
  });
  return { totals: summarize(events), accounts };
}
