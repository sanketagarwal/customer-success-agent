import { createHash } from 'node:crypto';

import type { Reviewer } from './reviewer.js';
import {
  reviewSchema,
  type Assessment,
  type Evidence,
  type GeneratedReview,
  type Review,
  type Snapshot,
} from './schemas.js';

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
};

export const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

export function snapshotHash(snapshot: Snapshot) {
  const withoutWindow = (result: Snapshot['usage'] | Snapshot['support'] | Snapshot['billing'] | Snapshot['crm']) => {
    if (result.status !== 'available' || !('window' in result.data)) return result;
    const { window: _window, ...data } = result.data;
    return { status: 'available', data };
  };
  return hash({
    tenantId: snapshot.tenantId,
    accountId: snapshot.accountId,
    usage: withoutWindow(snapshot.usage),
    support: withoutWindow(snapshot.support),
    billing: withoutWindow(snapshot.billing),
    crm: withoutWindow(snapshot.crm),
  });
}

const permitted: Record<Evidence['source'], ReadonlySet<string>> = {
  usage: new Set(['activeUsers', 'licensedSeats', 'events', 'adoptionRate']),
  support: new Set(['createdAt', 'status', 'priority', 'satisfactionScore', 'resolutionHours']),
  billing: new Set(['asOf', 'standing', 'renewalAt', 'daysPastDue', 'annualValue', 'currency']),
  crm: new Set(['createdAt', 'sentiment']),
};

function records(snapshot: Snapshot, source: Evidence['source']): readonly Record<string, unknown>[] {
  if (source === 'usage' && snapshot.usage.status === 'available') return snapshot.usage.data.points;
  if (source === 'support' && snapshot.support.status === 'available') return snapshot.support.data.tickets;
  if (source === 'billing' && snapshot.billing.status === 'available') return [snapshot.billing.data];
  if (source === 'crm' && snapshot.crm.status === 'available') return snapshot.crm.data.notes;
  return [];
}

export function evidenceIsGrounded(item: Evidence, snapshot: Snapshot) {
  if (!permitted[item.source].has(item.field) || item.value == null || item.value === 'unknown') return false;
  const record = records(snapshot, item.source).find(candidate => candidate.recordId === item.recordId);
  return record !== undefined && Object.is(record[item.field], item.value);
}

const format = (item: Evidence) => {
  if (item.field === 'adoptionRate' && typeof item.value === 'number') return `${Math.round(item.value * 100)}%`;
  if (item.field.endsWith('At') && typeof item.value === 'string') return item.value.slice(0, 10);
  return String(item.value).replaceAll('_', ' ');
};

const label = (item: Evidence) => ({
  activeUsers: 'active users',
  licensedSeats: 'licensed seats',
  events: 'product events',
  adoptionRate: 'product adoption',
  createdAt: `${item.source} date`,
  status: 'support ticket status',
  priority: 'support priority',
  satisfactionScore: 'support satisfaction',
  resolutionHours: 'support resolution hours',
  asOf: 'billing date',
  standing: 'billing standing',
  renewalAt: 'renewal date',
  daysPastDue: 'days past due',
  annualValue: 'annual contract value',
  currency: 'currency',
  sentiment: 'relationship sentiment',
})[item.field] ?? item.field;

const narrative = (items: readonly Evidence[]) => {
  if (items.length === 2 && items.every(item => item.field === 'adoptionRate')) {
    return `Product adoption moved from ${format(items[0]!)} to ${format(items[1]!)}.`;
  }
  const sentence = items.map(item => `${label(item)} is ${format(item)}`).join('; ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
};

const actionTitle = (evidence: readonly Evidence[]) => {
  if (evidence.some(item => item.source === 'usage')) return 'Review product adoption and recovery steps';
  if (evidence.some(item => item.source === 'support')) return 'Resolve the urgent support issue';
  if (evidence.some(item => item.field === 'renewalAt')) return 'Align on renewal timing and next steps';
  if (evidence.some(item => item.source === 'billing')) return 'Resolve the billing risk';
  return 'Review the relationship signal with the account team';
};

export function canonicalReview(generated: GeneratedReview, snapshot: Snapshot, previous: Review | null): Review {
  const assessment: Assessment = {
    ...generated.assessment,
    tenantId: snapshot.tenantId,
    accountId: snapshot.accountId,
    asOf: snapshot.window.end,
    sourceHash: snapshotHash(snapshot),
    summary: generated.assessment.riskFactors.length
      ? `${generated.assessment.riskFactors.length} verified risk factor(s); account health is ${generated.assessment.status} at ${generated.assessment.score}/100.`
      : `No verified churn risks were found; account health is ${generated.assessment.status} at ${generated.assessment.score}/100.`,
    riskFactors: generated.assessment.riskFactors.map(risk => ({
      ...risk,
      status: 'new',
      title: `Verified ${risk.category} risk (${risk.severity})`,
      explanation: narrative(risk.evidence),
    })),
  };
  const previousScore = previous?.assessment.score ?? null;
  const scoreDelta = previousScore === null ? 0 : assessment.score - previousScore;
  const plan = {
    objective: 'Address verified account risks before the next customer checkpoint.',
    actions: generated.plan.actions.map(action => ({
      ...action,
      title: actionTitle(action.evidence),
      rationale: narrative(action.evidence),
    })),
  };
  const claims = generated.outreach.claims.map(claim => ({ ...claim, text: narrative(claim.evidence) }));
  return reviewSchema.parse({
    assessment,
    drift: {
      previousScore,
      scoreDelta,
      direction: previousScore === null ? 'baseline' : scoreDelta >= 5 ? 'improving' : scoreDelta <= -5 ? 'worsening' : 'stable',
    },
    plan,
    outreach: {
      ...generated.outreach,
      subject: 'Account review and next steps',
      body: claims.length
        ? `Hi — I’d like to check in about a few account signals. ${claims.map(claim => claim.text).join(' ')} Could we align on next steps?`
        : 'Hi — I would like to check in and make sure your current priorities are on track.',
      claims,
      draftOnly: true,
    },
  });
}

export function groundingErrors(review: Review, snapshot: Snapshot) {
  const groups = [
    ...review.assessment.riskFactors.map((risk, index) => [`riskFactors[${index}]`, risk.evidence] as const),
    ...review.plan.actions.map((action, index) => [`actions[${index}]`, action.evidence] as const),
    ...review.outreach.claims.map((claim, index) => [`claims[${index}]`, claim.evidence] as const),
  ];
  const errors = groups.flatMap(([name, evidence]) =>
    evidence.flatMap((item, index) => evidenceIsGrounded(item, snapshot) ? [] : [`${name}.evidence[${index}]`]),
  );
  const riskEvidence = new Set(review.assessment.riskFactors.flatMap(risk => risk.evidence.map(hash)));
  review.plan.actions.forEach((action, index) => {
    if (!action.evidence.some(item => riskEvidence.has(hash(item)))) errors.push(`actions[${index}].relevance`);
  });
  review.outreach.claims.forEach((claim, index) => {
    if (!claim.evidence.some(item => riskEvidence.has(hash(item)))) errors.push(`claims[${index}].relevance`);
  });
  for (const [index, risk] of review.assessment.riskFactors.entries()) {
    const evidence = new Set(risk.evidence.map(hash));
    if (!review.plan.actions.some(action => action.evidence.some(item => evidence.has(hash(item))))) {
      errors.push(`riskFactors[${index}].planCoverage`);
    }
    if (!review.outreach.claims.some(claim => claim.evidence.some(item => evidence.has(hash(item))))) {
      errors.push(`riskFactors[${index}].outreachCoverage`);
    }
  }
  return errors;
}

export async function prepareReview(snapshot: Snapshot, reviewer: Reviewer, previous: Review | null) {
  const generated = await reviewer.review(snapshot);
  const review = canonicalReview(generated.review, snapshot, previous);
  return { review, usage: generated.usage, errors: groundingErrors(review, snapshot) };
}
