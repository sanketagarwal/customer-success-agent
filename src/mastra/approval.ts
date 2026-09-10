import { createHash } from 'node:crypto';
import type { CustomerDataSource } from './data.js';
import type { ReviewHistory } from './history.js';
import type { AccountSignals, Review } from './schemas.js';

export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Preserve the hash format used by already-suspended reviews.
export function withArtifactHash(review: Review): Review {
  return {
    ...review,
    artifactHash: digest({
      sourceHash: review.sourceHash,
      score: review.score,
      risks: review.risks,
      actions: review.actions,
      outreach: review.outreach,
    }),
  };
}

export function isCurrentReview(review: Review, account: AccountSignals | null) {
  return Boolean(account) && Date.now() <= Date.parse(review.expiresAt)
    && digest(account) === review.sourceHash
    && withArtifactHash(review).artifactHash === review.artifactHash;
}

export async function persistApprovedReview(
  data: CustomerDataSource, history: ReviewHistory, review: Review,
  approverId?: string,
) {
  const saved = await history.get(review.runId);
  if (!saved || saved.accountId !== review.accountId || saved.artifactHash !== review.artifactHash) {
    throw new Error('Approval must reference a persisted account review');
  }
  if (saved.outcome === 'written' && saved.writeId) {
    return { writeId: saved.writeId, taskIds: saved.taskIds };
  }
  if (saved.outcome !== 'awaiting_approval' || !isCurrentReview(saved, await data.getAccount(saved.accountId))) {
    throw new Error('Review is stale or is not awaiting approval; run a new account review');
  }
  // Use the persisted payload, not fields supplied by a model or caller.
  const write = await history.writeOnce(saved.runId, (checkpoint) => data.saveReview(saved, checkpoint));
  await history.record({
    ...saved, ...write, outcome: 'written',
    ...(approverId ? { approval: {
      decision: 'approved' as const, approverId, decidedAt: new Date().toISOString(),
    } } : {}),
    metrics: {
      ...saved.metrics, acceptedRecommendations: saved.actions.length, outreachApproved: true,
    },
  });
  return write;
}
