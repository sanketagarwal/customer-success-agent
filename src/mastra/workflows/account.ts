import { createHash } from 'node:crypto';
import type { Agent } from '@mastra/core/agent';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { CustomerDataSource } from '../data.js';
import type { ReviewHistory } from '../history.js';
import { approvalSchema, outreachSchema, reviewSchema, type AccountSignals, type Review, type Risk } from '../schemas.js';
export const accountInputSchema = z.object({ accountId: z.string().default('340734348989') });
const requestContextSchema = z.object({
  'tenant-id': z.string().optional(),
  'account-id': z.string().optional(),
});
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function addDays(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}
function bind(review: Review): Review {
  return {
    ...review,
    artifactHash: digest({
      sourceHash: review.sourceHash,
      score: review.score,
      risks: review.risks,
      actions: review.actions,
      outreach: review.outreach,
    }),
  };
}
export function assess(
  account: AccountSignals,
  runId: string,
  previousScore: number | null = null,
): Review {
  const createdAt = new Date().toISOString();
  const base = {
    runId,
    accountId: account.accountId,
    accountName: account.name,
    createdAt,
    expiresAt: addDays(1),
    sourceHash: digest(account),
    artifactHash: '',
    writeId: null,
    taskIds: [],
    metrics: {
      latencyMs: 0,
      acceptedRecommendations: 0,
      outreachApproved: false,
      hasHumanFeedback: false,
      scoreDelta: previousScore === null ? null : 0,
      totalTokens: 0,
      costUsd: 0,
    },
  };
  const available = [
    account.usage.currentAdoption,
    account.support.urgentOpenTickets,
    account.billing.standing,
    account.crm.sentiment,
  ].filter((value) => value !== null).length;
  if (available < 2 || account.unavailable.length > 1) {
    return bind({
      ...base,
      outcome: 'insufficient_data',
      score: null,
      summary: `Not enough reliable data to assess ${account.name}.`,
      risks: [],
      actions: [],
      outreach: null,
    });
  }
  let score = 100;
  const risks: Risk[] = [];
  const addRisk = (penalty: number, category: Risk['category'], severity: Risk['severity'],
    title: string, evidence: string) => {
    score -= penalty;
    risks.push({ category, severity, title, evidence });
  };
  const { previousAdoption, currentAdoption } = account.usage;
  if (previousAdoption !== null && currentAdoption !== null) {
    const decline = previousAdoption - currentAdoption;
    if (decline >= 0.2) {
      addRisk(35, 'usage', 'critical', 'Product adoption is falling',
        `${Math.round(previousAdoption * 100)}% → ${Math.round(currentAdoption * 100)}% adoption`);
    } else if (currentAdoption < 0.5) {
      addRisk(20, 'usage', 'high', 'Product adoption is low',
        `${Math.round(currentAdoption * 100)}% adoption`);
    }
  }
  if ((account.support.urgentOpenTickets ?? 0) > 0) {
    addRisk(25, 'support', 'high', 'Urgent support issue is open',
      `${account.support.urgentOpenTickets} urgent open ticket(s)`);
  }
  if (account.billing.standing === 'past_due' || account.billing.standing === 'delinquent') {
    addRisk(20, 'billing', 'high', 'Billing is overdue',
      `${account.billing.daysPastDue ?? 0} days past due`);
  }
  if (account.crm.sentiment === 'negative') {
    addRisk(15, 'crm', 'medium', 'Customer sentiment is negative',
      'Latest CRM sentiment: negative');
  }
  score = Math.max(0, score);
  base.metrics.scoreDelta = previousScore === null ? null : score - previousScore;
  if (score >= 70) {
    return bind({
      ...base,
      outcome: 'no_action',
      score,
      summary: `${account.name} is healthy; continue the current success plan.`,
      risks,
      actions: [],
      outreach: null,
    });
  }
  const owners = { usage: 'product', support: 'support', billing: 'billing', crm: 'csm' } as const;
  const titles = {
    usage: 'Review adoption blockers with the customer',
    support: 'Escalate the urgent support issue',
    billing: 'Resolve the outstanding balance',
    crm: 'Schedule an executive check-in',
  } as const;
  const actions = risks.map((risk) => ({
    title: titles[risk.category],
    owner: owners[risk.category],
    dueAt: addDays(risk.severity === 'critical' ? 2 : 7),
  }));
  return bind({
    ...base,
    outcome: 'awaiting_approval',
    score,
    summary: `${account.name} is at risk because ${risks.map((risk) => risk.title.toLowerCase()).join(', ')}.`,
    risks,
    actions,
    outreach: {
      subject: `Next steps for ${account.name}`,
      body: `Hi team, we'd like to review the recent account signals and agree on a focused recovery plan. Could we schedule time this week?`,
      draftOnly: true,
    },
  });
}
async function personalize(review: Review, account: AccountSignals, agent: Agent, config: Config) {
  if (config.generationMode !== 'model' || !review.outreach) return review;
  const response = await agent.generate(
    `Write concise, customer-specific outreach from these verified signals. Do not invent facts.\n${JSON.stringify({ account, risks: review.risks, actions: review.actions })}`,
    {
      memory: { resource: `${account.tenantId}:${account.accountId}`, thread: review.runId },
      structuredOutput: { schema: outreachSchema, jsonPromptInjection: 'auto' },
    },
  );
  const [outreach, usage] = await Promise.all([response.object, response.totalUsage]);
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return bind({
    ...review,
    outreach: outreachSchema.parse(outreach),
    metrics: {
      ...review.metrics,
      totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
      costUsd: (inputTokens * config.inputCost + outputTokens * config.outputCost) / 1_000_000,
    },
  });
}
export function createAccountWorkflow(
  data: CustomerDataSource,
  history: ReviewHistory,
  agent: Agent,
  config: Config,
) {
  const reviewAccount = createStep({
    id: 'review-account', inputSchema: accountInputSchema, outputSchema: reviewSchema, retries: 2,
    execute: async ({ inputData, runId, requestContext }) => {
      const startedAt = performance.now();
      const account = await data.getAccount(inputData.accountId);
      if (!account) throw new Error(`Account ${inputData.accountId} was not found`);
      if (requestContext.get('tenant-id') && requestContext.get('tenant-id') !== account.tenantId) {
        throw new Error('Tenant request context does not match the account');
      }
      if (requestContext.get('account-id') && requestContext.get('account-id') !== account.accountId) {
        throw new Error('Account request context does not match the input');
      }
      const previousScore = await history.previousScore(account.accountId, runId);
      const reviewed = await personalize(assess(account, runId, previousScore), account, agent, config);
      const result = {
        ...reviewed,
        metrics: { ...reviewed.metrics, latencyMs: performance.now() - startedAt },
      };
      await history.record(result);
      return result;
    },
  });
  const requestApproval = createStep({
    id: 'request-csm-approval', inputSchema: reviewSchema, outputSchema: reviewSchema,
    suspendSchema: reviewSchema, resumeSchema: approvalSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      if (inputData.outcome !== 'awaiting_approval') return inputData;
      if (!resumeData) return suspend(inputData);
      const startedAt = performance.now();
      if (resumeData.decision === 'rejected') {
        const rejected = { ...inputData, outcome: 'rejected' as const };
        await history.record(rejected);
        return rejected;
      }
      const current = await data.getAccount(inputData.accountId);
      if (
        Date.now() > Date.parse(inputData.expiresAt) ||
        !current ||
        digest(current) !== inputData.sourceHash ||
        bind(inputData).artifactHash !== inputData.artifactHash
      ) {
        const stale = { ...inputData, outcome: 'stale_approval' as const };
        await history.record(stale);
        return stale;
      }
      const write = await history.writeOnce(inputData.runId, () => data.saveReview(inputData));
      const completed = {
        ...inputData,
        ...write,
        outcome: 'written' as const,
        metrics: {
          ...inputData.metrics,
          latencyMs: inputData.metrics.latencyMs + performance.now() - startedAt,
          acceptedRecommendations: inputData.actions.length,
          outreachApproved: true,
          hasHumanFeedback: Boolean(resumeData.feedback),
        },
      };
      await history.record(completed);
      return completed;
    },
  });
  return createWorkflow({
    id: 'customer-success-account', inputSchema: accountInputSchema,
    outputSchema: reviewSchema, requestContextSchema,
  }).then(reviewAccount).then(requestApproval).commit();
}
