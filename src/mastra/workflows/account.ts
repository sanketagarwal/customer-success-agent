import { digest, withArtifactHash, isCurrentReview } from '../approval.js';
import type { Agent } from '@mastra/core/agent';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { CustomerDataSource } from '../data.js';
import type { ReviewHistory } from '../history.js';
import {
  approvalSchema,
  outreachSchema,
  reviewSchema,
  type AccountSignals,
  type Review,
  type Risk,
} from '../schemas.js';

export const accountInputSchema = z.object({
  accountId: z.string().default('340734348989'),
});

const requestContextSchema = z.object({
  'tenant-id': z.string().optional(),
  'account-id': z.string().optional(),
});
function addDays(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
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
  ].filter((value) => value !== null && value !== 'unknown').length;
  if (available < 2 || new Set(account.unavailable).size > 1) {
    return withArtifactHash({
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

  const addRisk = (
    penalty: number,
    category: Risk['category'],
    severity: Risk['severity'],
    title: string,
    evidence: string,
  ) => {
    score -= penalty;
    risks.push({ category, severity, title, evidence });
  };

  const { previousAdoption, currentAdoption } = account.usage;
  if (currentAdoption !== null) {
    const decline = previousAdoption === null ? 0 : previousAdoption - currentAdoption;

    if (decline >= 0.2) {
      addRisk(
        35,
        'usage',
        'critical',
        'Product adoption is falling',
        `${Math.round((previousAdoption ?? currentAdoption) * 100)}% → ${Math.round(currentAdoption * 100)}% adoption`,
      );
    } else if (currentAdoption < 0.5) {
      addRisk(
        20,
        'usage',
        'high',
        'Product adoption is low',
        `${Math.round(currentAdoption * 100)}% adoption`,
      );
    }
  }

  if ((account.support.urgentOpenTickets ?? 0) > 0) {
    addRisk(
      25,
      'support',
      'high',
      'Urgent support issue is open',
      `${account.support.urgentOpenTickets} urgent open ticket(s)`,
    );
  }

  if (account.billing.standing === 'past_due' || account.billing.standing === 'delinquent') {
    addRisk(
      20,
      'billing',
      'high',
      'Billing is overdue',
      `${account.billing.daysPastDue ?? 0} days past due`,
    );
  }

  if (account.crm.sentiment === 'negative') {
    addRisk(
      15,
      'crm',
      'medium',
      'Customer sentiment is negative',
      'Latest CRM sentiment: negative',
    );
  }

  score = Math.max(0, score);
  const scoredBase = {
    ...base,
    metrics: {
      ...base.metrics,
      scoreDelta: previousScore === null ? null : score - previousScore,
    },
  };

  if (score >= 70) {
    return withArtifactHash({
      ...scoredBase,
      outcome: 'no_action',
      score,
      summary: `${account.name} is healthy; continue the current success plan.`,
      risks,
      actions: [],
      outreach: null,
    });
  }

  const owners = {
    usage: 'product',
    support: 'support',
    billing: 'billing',
    crm: 'csm',
  } as const;
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
  const riskSummary = risks.map((risk) => risk.title.toLowerCase()).join(', ');

  return withArtifactHash({
    ...scoredBase,
    outcome: 'awaiting_approval',
    score,
    summary: `${account.name} is at risk because ${riskSummary}.`,
    risks,
    actions,
    outreach: {
      subject: `Next steps for ${account.name}`,
      body: `Hi team, we'd like to review the recent account signals and agree on a focused recovery plan.
Could we schedule time this week?`,
      draftOnly: true,
    },
  });
}

async function personalize(
  review: Review,
  account: AccountSignals,
  agent: Agent,
  config: Config,
) {
  if (config.generationMode !== 'model' || !review.outreach) return review;

  const verifiedSignals = JSON.stringify({
    account,
    risks: review.risks,
    actions: review.actions,
  });
  const prompt = `Write concise, customer-specific outreach from these verified signals.
Do not invent facts.
${verifiedSignals}`;
  const response = await agent.generate(prompt, {
    memory: {
      resource: `${account.tenantId}:${account.accountId}`,
      thread: review.runId,
    },
    structuredOutput: { schema: outreachSchema, jsonPromptInjection: 'auto' },
  });
  const [outreach, usage] = await Promise.all([response.object, response.totalUsage]);
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  return withArtifactHash({
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
  workflowId = 'renewal-risk-review',
) {
  const reviewAccount = createStep({
    id: 'review-account',
    inputSchema: accountInputSchema,
    outputSchema: reviewSchema,
    retries: 2,
    execute: async ({ inputData, runId, requestContext }) => {
      const startedAt = performance.now();
      const account = await data.getAccount(inputData.accountId);
      if (!account) throw new Error(`Account ${inputData.accountId} was not found`);

      const tenantId = requestContext.get('tenant-id');
      if (tenantId && tenantId !== account.tenantId) {
        throw new Error('Tenant request context does not match the account');
      }

      const accountId = requestContext.get('account-id');
      if (accountId && accountId !== account.accountId) {
        throw new Error('Account request context does not match the input');
      }

      const previousScore = await history.previousScore(account.accountId, runId);
      const reviewed = await personalize(
        assess(account, runId, previousScore),
        account,
        agent,
        config,
      );
      const result = {
        ...reviewed,
        metrics: { ...reviewed.metrics, latencyMs: performance.now() - startedAt },
      };

      await history.record(result);
      return result;
    },
  });

  const requestApproval = createStep({
    id: 'request-csm-approval',
    inputSchema: reviewSchema,
    outputSchema: reviewSchema,
    suspendSchema: reviewSchema,
    resumeSchema: approvalSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      if (inputData.outcome !== 'awaiting_approval') return inputData;
      if (!resumeData) return await suspend(inputData);

      inputData = {
        ...inputData,
        approval: { ...resumeData, decidedAt: new Date().toISOString() },
        metrics: { ...inputData.metrics, hasHumanFeedback: Boolean(resumeData.feedback) },
      };
      const startedAt = performance.now();
      const rejected = resumeData.decision === 'rejected';
      if (rejected || !isCurrentReview(inputData, await data.getAccount(inputData.accountId))) {
        const result: Review = { ...inputData, outcome: rejected ? 'rejected' : 'stale_approval' };
        await history.record(result);
        return result;
      }

      const write = await history.writeOnce(inputData.runId, (checkpoint) => data.saveReview(inputData, checkpoint));
      const completed = {
        ...inputData,
        ...write,
        outcome: 'written' as const,
        metrics: {
          ...inputData.metrics,
          latencyMs: inputData.metrics.latencyMs + performance.now() - startedAt,
          acceptedRecommendations: inputData.actions.length,
          outreachApproved: true,
        },
      };

      await history.record(completed);
      return completed;
    },
  });

  return createWorkflow({
    id: workflowId,
    inputSchema: accountInputSchema,
    outputSchema: reviewSchema,
    requestContextSchema,
  })
    .then(reviewAccount)
    .then(requestApproval)
    .commit();
}
