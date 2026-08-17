import type { CustomerSuccessIntelligence, PlanningInput } from '../../ports/index.js';
import type {
  AccountPlan,
  Evidence,
  HealthAssessment,
  OutreachDraft,
  RiskFactor,
  SourceSnapshot,
} from '../../schemas/index.js';

const severityPenalty = { low: 8, medium: 16, high: 28, critical: 42 } as const;

function evidence(
  snapshot: SourceSnapshot,
  source: 'usage' | 'support' | 'billing' | 'crm',
  recordId: string,
  fieldPath: string,
  metricOrQuote: string,
  value: string | number | boolean | null,
): Evidence {
  return {
    ref: { source, recordId, fieldPath, window: snapshot.window },
    metricOrQuote,
    value,
  };
}

function deriveRiskFactors(snapshot: SourceSnapshot): RiskFactor[] {
  const factors: RiskFactor[] = [];

  if (snapshot.usage.status === 'available' && snapshot.usage.data.points.length >= 2) {
    const points = [...snapshot.usage.data.points].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const first = points[0];
    const last = points.at(-1);
    if (first && last && first.adoptionRate - last.adoptionRate >= 0.15) {
      factors.push({
        id: 'declining-adoption',
        category: 'adoption',
        severity: first.adoptionRate - last.adoptionRate >= 0.3 ? 'critical' : 'high',
        status: 'new',
        title: 'Product adoption is declining',
        explanation: `Adoption fell from ${Math.round(first.adoptionRate * 100)}% to ${Math.round(last.adoptionRate * 100)}% in the assessment window.`,
        evidence: [
          evidence(snapshot, 'usage', first.recordId, 'adoptionRate', 'Starting adoption rate', first.adoptionRate),
          evidence(snapshot, 'usage', last.recordId, 'adoptionRate', 'Latest adoption rate', last.adoptionRate),
        ],
      });
    }
  }

  if (snapshot.support.status === 'available') {
    const urgent = snapshot.support.data.tickets.find(
      (ticket) => ticket.priority === 'urgent' && ticket.status !== 'closed' && ticket.status !== 'resolved',
    );
    if (urgent) {
      factors.push({
        id: 'urgent-support-issue',
        category: 'support',
        severity: 'high',
        status: 'new',
        title: 'An urgent support issue remains open',
        explanation: `The urgent ticket “${urgent.subject}” is still ${urgent.status}.`,
        evidence: [evidence(snapshot, 'support', urgent.recordId, 'status', 'Urgent ticket status', urgent.status)],
      });
    }
  }

  if (snapshot.billing.status === 'available' && snapshot.billing.data.standing !== 'current') {
    const billing = snapshot.billing.data;
    factors.push({
      id: 'billing-risk',
      category: 'billing',
      severity: billing.standing === 'delinquent' ? 'critical' : 'high',
      status: 'new',
      title: 'Billing is not current',
      explanation: `The account is ${billing.standing.replace('_', ' ')} with ${billing.daysPastDue} days past due.`,
      evidence: [
        evidence(snapshot, 'billing', billing.recordId, 'standing', 'Billing standing', billing.standing),
        evidence(snapshot, 'billing', billing.recordId, 'daysPastDue', 'Days past due', billing.daysPastDue),
      ],
    });
  }

  if (snapshot.crm.status === 'available') {
    const negative = snapshot.crm.data.notes.find((note) => note.sentiment === 'negative');
    if (negative) {
      factors.push({
        id: 'negative-relationship-signal',
        category: 'relationship',
        severity: 'medium',
        status: 'new',
        title: 'Recent CSM note contains a negative relationship signal',
        explanation: 'A recent CRM note was classified as negative and warrants CSM review.',
        evidence: [evidence(snapshot, 'crm', negative.recordId, 'sentiment', 'CRM note sentiment', negative.sentiment)],
      });
    }
  }

  return factors;
}

function completeness(snapshot: SourceSnapshot): number {
  const results = [snapshot.usage, snapshot.support, snapshot.billing, snapshot.crm];
  return results.filter((result) => result.status === 'available').length / results.length;
}

export class DeterministicCustomerSuccessIntelligence implements CustomerSuccessIntelligence {
  async assess({ snapshot, asOf }: Parameters<CustomerSuccessIntelligence['assess']>[0]) {
    const riskFactors = deriveRiskFactors(snapshot);
    const score = Math.max(
      0,
      100 - riskFactors.reduce((total, factor) => total + severityPenalty[factor.severity], 0),
    );
    const status: HealthAssessment['status'] =
      score >= 80 ? 'healthy' : score >= 60 ? 'watch' : score >= 35 ? 'at_risk' : 'critical';
    return {
      tenantId: snapshot.tenantId,
      accountId: snapshot.accountId,
      asOf,
      score,
      status,
      summary:
        riskFactors.length === 0
          ? 'No evidence-backed churn risks were detected in the current window.'
          : `${riskFactors.length} evidence-backed churn risk${riskFactors.length === 1 ? '' : 's'} require review.`,
      riskFactors,
      dataCompleteness: completeness(snapshot),
    };
  }

  async plan({ assessment, asOf }: PlanningInput): Promise<AccountPlan> {
    const dueAt = new Date(Date.parse(asOf) + 7 * 86_400_000).toISOString();
    return {
      tenantId: assessment.tenantId,
      accountId: assessment.accountId,
      asOf,
      objective: 'Address the verified churn risks before the next customer checkpoint.',
      actions: assessment.riskFactors.map((factor, index) => ({
        id: `action-${index + 1}-${factor.id}`,
        title: `Review and address: ${factor.title}`,
        rationale: factor.explanation,
        owner: factor.category === 'billing' ? 'billing' : factor.category === 'support' ? 'support' : 'csm',
        dueAt,
        priority: factor.severity === 'critical' || factor.severity === 'high' ? 'high' : 'medium',
        evidence: factor.evidence,
      })),
    };
  }

  async draftOutreach({ assessment, plan, asOf }: PlanningInput & { plan: AccountPlan }): Promise<OutreachDraft> {
    const claims = assessment.riskFactors.map((factor) => ({
      text: factor.title,
      evidence: factor.evidence,
    }));
    return {
      tenantId: assessment.tenantId,
      accountId: assessment.accountId,
      asOf,
      channel: 'email',
      subject: 'Checking in on your account priorities',
      body: `Hi — I’d like to review the recent account signals with you and align on next steps. Our draft plan includes ${plan.actions.length} action item${plan.actions.length === 1 ? '' : 's'}. Please let me know a convenient time to connect.`,
      claims,
      draftOnly: true,
    };
  }
}
