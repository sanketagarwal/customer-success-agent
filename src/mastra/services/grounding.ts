import { evidenceMatchesSource } from '../invariants/index.js';
import type { AccountPlan, Evidence, HealthAssessment, OutreachDraft, SourceSnapshot } from '../schemas/index.js';

export interface GroundingResult {
  grounded: boolean;
  unresolved: string[];
}

function canonicalizeEvidence(evidence: Evidence): Evidence {
  return {
    ...evidence,
    metricOrQuote: `${evidence.ref.source}.${evidence.ref.fieldPath}`,
    value: isPermittedEvidence(evidence) ? evidence.value : '[REDACTED]',
  };
}

const permittedEvidenceFields: Record<Evidence['ref']['source'], ReadonlySet<string>> = {
  usage: new Set(['activeUsers', 'licensedSeats', 'events', 'adoptionRate']),
  support: new Set(['createdAt', 'status', 'priority', 'satisfactionScore', 'resolutionHours']),
  billing: new Set(['asOf', 'standing', 'renewalAt', 'daysPastDue', 'annualValue', 'currency']),
  crm: new Set(['createdAt', 'sentiment']),
};

function formatEvidenceValue(evidence: Evidence): string {
  const { fieldPath } = evidence.ref;
  const { value } = evidence;
  if (fieldPath === 'adoptionRate' && typeof value === 'number') return `${Math.round(value * 100)}%`;
  if (fieldPath === 'standing' && typeof value === 'string') return value.replaceAll('_', ' ');
  if (fieldPath.endsWith('At') && typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return value.slice(0, 10);
  }
  return String(value);
}

function evidenceLabel(evidence: Evidence): string {
  const labels: Partial<Record<Evidence['ref']['source'], Record<string, string>>> = {
    usage: {
      activeUsers: 'active users',
      licensedSeats: 'licensed seats',
      events: 'product events',
      adoptionRate: 'product adoption',
    },
    support: {
      createdAt: 'support ticket date',
      status: 'support ticket status',
      priority: 'support priority',
      satisfactionScore: 'support satisfaction score',
      resolutionHours: 'support resolution time in hours',
    },
    billing: {
      asOf: 'billing status date',
      standing: 'billing standing',
      renewalAt: 'renewal date',
      daysPastDue: 'days past due',
      annualValue: 'annual contract value',
      currency: 'billing currency',
    },
    crm: {
      createdAt: 'CRM note date',
      sentiment: 'CRM relationship sentiment',
    },
  };
  return labels[evidence.ref.source]?.[evidence.ref.fieldPath] ?? evidence.metricOrQuote;
}

function evidenceNarrative(evidence: readonly Evidence[]): string {
  if (evidence.length === 2 && evidence.every(item => item.ref.fieldPath === 'adoptionRate')) {
    return `Product adoption changed from ${formatEvidenceValue(evidence[0]!)} to ${formatEvidenceValue(evidence[1]!)} during the review window.`;
  }
  const statements = evidence.map(item => `${evidenceLabel(item)} is ${formatEvidenceValue(item)}`);
  const narrative = statements.join('; ');
  return `${narrative.charAt(0).toUpperCase()}${narrative.slice(1)}.`;
}

function actionTitle(action: AccountPlan['actions'][number]): string {
  if (action.evidence.some(item => item.ref.source === 'usage')) {
    return 'Review product adoption signals and recovery steps';
  }
  if (action.evidence.some(item => item.ref.source === 'support')) {
    return 'Resolve the verified support risk';
  }
  if (action.evidence.some(item => item.ref.fieldPath === 'renewalAt')) {
    return 'Align on renewal timing and next steps';
  }
  if (action.evidence.some(item => item.ref.source === 'billing')) {
    return 'Resolve the verified billing risk';
  }
  if (action.evidence.some(item => item.ref.source === 'crm')) {
    return 'Review the verified relationship signal';
  }
  return `Complete verified ${action.owner} follow-up`;
}

function isMeaningfulEvidence(value: Evidence['value']): boolean {
  return value !== null && !(typeof value === 'string' && ['', 'unknown', '[REDACTED]'].includes(value.trim()));
}

function isPermittedEvidence(evidence: Evidence): boolean {
  return permittedEvidenceFields[evidence.ref.source].has(evidence.ref.fieldPath);
}

export function canonicalizeAssessmentNarratives(assessment: HealthAssessment): HealthAssessment {
  const riskFactors = assessment.riskFactors.map(factor => ({
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
    actions: plan.actions.map(action => ({
      ...action,
      evidence: action.evidence.map(canonicalizeEvidence),
      title: actionTitle(action),
      rationale: evidenceNarrative(action.evidence.map(canonicalizeEvidence)),
    })),
  };
}

export function canonicalizeOutreachNarratives(outreach: OutreachDraft): OutreachDraft {
  const claims = outreach.claims.map(claim => ({
    ...claim,
    evidence: claim.evidence.map(canonicalizeEvidence),
    text: evidenceNarrative(claim.evidence.map(canonicalizeEvidence)),
  }));
  return {
    ...outreach,
    subject: 'Account review and next steps',
    body: `Hi — I’d like to check in about a few verified account signals. ${claims.map(claim => claim.text).join(' ')} Could we find a convenient time to align on next steps?`,
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
      isPermittedEvidence(item) &&
      isMeaningfulEvidence(item.value) &&
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

export function checkAssessmentGrounding(assessment: HealthAssessment, snapshot: SourceSnapshot): GroundingResult {
  const canonical = canonicalizeAssessmentNarratives(assessment);
  const unresolved = [
    ...identityErrors(assessment, snapshot),
    ...unresolvedEvidence(assessment.riskFactors, snapshot, 'riskFactors'),
    ...(assessment.summary === canonical.summary ? [] : ['summary']),
    ...assessment.riskFactors.flatMap((factor, index) => [
      ...(factor.title === canonical.riskFactors[index]?.title ? [] : [`riskFactors[${index}].title`]),
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
      ...(action.rationale === canonical.actions[index]?.rationale ? [] : [`actions[${index}].rationale`]),
    ]),
  ];
  return { grounded: unresolved.length === 0, unresolved };
}

export function checkOutreachGrounding(outreach: OutreachDraft, snapshot: SourceSnapshot): GroundingResult {
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
