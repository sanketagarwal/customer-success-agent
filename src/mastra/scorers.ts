import { createScorer } from '@mastra/core/evals';

import { groundingIssues, hash } from './review.js';
import type { Review, Snapshot } from './schemas.js';

const refs = (items: readonly { evidence: readonly unknown[] }[]) =>
  new Set(items.flatMap(item => item.evidence.map(hash)));

export const unsupportedClaimScorer = createScorer<Snapshot, Review>({
  id: 'unsupported-claim-detection',
  description: 'Rejects unsupported or irrelevant risks, actions, and outreach claims.',
}).generateScore(({ run }) => !run.input || groundingIssues(run.output, run.input).length ? 0 : 1);

export const riskFactorExtractionScorer = createScorer<{ expected: string[] }, Review['assessment']>({
  id: 'risk-factor-extraction',
  description: 'Measures expected risk-category extraction.',
}).generateScore(({ run }) => {
  if (!run.input) return 0;
  const actual = new Set<string>(run.output.risks.map(risk => risk.category));
  return run.input.expected.length
    ? run.input.expected.filter(category => actual.has(category)).length / run.input.expected.length
    : Number(actual.size === 0);
});

const ownerFor = (category: string) => category === 'billing' ? 'billing' : category === 'support' ? 'support' : 'csm';
export const accountPlanQualityScorer = createScorer<Review['assessment'], Review['plan']>({
  id: 'account-plan-quality',
  description: 'Checks coverage, ownership, deadlines, and evidence.',
}).generateScore(({ run }) => {
  if (!run.input) return 0;
  return Number(run.input.risks.every(risk => {
    const evidence = new Set(risk.evidence.map(hash));
    return run.output.actions.some(action =>
      action.owner === ownerFor(risk.category) && action.evidence.some(item => evidence.has(hash(item))),
    );
  }) && run.output.actions.every(action => Boolean(Date.parse(action.dueAt)) && action.evidence.length));
});

export const personalizationScorer = createScorer<Review['assessment'], Review['outreach']>({
  id: 'outreach-personalization',
  description: 'Checks that outreach contains grounded account signals.',
}).generateScore(({ run }) => Number(
  run.input && (run.input.risks.length === 0 || (run.output.claims.length > 0 && run.output.body.length > 80)),
));

export const actionRelevanceScorer = createScorer<Review['assessment'], Review['plan']>({
  id: 'action-relevance',
  description: 'Checks that every action is tied to risk evidence.',
}).generateScore(({ run }) => {
  if (!run.input) return 0;
  const evidence = refs(run.input.risks);
  return Number(run.output.actions.every(action => action.evidence.some(item => evidence.has(hash(item)))));
});
