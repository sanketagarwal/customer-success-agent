import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FixtureConnector } from '../src/mastra/connectors.js';
import { buildReview, groundingIssues, prepareReview, redact } from '../src/mastra/review.js';
import { LibSqlState } from '../src/mastra/state.js';
import { collectAccountData } from '../src/mastra/workflows.js';
import { fixtureReviewer } from './fixtures.js';

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
    const result = await prepareReview(source, fixtureReviewer, null);
    expect(result.issues).toEqual([]);
    expect(result.review.assessment.risks).toHaveLength(4);
    expect(result.review.outreach.body).toContain('Product adoption moved from 72% to 31%');

    const unsupported = structuredClone(result.review);
    unsupported.assessment.risks[0]!.evidence[0]!.value = 999;
    expect(groundingIssues(unsupported, source)).toContain('risks[0].evidence[0]');
  });

  it('rejects risky reviews with missing plan or outreach coverage', async () => {
    const source = await snapshot();
    const { proposal } = await fixtureReviewer.review(source);
    proposal.actions = [];
    proposal.claims = [];
    const issues = groundingIssues(buildReview(proposal, source, null), source);
    expect(issues).toContain('risks[0].planCoverage');
    expect(issues).toContain('risks[0].outreachCoverage');
  });

  it('calculates drift from account-scoped state', async () => {
    const source = await snapshot();
    const store = new LibSqlState('file::memory:');
    const first = await prepareReview(source, fixtureReviewer, await store.getReview('demo-tenant', source.accountId));
    await store.saveReview('demo-tenant', source.accountId, first.review);
    const second = await prepareReview(source, fixtureReviewer, await store.getReview('demo-tenant', source.accountId));
    expect(first.review.drift.direction).toBe('baseline');
    expect(second.review.drift).toEqual({
      previousScore: first.review.assessment.score,
      scoreDelta: 0,
      direction: 'stable',
    });
    store.close();
  });

  it('redacts support subjects and CRM note contents before model generation', async () => {
    const redacted = redact(await snapshot());
    if (redacted.support.status !== 'available' || redacted.crm.status !== 'available') throw new Error('fixture missing');
    expect(redacted.support.data[0]?.subject).toBe('[REDACTED]');
    expect(redacted.crm.data[0]?.body).toBe('[REDACTED]');
  });

  it('maps bundled fixture data into a custom runtime tenant', async () => {
    const connectors = new FixtureConnector(resolve('data/fixtures/accounts.json'));
    const source = await collectAccountData(connectors, 'customer-tenant', '340734348989', window);
    expect(source).toMatchObject({ tenantId: 'customer-tenant', usage: { status: 'available' }, billing: { status: 'available' } });
  });
});
