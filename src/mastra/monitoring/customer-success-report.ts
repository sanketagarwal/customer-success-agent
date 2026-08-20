import { z } from 'zod';

import type { MonitoringEvent } from '../schemas/index.js';

const accountMonitoringSummarySchema = z.object({
  accountId: z.string(),
  latestRiskScore: z.number().nullable(),
  latestScoreDelta: z.number().nullable(),
  assessmentRuns: z.number().int().nonnegative(),
  approvalDecisions: z.number().int().nonnegative(),
  acceptedRecommendations: z.number().int().nonnegative(),
  outreachApprovals: z.number().int().nonnegative(),
  humanFeedbackCount: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  averageLatencyMs: z.number().nonnegative(),
});

const customerSuccessMonitoringReportSchema = z.object({
  tenantId: z.string(),
  generatedAt: z.string(),
  totals: z.object({
    assessmentRuns: z.number().int().nonnegative(),
    approvalDecisions: z.number().int().nonnegative(),
    acceptedRecommendations: z.number().int().nonnegative(),
    outreachApprovals: z.number().int().nonnegative(),
    humanFeedbackCount: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    averageLatencyMs: z.number().nonnegative(),
    p95LatencyMs: z.number().nonnegative(),
  }),
  accounts: z.array(accountMonitoringSummarySchema),
});

export type CustomerSuccessMonitoringReport = z.infer<typeof customerSuccessMonitoringReportSchema>;

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

export function buildCustomerSuccessMonitoringReport(
  tenantId: string,
  events: readonly MonitoringEvent[],
  generatedAt: string,
): CustomerSuccessMonitoringReport {
  const scoped = events.filter(event => event.tenantId === tenantId);
  const accountIds = [...new Set(scoped.map(event => event.accountId))].sort();

  const accounts = accountIds.map(accountId => {
    const accountEvents = scoped.filter(event => event.accountId === accountId);
    const assessments = accountEvents.filter(event => event.phase === 'assessment');
    const approvals = accountEvents.filter(event => event.phase === 'approval');
    const latestAssessment = assessments.at(-1);
    const latencies = accountEvents.map(event => event.latencyMs);
    return {
      accountId,
      latestRiskScore: latestAssessment?.riskScore ?? null,
      latestScoreDelta: latestAssessment?.scoreDelta ?? null,
      assessmentRuns: assessments.length,
      approvalDecisions: approvals.length,
      acceptedRecommendations: accountEvents.reduce((sum, event) => sum + event.acceptedRecommendationCount, 0),
      outreachApprovals: accountEvents.filter(event => event.outreachApproved).length,
      humanFeedbackCount: accountEvents.filter(event => event.hasHumanFeedback).length,
      totalTokens: accountEvents.reduce((sum, event) => sum + event.totalTokens, 0),
      costUsd: rounded(accountEvents.reduce((sum, event) => sum + event.costUsd, 0)),
      averageLatencyMs: rounded(average(latencies)),
    };
  });

  const latencies = scoped.map(event => event.latencyMs);
  return customerSuccessMonitoringReportSchema.parse({
    tenantId,
    generatedAt,
    totals: {
      assessmentRuns: scoped.filter(event => event.phase === 'assessment').length,
      approvalDecisions: scoped.filter(event => event.phase === 'approval').length,
      acceptedRecommendations: scoped.reduce((sum, event) => sum + event.acceptedRecommendationCount, 0),
      outreachApprovals: scoped.filter(event => event.outreachApproved).length,
      humanFeedbackCount: scoped.filter(event => event.hasHumanFeedback).length,
      totalTokens: scoped.reduce((sum, event) => sum + event.totalTokens, 0),
      costUsd: rounded(scoped.reduce((sum, event) => sum + event.costUsd, 0)),
      averageLatencyMs: rounded(average(latencies)),
      p95LatencyMs: rounded(p95(latencies)),
    },
    accounts,
  });
}
