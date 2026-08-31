import { createScorer } from '@mastra/core/evals';
import type { Review, Risk } from './schemas.js';
const score = (checks: boolean[]) =>
  checks.length === 0 ? 1 : checks.filter(Boolean).length / checks.length;
export const riskFactorExtractionScorer = createScorer<Review, Review>({
  id: 'risk-factor-extraction',
  description: 'Checks that risk factors are specific and evidence-backed.',
}).generateScore(({ run }) =>
  score(run.output.risks.map((risk) => risk.title.length > 8 && risk.evidence.length > 3)),
);
export const accountPlanQualityScorer = createScorer<Review, Review>({
  id: 'account-plan-quality',
  description: 'Checks risk coverage, ownership, and future due dates.',
}).generateScore(({ run }) => {
  if (run.output.risks.length === 0) return run.output.actions.length === 0 ? 1 : 0;
  return score([
    run.output.actions.length === run.output.risks.length,
    ...run.output.actions.map((action) => Date.parse(action.dueAt) > Date.now()),
  ]);
});
export const unsupportedClaimScorer = createScorer<Review, Review>({
  id: 'unsupported-claim-detection',
  description: 'Rejects risk summaries without explicit supporting evidence.',
}).generateScore(({ run }) =>
  score(
    run.output.risks.map(
      (risk) => risk.evidence.trim().length > 0 && run.output.summary.includes(risk.title.toLowerCase()),
    ),
  ),
);
export const personalizationScorer = createScorer<Review, Review>({
  id: 'outreach-personalization',
  description: 'Checks that outreach is account-specific and remains a draft.',
}).generateScore(({ run }) => {
  const outreach = run.output.outreach;
  if (!outreach) return 1;
  return score([
    outreach.subject.includes(run.output.accountName),
    outreach.body.length >= 60,
    outreach.draftOnly,
  ]);
});
const expectedOwner: Record<Risk['category'], string> = {
  usage: 'product',
  support: 'support',
  billing: 'billing',
  crm: 'csm',
};
export const actionRelevanceScorer = createScorer<Review, Review>({
  id: 'action-relevance',
  description: 'Checks that each action owner matches its corresponding risk.',
}).generateScore(({ run }) =>
  score(
    run.output.actions.map(
      (action, index) => action.owner === expectedOwner[run.output.risks[index]?.category ?? 'crm'],
    ),
  ),
);
