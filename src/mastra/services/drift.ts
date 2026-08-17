import type { AccountMemory, Drift, HealthAssessment, RiskFactor } from '../schemas/index.js';

const severityRank: Record<RiskFactor['severity'], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function calculateDrift(current: HealthAssessment, memory: AccountMemory | null): Drift {
  const previousEntry = memory?.assessments.at(-1);
  if (!previousEntry) {
    return {
      baseline: true,
      previousAsOf: null,
      currentAsOf: current.asOf,
      scoreDelta: 0,
      direction: 'baseline',
      factorChanges: current.riskFactors.map((factor) => ({ factorId: factor.id, status: 'new' })),
    };
  }

  const previous = previousEntry.assessment;
  const previousById = new Map(previous.riskFactors.map((factor) => [factor.id, factor]));
  const currentById = new Map(current.riskFactors.map((factor) => [factor.id, factor]));
  const factorChanges: Drift['factorChanges'] = [];

  for (const factor of current.riskFactors) {
    const prior = previousById.get(factor.id);
    factorChanges.push({
      factorId: factor.id,
      status: !prior
        ? 'new'
        : severityRank[factor.severity] > severityRank[prior.severity]
          ? 'worsening'
          : severityRank[factor.severity] < severityRank[prior.severity]
            ? 'improving'
            : 'persistent',
    });
  }
  for (const factor of previous.riskFactors) {
    if (!currentById.has(factor.id)) factorChanges.push({ factorId: factor.id, status: 'resolved' });
  }

  const scoreDelta = current.score - previous.score;
  return {
    baseline: false,
    previousAsOf: previous.asOf,
    currentAsOf: current.asOf,
    scoreDelta,
    direction: scoreDelta >= 5 ? 'improving' : scoreDelta <= -5 ? 'worsening' : 'stable',
    factorChanges,
  };
}

export function applyFactorStatuses(
  assessment: HealthAssessment,
  drift: Drift,
): HealthAssessment {
  const statuses = new Map(drift.factorChanges.map((change) => [change.factorId, change.status]));
  return {
    ...assessment,
    riskFactors: assessment.riskFactors.map((factor) => ({
      ...factor,
      status: statuses.get(factor.id) ?? factor.status,
    })),
  };
}
