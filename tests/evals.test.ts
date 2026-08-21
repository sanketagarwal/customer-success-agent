import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FixtureConnector } from '../src/mastra/connectors.js';
import { prepareReview } from '../src/mastra/review.js';
import {
  accountPlanQualityScorer,
  actionRelevanceScorer,
  personalizationScorer,
  riskFactorExtractionScorer,
  unsupportedClaimScorer,
} from '../src/mastra/scorers.js';
import { collectAccountData } from '../src/mastra/workflows.js';
import { fixtureReviewer } from './fixtures.js';

describe('customer-success evals', () => {
  it('accepts grounded output and rejects unsupported, generic, or misrouted output', async () => {
    const connector = new FixtureConnector(resolve('data/fixtures/accounts.json'));
    const window = { start: '2026-07-20T09:00:00.000Z', end: '2026-08-17T09:00:00.000Z' };
    const source = await collectAccountData(connector, 'demo-tenant', '340734348989', window);
    const healthySource = await collectAccountData(connector, 'demo-tenant', '340739743463', window);
    const risk = (await prepareReview(source, fixtureReviewer, null)).review;
    const healthy = (await prepareReview(healthySource, fixtureReviewer, null)).review;

    const positive = await Promise.all([
      riskFactorExtractionScorer.run({ input: { expected: [] }, output: healthy.assessment }),
      riskFactorExtractionScorer.run({
        input: { expected: ['adoption', 'support', 'billing', 'relationship'] },
        output: risk.assessment,
      }),
      unsupportedClaimScorer.run({ input: source, output: risk }),
      accountPlanQualityScorer.run({ input: risk.assessment, output: risk.plan }),
      personalizationScorer.run({ input: risk.assessment, output: risk.outreach }),
      actionRelevanceScorer.run({ input: risk.assessment, output: risk.plan }),
    ]);
    expect(positive.map(result => result.score)).toEqual([1, 1, 1, 1, 1, 1]);

    const unsupported = structuredClone(risk);
    unsupported.assessment.risks[0]!.evidence[0]!.value = 999;
    const irrelevant = structuredClone(risk.plan);
    irrelevant.actions.forEach(action => action.evidence.forEach(item => { item.recordId = `fake-${item.recordId}`; }));
    const generic = { ...risk.outreach, claims: [] };
    const wrongOwners = structuredClone(risk.plan);
    wrongOwners.actions.forEach(action => { action.owner = 'customer'; });
    const negative = await Promise.all([
      unsupportedClaimScorer.run({ input: source, output: unsupported }),
      actionRelevanceScorer.run({ input: risk.assessment, output: irrelevant }),
      personalizationScorer.run({ input: risk.assessment, output: generic }),
      accountPlanQualityScorer.run({ input: risk.assessment, output: wrongOwners }),
    ]);
    expect(negative.map(result => result.score)).toEqual([0, 0, 0, 0]);
  });
});
