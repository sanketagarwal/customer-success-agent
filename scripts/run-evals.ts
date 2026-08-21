import { resolve } from 'node:path';

import { FixtureConnector } from '../src/mastra/connectors.js';
import { prepareReview } from '../src/mastra/customer-success.js';
import { FixtureReviewer } from '../src/mastra/reviewer.js';
import {
  accountPlanQualityScorer,
  actionRelevanceScorer,
  personalizationScorer,
  riskFactorExtractionScorer,
  unsupportedClaimScorer,
} from '../src/mastra/scorers.js';
import { collectAccountData } from '../src/mastra/workflows.js';

const connectors = new FixtureConnector(resolve('data/fixtures/accounts.json'));
const window = { start: '2026-07-20T09:00:00.000Z', end: '2026-08-17T09:00:00.000Z' };
const source = await collectAccountData(connectors, 'demo-tenant', '340734348989', window);
const healthySource = await collectAccountData(connectors, 'demo-tenant', '340739743463', window);
const risk = (await prepareReview(source, new FixtureReviewer(), null)).review;
const healthy = (await prepareReview(healthySource, new FixtureReviewer(), null)).review;

const positive = {
  healthyRisks: await riskFactorExtractionScorer.run({ input: { expected: [] }, output: healthy.assessment }),
  atRiskRisks: await riskFactorExtractionScorer.run({
    input: { expected: ['declining-adoption', 'urgent-support-issue', 'billing-risk', 'negative-relationship-signal'] },
    output: risk.assessment,
  }),
  unsupportedClaims: await unsupportedClaimScorer.run({ input: source, output: risk }),
  planQuality: await accountPlanQualityScorer.run({ input: risk.assessment, output: risk.plan }),
  personalization: await personalizationScorer.run({ input: risk.assessment, output: risk.outreach }),
  actionRelevance: await actionRelevanceScorer.run({ input: risk.assessment, output: risk.plan }),
};

const unsupported = structuredClone(risk);
unsupported.assessment.riskFactors[0]!.evidence[0]!.value = 999;
const irrelevant = structuredClone(risk.plan);
irrelevant.actions.forEach(action => action.evidence.forEach(item => { item.recordId = `fake-${item.recordId}`; }));
const generic = { ...risk.outreach, claims: [] };
const wrongOwners = structuredClone(risk.plan);
wrongOwners.actions.forEach(action => { action.owner = 'customer'; });
const negative = {
  unsupportedClaim: await unsupportedClaimScorer.run({ input: source, output: unsupported }),
  irrelevantActions: await actionRelevanceScorer.run({ input: risk.assessment, output: irrelevant }),
  genericOutreach: await personalizationScorer.run({ input: risk.assessment, output: generic }),
  wrongOwners: await accountPlanQualityScorer.run({ input: risk.assessment, output: wrongOwners }),
};

const scores = (results: Record<string, { score: number }>) =>
  Object.fromEntries(Object.entries(results).map(([name, result]) => [name, result.score]));
const report = { positive: scores(positive), negative: scores(negative) };
console.log(JSON.stringify(report, null, 2));
if (Object.values(report.positive).some(score => score !== 1) || Object.values(report.negative).some(score => score !== 0)) {
  throw new Error('Eval thresholds failed');
}
