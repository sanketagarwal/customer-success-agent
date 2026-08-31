import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Config } from './config.js';
import { accountSignalsSchema, type AccountSignals, type Review } from './schemas.js';
export interface CustomerDataSource {
  listAccounts(): Promise<AccountSignals[]>;
  getAccount(accountId: string): Promise<AccountSignals | null>;
  saveReview(review: Review): Promise<{ writeId: string; taskIds: string[] }>;
}
export class FixtureDataSource implements CustomerDataSource {
  private accounts?: Promise<AccountSignals[]>;
  private readonly writes = new Map<string, { writeId: string; taskIds: string[] }>();
  constructor(private readonly path: string) {}
  private load() {
    return (this.accounts ??= readFile(this.path, 'utf8').then((file) =>
      z.array(accountSignalsSchema).parse(JSON.parse(file)),
    ));
  }
  async listAccounts() {
    return this.load();
  }
  async getAccount(accountId: string) {
    return (await this.load()).find((account) => account.accountId === accountId) ?? null;
  }
  async saveReview(review: Review) {
    const existing = this.writes.get(review.runId);
    if (existing) return existing;
    const result = {
      writeId: `fixture-note-${review.runId}`,
      taskIds: review.actions.map((_, index) => `fixture-task-${review.runId}-${index + 1}`),
    };
    this.writes.set(review.runId, result);
    return result;
  }
}
const hubspotObjectSchema = z.object({
  id: z.string(),
  properties: z.record(z.string(), z.string().nullable()).default({}),
  associations: z.record(z.string(), z.object({
    results: z.array(z.object({ id: z.string() })),
  })).default({}),
});
const hubspotPageSchema = z.object({
  results: z.array(hubspotObjectSchema),
  paging: z.object({ next: z.object({ after: z.string() }) }).optional(),
});
type HubSpotObject = z.infer<typeof hubspotObjectSchema>;
class HubSpotDataSource implements CustomerDataSource {
  private taskAssociation?: Promise<number>;
  constructor(private readonly config: Config) {}
  private async request(path: string, init?: RequestInit, retryable = true): Promise<unknown> {
    let lastError: unknown;
    const attempts = retryable ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(new URL(path, this.config.hubspotBaseUrl), {
          ...init,
          headers: { Authorization: `Bearer ${this.config.hubspotToken}`, 'Content-Type': 'application/json' },
        });
      } catch (error) {
        lastError = error;
        if (attempt < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        }
        continue;
      }
      if (response.ok) return response.status === 204 ? null : response.json();
      const error = new Error(`HubSpot ${response.status}: ${await response.text()}`);
      if (!retryable || (response.status !== 429 && response.status < 500)) throw error;
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('HubSpot request failed');
  }
  private async merge(company: HubSpotObject): Promise<AccountSignals> {
    const [tickets, invoices, feedback] = await Promise.all([
      this.readAssociated(company, 'tickets', ['hs_ticket_priority', 'closed_date']),
      this.readAssociated(company, 'invoices', ['hs_invoice_status', 'hs_due_date']),
      this.readAssociated(company, 'feedback_submissions', ['hs_sentiment', 'hs_createdate']),
    ]);
    const overdue = invoices
      .filter((invoice) => invoice.properties.hs_invoice_status?.toLowerCase() === 'open')
      .map((invoice) => daysSince(invoice.properties.hs_due_date))
      .filter((days): days is number => days !== null && days > 0);
    const daysPastDue = overdue.length ? Math.max(...overdue) : 0;
    const hasBilling = invoices.some((invoice) =>
      ['open', 'paid', 'voided'].includes(invoice.properties.hs_invoice_status?.toLowerCase() ?? ''),
    );
    const sentiment = feedback
      .sort((a, b) => Date.parse(b.properties.hs_createdate ?? '') - Date.parse(a.properties.hs_createdate ?? ''))
      .map((item) => normalizeSentiment(item.properties.hs_sentiment))
      .find((value) => value !== 'unknown')
      ?? normalizeSentiment(company.properties.hs_csm_sentiment);
    const unavailable = ['usage'];
    if (!hasBilling) unavailable.push('billing');
    if (sentiment === 'unknown') unavailable.push('crm');
    return accountSignalsSchema.parse({
      ...emptySignals,
      tenantId: this.config.tenantId,
      accountId: company.id,
      name: company.properties.name || `HubSpot company ${company.id}`,
      renewalAt: normalizeDate(company.properties[this.config.hubspotRenewalProperty]),
      ownerId: company.properties.hubspot_owner_id || null,
      support: { urgentOpenTickets: tickets.filter(
        (ticket) => ticket.properties.hs_ticket_priority === 'HIGH' && !ticket.properties.closed_date,
      ).length },
      billing: {
        standing: !hasBilling ? 'unknown' : daysPastDue >= 30 ? 'delinquent' : daysPastDue ? 'past_due' : 'current',
        daysPastDue: hasBilling ? daysPastDue : null,
      },
      crm: { sentiment },
      unavailable,
    });
  }
  private async readAssociated(company: HubSpotObject, object: string, properties: string[]) {
    const inputs = company.associations[object]?.results.map(({ id }) => ({ id })) ?? [];
    if (!inputs.length) return [];
    return hubspotPageSchema.parse(
      await this.request(`/crm/v3/objects/${object}/batch/read`, {
        method: 'POST',
        body: JSON.stringify({ inputs, properties }),
      }),
    ).results;
  }
  private companyQuery() {
    return new URLSearchParams({
      properties: `name,hubspot_owner_id,${this.config.hubspotRenewalProperty},hs_csm_sentiment`,
      associations: 'tickets,invoices,feedback_submissions',
    });
  }
  async listAccounts() {
    const accounts: AccountSignals[] = [];
    let after: string | undefined;
    do {
      const query = this.companyQuery();
      query.set('limit', '100');
      if (after) query.set('after', after);
      const page = hubspotPageSchema.parse(
        await this.request(`/crm/v3/objects/companies?${query}`),
      );
      accounts.push(...(await Promise.all(page.results.map((company) => this.merge(company)))));
      after = page.paging?.next.after;
    } while (after);
    return accounts;
  }
  async getAccount(accountId: string) {
    const query = this.companyQuery();
    const company = hubspotObjectSchema.parse(
      await this.request(`/crm/v3/objects/companies/${encodeURIComponent(accountId)}?${query}`),
    );
    return this.merge(company);
  }
  async saveReview(review: Review) {
    const associationTypeId = await this.getTaskAssociation();
    const tasks = await Promise.all(
      review.actions.map((action) =>
        this.request('/crm/v3/objects/tasks', {
          method: 'POST',
          body: JSON.stringify({
            properties: {
              hs_timestamp: action.dueAt,
              hs_task_subject: action.title,
              hs_task_status: 'NOT_STARTED',
              hs_task_type: 'TODO',
            },
            associations: associateCompany(review.accountId, associationTypeId),
          }),
        }, false).then((value) => hubspotObjectSchema.parse(value)),
      ),
    );
    const created = hubspotObjectSchema.parse(
      await this.request('/crm/v3/objects/notes', {
        method: 'POST',
        body: JSON.stringify({
          properties: {
            hs_timestamp: new Date().toISOString(),
            hs_note_body: formatReview(review),
          },
          associations: associateCompany(review.accountId, 190),
        }),
      }, false),
    );
    return { writeId: created.id, taskIds: tasks.map((task) => task.id) };
  }
  private getTaskAssociation() {
    return (this.taskAssociation ??= this.request(
      '/crm/associations/2026-03/tasks/companies/labels',
    ).then((value) => {
      const labels = z
        .object({ results: z.array(z.object({ typeId: z.number(), category: z.string() })) })
        .parse(value).results;
      const association = labels.find((label) => label.category === 'HUBSPOT_DEFINED');
      if (!association) throw new Error('HubSpot task-to-company association was not found');
      return association.typeId;
    }));
  }
}
function associateCompany(id: string, associationTypeId: number) {
  return [{ to: { id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId }] }];
}
const emptySignals = {
  renewalAt: null,
  ownerId: null,
  usage: { previousAdoption: null, currentAdoption: null },
  support: { urgentOpenTickets: null },
  billing: { standing: null, daysPastDue: null },
  crm: { sentiment: 'unknown' as const },
  unavailable: ['usage', 'support', 'billing', 'crm'] as const,
};
function normalizeDate(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
function daysSince(value: string | null | undefined) {
  const date = normalizeDate(value);
  return date ? Math.floor((Date.now() - Date.parse(date)) / 86_400_000) : null;
}
const sentimentMap: Record<string, 'positive' | 'neutral' | 'negative' | undefined> = {
  positive: 'positive', happy: 'positive', promoter: 'positive', easy: 'positive',
  healthy: 'positive',
  neutral: 'neutral', passive: 'neutral', negative: 'negative', unhappy: 'negative',
  detractor: 'negative', difficult: 'negative', at_risk: 'negative' };
const normalizeSentiment = (value: string | null | undefined) =>
  sentimentMap[value?.toLowerCase() ?? ''] ?? 'unknown';
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]!,
  );
}
function formatReview(review: Review) {
  const actions = review.actions.map((action) => `<li>${escapeHtml(action.title)}</li>`).join('');
  return [
    `<strong>Customer Success review — ${escapeHtml(review.runId)}</strong>`,
    `<p>Health: ${review.score}/100 — ${escapeHtml(review.summary)}</p>`,
    `<ul>${actions}</ul>`,
    '<strong>Outreach draft — not sent</strong>',
    `<p>${escapeHtml(review.outreach?.subject ?? '')}</p>`,
    `<p>${escapeHtml(review.outreach?.body ?? '')}</p>`,
  ].join('\n');
}
export function createDataSource(config: Config): CustomerDataSource {
  const fixtures = new FixtureDataSource(config.fixturePath);
  const base = config.dataSource === 'hubspot' ? new HubSpotDataSource(config) : fixtures;
  if (!config.signalsApiUrl) return base;
  const liveSignals = accountSignalsSchema.pick({ usage: true });
  return {
    listAccounts: () => base.listAccounts(),
    saveReview: (review) => base.saveReview(review),
    getAccount: async (accountId) => {
      const account = await base.getAccount(accountId);
      if (!account) return null;
      const response = await fetch(
        new URL(`/accounts/${encodeURIComponent(accountId)}/signals`, config.signalsApiUrl),
        {
          headers: config.signalsApiToken
            ? { Authorization: `Bearer ${config.signalsApiToken}` }
            : {},
        },
      );
      if (!response.ok) throw new Error(`Signals API returned ${response.status}`);
      return accountSignalsSchema.parse({
        ...account,
        ...liveSignals.parse(await response.json()),
        unavailable: account.unavailable.filter((signal) => signal !== 'usage'),
      });
    },
  };
}
