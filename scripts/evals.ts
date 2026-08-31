import { resolve } from 'node:path';
import { FixtureDataSource } from '../src/mastra/data.js';
import { ReviewHistory } from '../src/mastra/history.js';
import type { Review } from '../src/mastra/schemas.js';
import { accountPlanQualityScorer, actionRelevanceScorer, personalizationScorer, riskFactorExtractionScorer, unsupportedClaimScorer } from '../src/mastra/scorers.js';
import { assess } from '../src/mastra/workflows/account.js';
const fixtures = new FixtureDataSource(resolve('data/fixtures/accounts.json'));
const cases = [
  ['340739743463', 'no_action'],
  ['340734348989', 'awaiting_approval'],
  ['340737895140', 'insufficient_data'],
] as const;
const scorers = [riskFactorExtractionScorer, accountPlanQualityScorer, unsupportedClaimScorer, personalizationScorer, actionRelevanceScorer];
const evaluated: Review[] = [];
for (const [accountId, expectedOutcome] of cases) {
  const account = await fixtures.getAccount(accountId);
  if (!account) throw new Error(`Missing eval fixture ${accountId}`);
  const review = assess(account, `eval-${accountId}`, 70);
  evaluated.push(review);
  if (review.outcome !== expectedOutcome) throw new Error(`${accountId}: expected ${expectedOutcome}, received ${review.outcome}`);
  for (const scorer of scorers) {
    const result = await scorer.run({ input: review, output: review });
    if ((result.score ?? 0) < 0.8) throw new Error(`${accountId}: ${scorer.id} scored ${result.score}`);
  }
}
const atRisk = evaluated.find((review) => review.outcome === 'awaiting_approval')!;
const history = new ReviewHistory(':memory:');
await history.record(atRisk);
if ((await history.previousScore(atRisk.accountId, 'next-run')) !== atRisk.score) throw new Error('Risk-score history did not persist');
let writes = 0;
const write = () => Promise.resolve({ writeId: `write-${++writes}`, taskIds: [] });
await history.writeOnce(atRisk.runId, write);
await history.writeOnce(atRisk.runId, write);
if (writes !== 1) throw new Error('Durable write idempotency failed');
const dashboard = await history.dashboard(atRisk.accountId);
if (dashboard.reviews !== 1 || dashboard.alerts.length !== 1) throw new Error('Monitoring aggregation failed');
console.log(`${cases.length} fixtures passed ${scorers.length} evals each plus persistence checks.`);
