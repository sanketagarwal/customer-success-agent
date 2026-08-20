import { createScorer } from '@mastra/core/evals';

import type { AccountPlan, HealthAssessment, OutreachDraft, SourceSnapshot } from '../schemas/index.js';
import { checkAssessmentGrounding, checkOutreachGrounding, checkPlanGrounding } from '../services/grounding.js';

export const groundednessScorer = createScorer<
  { snapshot: SourceSnapshot },
  { assessment: HealthAssessment; plan?: AccountPlan; outreach?: OutreachDraft }
>({
  id: 'groundedness',
  description: 'Deterministically verifies that every generated claim resolves to source evidence.',
})
  .generateScore(({ run }) => {
    const checks = [checkAssessmentGrounding(run.output.assessment, run.input!.snapshot)];
    if (run.output.plan) checks.push(checkPlanGrounding(run.output.plan, run.input!.snapshot));
    if (run.output.outreach) checks.push(checkOutreachGrounding(run.output.outreach, run.input!.snapshot));
    return checks.every(check => check.grounded) ? 1 : 0;
  })
  .generateReason(({ run, score }) =>
    score === 1
      ? 'Every evidence reference resolved in the source snapshot.'
      : `Unresolved evidence: ${[
          ...checkAssessmentGrounding(run.output.assessment, run.input!.snapshot).unresolved,
          ...(run.output.plan ? checkPlanGrounding(run.output.plan, run.input!.snapshot).unresolved : []),
          ...(run.output.outreach ? checkOutreachGrounding(run.output.outreach, run.input!.snapshot).unresolved : []),
        ].join(', ')}`,
  );

export const riskFactorExtractionScorer = createScorer<{ expectedFactorIds: string[] }, HealthAssessment>({
  id: 'risk-factor-extraction',
  description: 'Measures expected risk-factor recall without rewarding unsupported extras.',
}).generateScore(({ run }) => {
  const actual = new Set(run.output.riskFactors.map(factor => factor.id));
  const expected = new Set(run.input!.expectedFactorIds);
  if (expected.size === 0) return actual.size === 0 ? 1 : 0;
  const truePositives = [...expected].filter(id => actual.has(id)).length;
  const extras = [...actual].filter(id => !expected.has(id)).length;
  return Math.max(0, (truePositives - extras) / expected.size);
});

export const accountPlanQualityScorer = createScorer<HealthAssessment, AccountPlan>({
  id: 'account-plan-quality',
  description: 'Checks risk coverage, ownership, due dates, and evidence-backed action quality.',
}).generateScore(({ run }) => {
  if (run.output.actions.length === 0) return 0;
  const factorRefs = run.input!.riskFactors.map(
    factor => new Set(factor.evidence.map(item => JSON.stringify(item.ref))),
  );
  const coveredFactors = factorRefs.filter(refs =>
    run.output.actions.some(action => action.evidence.some(item => refs.has(JSON.stringify(item.ref)))),
  ).length;
  const factorCoverage = factorRefs.length === 0 ? 0 : coveredFactors / factorRefs.length;
  const validActions = run.output.actions.filter(action => {
    const matchingFactor = run.input!.riskFactors.find(factor =>
      action.evidence.some(item =>
        factor.evidence.some(factorEvidence => JSON.stringify(factorEvidence.ref) === JSON.stringify(item.ref)),
      ),
    );
    const expectedOwner =
      matchingFactor?.category === 'billing' ? 'billing' : matchingFactor?.category === 'support' ? 'support' : 'csm';
    return (
      action.title.trim().length >= 12 &&
      action.rationale.trim().length >= 8 &&
      action.evidence.length > 0 &&
      Date.parse(action.dueAt) >= Date.parse(run.input!.asOf) &&
      action.owner === expectedOwner
    );
  }).length;
  return (factorCoverage + validActions / run.output.actions.length) / 2;
});

export const personalizationScorer = createScorer<HealthAssessment, OutreachDraft>({
  id: 'outreach-personalization',
  description: 'Checks that outreach explicitly incorporates every account risk through grounded claims.',
}).generateScore(({ run }) => {
  if (run.output.claims.length === 0 || run.output.body.length < 40 || !run.output.draftOnly) return 0;
  const claimRefs = new Set(run.output.claims.flatMap(claim => claim.evidence.map(item => JSON.stringify(item.ref))));
  const riskRefs = run.input!.riskFactors.flatMap(factor => factor.evidence.map(item => JSON.stringify(item.ref)));
  const risksCovered = riskRefs.length > 0 && riskRefs.every(ref => claimRefs.has(ref));
  const claimsUsed = run.output.claims.every(claim => run.output.body.includes(claim.text));
  return risksCovered && claimsUsed ? 1 : 0;
});

export const actionRelevanceScorer = createScorer<HealthAssessment, AccountPlan>({
  id: 'action-relevance',
  description: 'Measures whether plan actions map to identified account risks.',
}).generateScore(({ run }) => {
  const factorRefs = new Set(
    run.input!.riskFactors.flatMap(factor => factor.evidence.map(item => JSON.stringify(item.ref))),
  );
  const relevant = run.output.actions.filter(action =>
    action.evidence.some(item => factorRefs.has(JSON.stringify(item.ref))),
  ).length;
  return run.output.actions.length === 0 ? 0 : relevant / run.output.actions.length;
});
