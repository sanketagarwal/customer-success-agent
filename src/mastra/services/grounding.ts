import { evidenceResolves } from '../invariants/index.js';
import type {
  AccountPlan,
  HealthAssessment,
  OutreachDraft,
  SourceSnapshot,
} from '../schemas/index.js';

export interface GroundingResult {
  grounded: boolean;
  unresolved: string[];
}

function unresolvedEvidence(
  entries: readonly { evidence: readonly { ref: Parameters<typeof evidenceResolves>[0] }[] }[],
  snapshot: SourceSnapshot,
  prefix: string,
): string[] {
  return entries.flatMap((entry, entryIndex) =>
    entry.evidence.flatMap((item, evidenceIndex) =>
      evidenceResolves(item.ref, snapshot) ? [] : [`${prefix}[${entryIndex}].evidence[${evidenceIndex}]`],
    ),
  );
}

export function checkAssessmentGrounding(
  assessment: HealthAssessment,
  snapshot: SourceSnapshot,
): GroundingResult {
  const unresolved = unresolvedEvidence(assessment.riskFactors, snapshot, 'riskFactors');
  return { grounded: unresolved.length === 0, unresolved };
}

export function checkPlanGrounding(plan: AccountPlan, snapshot: SourceSnapshot): GroundingResult {
  const unresolved = unresolvedEvidence(plan.actions, snapshot, 'actions');
  return { grounded: unresolved.length === 0, unresolved };
}

export function checkOutreachGrounding(
  outreach: OutreachDraft,
  snapshot: SourceSnapshot,
): GroundingResult {
  const unresolved = unresolvedEvidence(outreach.claims, snapshot, 'claims');
  return { grounded: unresolved.length === 0, unresolved };
}
