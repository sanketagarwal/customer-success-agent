import { createClient } from '@libsql/client';
import { reviewSchema, type Review } from './schemas.js';
export class ReviewHistory {
  private readonly client;
  private readonly ready;
  constructor(url: string, authToken?: string) {
    this.client = createClient({ url, ...(authToken ? { authToken } : {}) });
    this.ready = this.client.execute(`CREATE TABLE IF NOT EXISTS cs_reviews (
      run_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      score INTEGER,
      payload TEXT NOT NULL,
      write_result TEXT,
      write_pending INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`);
  }
  async previousScore(accountId: string, runId: string) {
    await this.ready;
    const result = await this.client.execute({
      sql: `SELECT score FROM cs_reviews
            WHERE account_id = ? AND run_id != ? AND score IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1`,
      args: [accountId, runId],
    });
    const score = result.rows[0]?.score;
    return typeof score === 'number' ? score : score == null ? null : Number(score);
  }
  async record(review: Review) {
    await this.ready;
    await this.client.execute({
      sql: `INSERT INTO cs_reviews (run_id, account_id, score, payload, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
              score = excluded.score, payload = excluded.payload, updated_at = excluded.updated_at`,
      args: [review.runId, review.accountId, review.score, JSON.stringify(review), review.createdAt],
    });
  }
  async writeOnce<T>(runId: string, write: () => Promise<T>): Promise<T> {
    await this.ready;
    const existing = await this.client.execute({
      sql: 'SELECT write_result FROM cs_reviews WHERE run_id = ?',
      args: [runId],
    });
    const saved = existing.rows[0]?.write_result;
    if (typeof saved === 'string') return JSON.parse(saved) as T;
    const claim = await this.client.execute({
      sql: 'UPDATE cs_reviews SET write_pending = 1 WHERE run_id = ? AND write_pending = 0',
      args: [runId],
    });
    if (claim.rowsAffected !== 1) throw new Error(`CRM write ${runId} is already pending`);
    const result = await write();
    await this.client.execute({
      sql: 'UPDATE cs_reviews SET write_result = ?, write_pending = 0 WHERE run_id = ?',
      args: [JSON.stringify(result), runId],
    });
    return result;
  }
  async dashboard(accountId?: string) {
    await this.ready;
    const result = await this.client.execute({
      sql: `SELECT payload FROM cs_reviews ${accountId ? 'WHERE account_id = ?' : ''}`,
      args: accountId ? [accountId] : [],
    });
    const reviews = result.rows.flatMap((row) => {
      const parsed = reviewSchema.safeParse(JSON.parse(String(row.payload)));
      return parsed.success ? [parsed.data] : [];
    });
    const sum = (pick: (review: Review) => number) => reviews.reduce((total, review) => total + pick(review), 0);
    return {
      reviews: reviews.length,
      acceptedRecommendations: sum((review) => review.metrics.acceptedRecommendations),
      outreachApprovals: reviews.filter((review) => review.metrics.outreachApproved).length,
      humanFeedback: reviews.filter((review) => review.metrics.hasHumanFeedback).length,
      averageLatencyMs: reviews.length ? sum((review) => review.metrics.latencyMs) / reviews.length : 0,
      totalCostUsd: sum((review) => review.metrics.costUsd),
      alerts: reviews
        .filter((review) => (review.score ?? 100) < 30 || (review.metrics.scoreDelta ?? 0) <= -20)
        .map((review) => `${review.accountName}: score ${review.score}, drift ${review.metrics.scoreDelta ?? 0}`),
    };
  }
}
