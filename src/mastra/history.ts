import { createClient } from '@libsql/client';
import { WriteNotAppliedError, type WriteCheckpoint } from './writes.js';
import { reviewSchema, type Review } from './schemas.js';

export class ReviewHistory {
  private readonly client;
  private readonly ready;

  constructor(url: string, authToken?: string) {
    this.client = createClient({ url, ...(authToken ? { authToken } : {}) });
    this.ready = this.initialize();
  }

  private async initialize() {
    await this.client.execute(`CREATE TABLE IF NOT EXISTS renewal_reviews (
      run_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      score INTEGER,
      payload TEXT NOT NULL,
      write_result TEXT,
      write_pending INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`);
    const columns = await this.client.execute('PRAGMA table_info(renewal_reviews)');
    if (!columns.rows.some((row) => row.name === 'write_progress')) {
      try {
        await this.client.execute("ALTER TABLE renewal_reviews ADD COLUMN write_progress TEXT NOT NULL DEFAULT '{}'");
      } catch (error) {
        const current = await this.client.execute('PRAGMA table_info(renewal_reviews)');
        if (!current.rows.some((row) => row.name === 'write_progress')) throw error;
      }
    }
    // Keep legacy history and completed write receipts; never overwrite newer rows.
    const legacy = await this.client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cs_reviews'");
    if (legacy.rows.length) {
      await this.client.execute(`INSERT OR IGNORE INTO renewal_reviews
        (run_id, account_id, score, payload, write_result, write_pending, updated_at)
        SELECT run_id, account_id, score, payload, write_result, write_pending, updated_at FROM cs_reviews`);
    }
  }

  async previousScore(accountId: string, runId: string) {
    await this.ready;
    const result = await this.client.execute({
      sql: `SELECT score FROM renewal_reviews
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
      sql: `INSERT INTO renewal_reviews (run_id, account_id, score, payload, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
              score = excluded.score, payload = excluded.payload, updated_at = excluded.updated_at`,
      args: [
        review.runId,
        review.accountId,
        review.score,
        JSON.stringify(review),
        review.createdAt,
      ],
    });
  }

  async get(runId: string): Promise<Review | null> {
    await this.ready;
    const result = await this.client.execute({
      sql: 'SELECT payload FROM renewal_reviews WHERE run_id = ?', args: [runId],
    });
    const payload = result.rows[0]?.payload;
    return typeof payload === 'string' ? reviewSchema.parse(JSON.parse(payload)) : null;
  }

  async writeOnce<T>(runId: string, write: (checkpoint: WriteCheckpoint) => Promise<T>): Promise<T> {
    await this.ready;
    const claim = await this.client.execute({
      sql: 'UPDATE renewal_reviews SET write_pending = 1 WHERE run_id = ? AND write_pending = 0 AND write_result IS NULL',
      args: [runId],
    });
    const row = (await this.client.execute({
      sql: 'SELECT write_result, write_progress FROM renewal_reviews WHERE run_id = ?',
      args: [runId],
    })).rows[0];
    if (typeof row?.write_result === 'string') return JSON.parse(row.write_result) as T;
    if (claim.rowsAffected !== 1) {
      throw new Error(`CRM write ${runId} is pending or missing; reconcile any remote writes before retrying`);
    }

    const progress: Record<string, unknown> = JSON.parse(String(row?.write_progress ?? '{}'));
    const checkpoint: WriteCheckpoint = async <Result>(operation: string, perform: () => Promise<Result>) => {
      if (Object.hasOwn(progress, operation)) return progress[operation] as Result;
      const value = await perform();
      progress[operation] = value;
      await this.client.execute({
        sql: 'UPDATE renewal_reviews SET write_progress = ? WHERE run_id = ?',
        args: [JSON.stringify(progress), runId],
      });
      return value;
    };

    try {
      const result = await write(checkpoint);
      await this.client.execute({
        sql: 'UPDATE renewal_reviews SET write_result = ?, write_pending = 0 WHERE run_id = ?',
        args: [JSON.stringify(result), runId],
      });
      return result;
    } catch (error) {
      // An unknown outcome may already exist remotely. Do not repeat it automatically.
      if (error instanceof WriteNotAppliedError) {
        await this.client.execute({
          sql: 'UPDATE renewal_reviews SET write_pending = 0 WHERE run_id = ?', args: [runId],
        });
      }
      throw error;
    }
  }

  close() {
    this.client.close();
  }

  async dashboard(accountId?: string) {
    await this.ready;
    const result = await this.client.execute({
      sql: `SELECT payload FROM renewal_reviews ${accountId ? 'WHERE account_id = ?' : ''}`,
      args: accountId ? [accountId] : [],
    });
    const reviews = result.rows.flatMap((row) => {
      const parsed = reviewSchema.safeParse(JSON.parse(String(row.payload)));
      return parsed.success ? [parsed.data] : [];
    });
    const sum = (pick: (review: Review) => number) =>
      reviews.reduce((total, review) => total + pick(review), 0);

    return {
      reviews: reviews.length,
      acceptedRecommendations: sum((review) => review.metrics.acceptedRecommendations),
      outreachApprovals: reviews.filter((review) => review.metrics.outreachApproved).length,
      humanFeedback: reviews.filter((review) => review.metrics.hasHumanFeedback).length,
      averageLatencyMs: reviews.length
        ? sum((review) => review.metrics.latencyMs) / reviews.length
        : 0,
      totalCostUsd: sum((review) => review.metrics.costUsd),
      alerts: reviews
        .filter((review) => (review.score ?? 100) < 30 || (review.metrics.scoreDelta ?? 0) <= -20)
        .map(
          (review) =>
            `${review.accountName}: score ${review.score}, drift ${review.metrics.scoreDelta ?? 0}`,
        ),
    };
  }
}
