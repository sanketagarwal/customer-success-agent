import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FixtureConnector } from '../src/mastra/connectors.js';
import { groundingErrors, prepareReview } from '../src/mastra/customer-success.js';
import { FixtureReviewer, redactSnapshot } from '../src/mastra/reviewer.js';
import { MemoryState } from '../src/mastra/state.js';
import { collectAccountData } from '../src/mastra/workflows.js';

const asOf = '2026-08-17T09:00:00.000Z';
const window = { start: '2026-07-20T09:00:00.000Z', end: asOf };

async function snapshot() {
  return collectAccountData(
    new FixtureConnector(resolve('data/fixtures/accounts.json')),
    'demo-tenant',
    '340734348989',
    window,
  );
}

describe('structured review', () => {
  it('grounds every risk, action, and outreach claim in source records', async () => {
    const source = await snapshot();
    const result = await prepareReview(source, new FixtureReviewer(), null);
    expect(result.errors).toEqual([]);
    expect(result.review.assessment.riskFactors).toHaveLength(4);
    expect(result.review.outreach.body).toContain('Product adoption moved from 72% to 31%');

    const unsupported = structuredClone(result.review);
    unsupported.assessment.riskFactors[0]!.evidence[0]!.value = 999;
    expect(groundingErrors(unsupported, source)).toContain('riskFactors[0].evidence[0]');
  });

  it('calculates drift from account-scoped state', async () => {
    const source = await snapshot();
    const reviewer = new FixtureReviewer();
    const store = new MemoryState();
    const first = await prepareReview(source, reviewer, await store.getReview('demo-tenant', source.accountId));
    await store.saveReview(first.review);
    const second = await prepareReview(source, reviewer, await store.getReview('demo-tenant', source.accountId));
    expect(first.review.drift.direction).toBe('baseline');
    expect(second.review.drift).toEqual({
      previousScore: first.review.assessment.score,
      scoreDelta: 0,
      direction: 'stable',
    });
  });

  it('redacts support subjects and CRM note contents before model generation', async () => {
    const redacted = redactSnapshot(await snapshot());
    if (redacted.support.status !== 'available' || redacted.crm.status !== 'available') throw new Error('fixture missing');
    expect(redacted.support.data.tickets[0]?.subject).toBe('[REDACTED]');
    expect(redacted.crm.data.notes[0]).toMatchObject({ authorId: null, body: '[REDACTED]' });
  });
});
