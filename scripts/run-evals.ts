import { createFixtureRuntime } from '../src/mastra/adapters/fixture/fixture-runtime.js';
import {
  accountPlanQualityScorer,
  actionRelevanceScorer,
  groundednessScorer,
  personalizationScorer,
  riskFactorExtractionScorer,
} from '../src/mastra/scorers/index.js';

const runtime = createFixtureRuntime();
const tenantId = 'demo-tenant';
const window = {
  start: new Date(Date.parse(runtime.asOf) - 28 * 86_400_000).toISOString(),
  end: runtime.asOf,
};

const healthy = await runtime.service.prepare({
  runId: 'eval-healthy',
  tenantId,
  accountId: '340739743463',
  asOf: runtime.asOf,
});
const atRisk = await runtime.service.prepare({
  runId: 'eval-at-risk',
  tenantId,
  accountId: '340734348989',
  asOf: runtime.asOf,
});
if (!healthy.assessment || !atRisk.assessment || !atRisk.plan || !atRisk.outreach) {
  throw new Error('Fixture eval artifacts were incomplete');
}
const snapshot = await runtime.service.collect(tenantId, atRisk.accountId, window);

const positive = {
  healthyRiskExtraction: await riskFactorExtractionScorer.run({
    input: { expectedFactorIds: [] },
    output: healthy.assessment,
  }),
  atRiskRiskExtraction: await riskFactorExtractionScorer.run({
    input: {
      expectedFactorIds: ['declining-adoption', 'urgent-support-issue', 'billing-risk', 'negative-relationship-signal'],
    },
    output: atRisk.assessment,
  }),
  groundedness: await groundednessScorer.run({
    input: { snapshot },
    output: { assessment: atRisk.assessment, plan: atRisk.plan, outreach: atRisk.outreach },
  }),
  accountPlanQuality: await accountPlanQualityScorer.run({
    input: atRisk.assessment,
    output: atRisk.plan,
  }),
  personalization: await personalizationScorer.run({
    input: atRisk.assessment,
    output: atRisk.outreach,
  }),
  actionRelevance: await actionRelevanceScorer.run({
    input: atRisk.assessment,
    output: atRisk.plan,
  }),
};

const unsupportedAssessment = structuredClone(atRisk.assessment);
unsupportedAssessment.riskFactors[0]!.evidence[0]!.value = 999;
const irrelevantPlan = structuredClone(atRisk.plan);
for (const action of irrelevantPlan.actions) {
  for (const item of action.evidence) item.ref.recordId = `fabricated-${item.ref.recordId}`;
}
const genericOutreach = structuredClone(atRisk.outreach);
genericOutreach.body =
  'Hello customer, this is a generic check-in that does not mention any verified account-specific claim.';

const negative = {
  unsupportedClaim: await groundednessScorer.run({
    input: { snapshot },
    output: { assessment: unsupportedAssessment },
  }),
  genericPersonalization: await personalizationScorer.run({
    input: atRisk.assessment,
    output: genericOutreach,
  }),
  irrelevantActions: await actionRelevanceScorer.run({
    input: atRisk.assessment,
    output: irrelevantPlan,
  }),
};

const positiveScores = Object.fromEntries(Object.entries(positive).map(([name, result]) => [name, result.score]));
const negativeScores = Object.fromEntries(Object.entries(negative).map(([name, result]) => [name, result.score]));
const failedPositive = Object.entries(positiveScores).filter(([, score]) => score < 1);
const failedNegative = Object.entries(negativeScores).filter(([, score]) => score !== 0);

console.log(JSON.stringify({ thresholds: { positive: 1, negative: 0 }, positiveScores, negativeScores }, null, 2));
if (failedPositive.length > 0 || failedNegative.length > 0) {
  throw new Error(`Eval gates failed: ${JSON.stringify({ failedPositive, failedNegative })}`);
}
