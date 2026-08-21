import { createClient, type Client } from '@libsql/client';

import { monitoringEventSchema, reviewSchema, type MonitoringEvent, type Review } from './schemas.js';

export interface CustomerSuccessState {
  getReview(tenantId: string, accountId: string): Promise<Review | null>;
  saveReview(review: Review): Promise<void>;
  record(event: MonitoringEvent): Promise<void>;
  events(tenantId?: string): Promise<readonly MonitoringEvent[]>;
  close?(): void;
}

const key = (tenantId: string, accountId: string) => `${tenantId}\u0000${accountId}`;

export class MemoryState implements CustomerSuccessState {
  private readonly reviews = new Map<string, Review>();
  private readonly log: MonitoringEvent[] = [];

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
}

export class LibSqlState implements CustomerSuccessState {
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

  close() {
    this.client.close();
  }
}

export function monitoringSummary(events: readonly MonitoringEvent[]) {
  const latency = events.map(event => event.latencyMs).sort((a, b) => a - b);
  const sum = (field: 'acceptedRecommendations' | 'inputTokens' | 'outputTokens' | 'costUsd') =>
    events.reduce((total, event) => total + event[field], 0);
  return {
    reviews: events.filter(event => event.phase === 'review').length,
    approvals: events.filter(event => event.phase === 'approval').length,
    acceptedRecommendations: sum('acceptedRecommendations'),
    outreachApprovals: events.filter(event => event.outreachApproved).length,
    humanFeedback: events.filter(event => event.feedback).length,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    costUsd: sum('costUsd'),
    averageLatencyMs: latency.length ? latency.reduce((total, value) => total + value, 0) / latency.length : 0,
    p95LatencyMs: latency[Math.max(0, Math.ceil(latency.length * 0.95) - 1)] ?? 0,
  };
}
