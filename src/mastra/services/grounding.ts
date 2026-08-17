import { canonicalJson, evidenceMatchesSource } from '../invariants/index.js';
import type {
  AccountPlan,
  Evidence,
  HealthAssessment,
  OutreachDraft,
  SourceSnapshot,
} from '../schemas/index.js';

export interface GroundingResult {
  grounded: boolean;
  unresolved: string[];
}

function evidenceFact(evidence: Evidence): string {
  return `${evidence.ref.source}.${evidence.ref.fieldPath}=${canonicalJson(evidence.value)}`;
}

function canonicalizeEvidence(evidence: Evidence): Evidence {
  return {
    ...evidence,
    metricOrQuote: `${evidence.ref.source}.${evidence.ref.fieldPath}`,
  };
}

function evidenceNarrative(evidence: readonly Evidence[]): string {
  return evidence.map(evidenceFact).join('; ');
}

export function canonicalizeAssessmentNarratives(
  assessment: HealthAssessment,
): HealthAssessment {
  const riskFactors = assessment.riskFactors.map((factor) => ({
    ...factor,
    evidence: factor.evidence.map(canonicalizeEvidence),
    title: `Verified ${factor.category} risk (${factor.severity})`,
    explanation: evidenceNarrative(factor.evidence.map(canonicalizeEvidence)),
  }));
  return {
    ...assessment,
    summary: `${riskFactors.length} verified risk factor${riskFactors.length === 1 ? '' : 's'}; health is ${assessment.status} with score ${assessment.score}.`,
    riskFactors,
  };
}

export function canonicalizePlanNarratives(plan: AccountPlan): AccountPlan {
  return {
    ...plan,
    objective: 'Address the verified account risks before the next customer checkpoint.',
    actions: plan.actions.map((action) => ({
      ...action,
      evidence: action.evidence.map(canonicalizeEvidence),
      title: `Complete evidence-backed ${action.owner} follow-up`,
      rationale: evidenceNarrative(action.evidence.map(canonicalizeEvidence)),
    })),
  };
}

export function canonicalizeOutreachNarratives(outreach: OutreachDraft): OutreachDraft {
  const claims = outreach.claims.map((claim) => ({
    ...claim,
    evidence: claim.evidence.map(canonicalizeEvidence),
    text: evidenceNarrative(claim.evidence.map(canonicalizeEvidence)),
  }));
  return {
    ...outreach,
    subject: 'Account review and next steps',
    body: `Hi — I’d like to review these verified account signals with you: ${claims.map((claim) => claim.text).join('; ')}. Please let me know a convenient time to align on next steps.`,
    claims,
  };
}

function unresolvedEvidence(
  entries: readonly { evidence: readonly Evidence[] }[],
  snapshot: SourceSnapshot,
  prefix: string,
): string[] {
  return entries.flatMap((entry, entryIndex) =>
    entry.evidence.flatMap((item, evidenceIndex) =>
      evidenceMatchesSource(item, snapshot) &&
      item.metricOrQuote === `${item.ref.source}.${item.ref.fieldPath}`
        ? []
        : [`${prefix}[${entryIndex}].evidence[${evidenceIndex}]`],
    ),
  );
}

function identityErrors(
  artifact: { tenantId: string; accountId: string; asOf: string },
  snapshot: SourceSnapshot,
): string[] {
  return [
    ...(artifact.tenantId === snapshot.tenantId ? [] : ['tenantId']),
    ...(artifact.accountId === snapshot.accountId ? [] : ['accountId']),
    ...(artifact.asOf === snapshot.window.end ? [] : ['asOf']),
  ];
}

export function checkAssessmentGrounding(
  assessment: HealthAssessment,
  snapshot: SourceSnapshot,
): GroundingResult {
  const canonical = canonicalizeAssessmentNarratives(assessment);
  const unresolved = [
    ...identityErrors(assessment, snapshot),
    ...unresolvedEvidence(assessment.riskFactors, snapshot, 'riskFactors'),
    ...(assessment.summary === canonical.summary ? [] : ['summary']),
    ...assessment.riskFactors.flatMap((factor, index) => [
      ...(factor.title === canonical.riskFactors[index]?.title
        ? []
        : [`riskFactors[${index}].title`]),
      ...(factor.explanation === canonical.riskFactors[index]?.explanation
        ? []
        : [`riskFactors[${index}].explanation`]),
    ]),
  ];
  return { grounded: unresolved.length === 0, unresolved };
}

export function checkPlanGrounding(plan: AccountPlan, snapshot: SourceSnapshot): GroundingResult {
  const canonical = canonicalizePlanNarratives(plan);
  const unresolved = [
    ...identityErrors(plan, snapshot),
    ...unresolvedEvidence(plan.actions, snapshot, 'actions'),
    ...(plan.objective === canonical.objective ? [] : ['objective']),
    ...plan.actions.flatMap((action, index) => [
      ...(action.title === canonical.actions[index]?.title ? [] : [`actions[${index}].title`]),
      ...(action.rationale === canonical.actions[index]?.rationale
        ? []
        : [`actions[${index}].rationale`]),
    ]),
  ];
  return { grounded: unresolved.length === 0, unresolved };
}

export function checkOutreachGrounding(
  outreach: OutreachDraft,
  snapshot: SourceSnapshot,
): GroundingResult {
  const canonical = canonicalizeOutreachNarratives(outreach);
  const unresolved = [
    ...identityErrors(outreach, snapshot),
    ...unresolvedEvidence(outreach.claims, snapshot, 'claims'),
    ...(outreach.subject === canonical.subject ? [] : ['subject']),
    ...(outreach.body === canonical.body ? [] : ['body']),
    ...outreach.claims.flatMap((claim, index) =>
      claim.text === canonical.claims[index]?.text ? [] : [`claims[${index}].text`],
    ),
  ];
  return { grounded: unresolved.length === 0, unresolved };
}
