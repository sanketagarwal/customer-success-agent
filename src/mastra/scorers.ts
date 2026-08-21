import { createScorer } from '@mastra/core/evals';

import { groundingErrors, hash } from './customer-success.js';
import type { Assessment, Review, Snapshot } from './schemas.js';

const refs = (evidence: readonly { source: string; recordId: string; field: string; value: unknown }[]) =>
  new Set(evidence.map(hash));

export const unsupportedClaimScorer = createScorer<Snapshot, Review>({
  id: 'unsupported-claim-detection',
  description: 'Rejects claims whose evidence does not resolve to source data.',
}).generateScore(({ run }) => groundingErrors(run.output, run.input!).length ? 0 : 1);

export const riskFactorExtractionScorer = createScorer<{ expected: string[] }, Assessment>({
  id: 'risk-factor-extraction',
  description: 'Measures expected risk-factor recall without rewarding unsupported extras.',
}).generateScore(({ run }) => {
  const expected = new Set(run.input!.expected);
  const actual = new Set(run.output.riskFactors.map(risk => risk.id));
  if (!expected.size) return actual.size ? 0 : 1;
  const correct = [...expected].filter(id => actual.has(id)).length;
  const extra = [...actual].filter(id => !expected.has(id)).length;
  return Math.max(0, (correct - extra) / expected.size);
});

export const accountPlanQualityScorer = createScorer<Assessment, Review['plan']>({
  id: 'account-plan-quality',
  description: 'Checks risk coverage, ownership, evidence, and due dates.',
}).generateScore(({ run }) => {
  if (!run.output.actions.length) return run.input!.riskFactors.length ? 0 : 1;
  const risks = run.input!.riskFactors.map(risk => refs(risk.evidence));
  const covered = risks.filter(risk => run.output.actions.some(action =>
    action.evidence.some(item => risk.has(hash(item))),
  )).length;
  const valid = run.output.actions.filter(action => action.evidence.length && Date.parse(action.dueAt) >= Date.parse(run.input!.asOf)).length;
  return ((risks.length ? covered / risks.length : 1) + valid / run.output.actions.length) / 2;
});

export const personalizationScorer = createScorer<Assessment, Review['outreach']>({
  id: 'outreach-personalization',
  description: 'Checks that the outreach draft uses the account’s verified risks.',
}).generateScore(({ run }) => {
  const claims = refs(run.output.claims.flatMap(claim => claim.evidence));
  const risks = run.input!.riskFactors.flatMap(risk => risk.evidence).map(hash);
  return run.output.draftOnly && risks.every(reference => claims.has(reference)) ? 1 : 0;
});

export const actionRelevanceScorer = createScorer<Assessment, Review['plan']>({
  id: 'action-relevance',
  description: 'Measures whether each action maps to an identified risk.',
}).generateScore(({ run }) => {
  const risks = refs(run.input!.riskFactors.flatMap(risk => risk.evidence));
  const relevant = run.output.actions.filter(action => action.evidence.some(item => risks.has(hash(item)))).length;
  return run.output.actions.length ? relevant / run.output.actions.length : run.input!.riskFactors.length ? 0 : 1;
});
