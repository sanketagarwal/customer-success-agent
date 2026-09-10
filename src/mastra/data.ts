import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { WriteNotAppliedError, type WriteCheckpoint } from './writes.js';
import type { Config } from './config.js';
import { accountSignalsSchema, type AccountSignals, type Review } from './schemas.js';

type WriteResult = { writeId: string; taskIds: string[] };

export interface CustomerDataSource {
  listAccounts(): Promise<AccountSignals[]>;
  getAccount(accountId: string): Promise<AccountSignals | null>;
  saveReview(review: Review, checkpoint?: WriteCheckpoint): Promise<WriteResult>;
}

export class FixtureDataSource implements CustomerDataSource {
  private accounts?: Promise<AccountSignals[]>;
  private readonly writes = new Map<string, WriteResult>();

  constructor(private readonly path: string) {}

  private load() {
    if (!this.accounts) {
      this.accounts = readFile(this.path, 'utf8').then((file) =>
        z.array(accountSignalsSchema).parse(JSON.parse(file)),
      );
    }

    return this.accounts;
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

const HUBSPOT_OBJECTS_PATH = '/crm/objects/2026-03';
const HUBSPOT_TASK_TO_COMPANY_ASSOCIATION_ID = 192;
const HUBSPOT_NOTE_TO_COMPANY_ASSOCIATION_ID = 190;

const pagingSchema = z.object({
  next: z.object({ after: z.coerce.string(), link: z.string().optional() }).optional(),
}).optional();
const associationPageSchema = z.object({
  results: z.array(z.union([
    z.object({ id: z.string() }),
    z.object({ toObjectId: z.union([z.string(), z.number()]) }).transform(({ toObjectId }) => ({ id: String(toObjectId) })),
  ])),
  paging: pagingSchema,
});
const hubspotObjectSchema = z.object({
  id: z.string(),
  properties: z.record(z.string(), z.string().nullable()).default({}),
  associations: z.record(z.string(), associationPageSchema).default({}),
});
const hubspotPageSchema = z.object({
  results: z.array(hubspotObjectSchema),
  paging: pagingSchema,
});

type HubSpotObject = z.infer<typeof hubspotObjectSchema>;

class HubSpotDataSource implements CustomerDataSource {
  constructor(private readonly config: Config) {}

  private async request(
    path: string,
    init?: RequestInit,
    retryable = true,
  ): Promise<unknown> {
    const url = new URL(path, this.config.hubspotBaseUrl);
    if (url.origin !== new URL(this.config.hubspotBaseUrl).origin) {
      throw new Error('HubSpot pagination must stay on the configured origin');
    }
    let lastError: unknown;
    const attempts = retryable ? 3 : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await delay(250 * 2 ** (attempt - 1));
      let response: Response;

      try {
        response = await fetch(url, {
          signal: AbortSignal.timeout(30_000),
          ...init,
          headers: {
            Authorization: `Bearer ${this.config.hubspotToken}`,
            'Content-Type': 'application/json',
          },
        });
      } catch (error) {
        lastError = error;
        continue;
      }

      if (response.ok) {
        return response.status === 204 ? null : response.json();
      }

      const message = `HubSpot ${response.status}: ${await response.text()}`;
      const error = !retryable && [400, 401, 403, 404, 422, 429].includes(response.status)
        ? new WriteNotAppliedError(message)
        : new Error(message);
      if (!retryable || (response.status !== 429 && response.status < 500)) {
        throw error;
      }

      lastError = error;
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
      ['open', 'paid', 'voided'].includes(
        invoice.properties.hs_invoice_status?.toLowerCase() ?? '',
      ),
    );
    const sentiment = feedback
      .sort(
        (a, b) =>
          Date.parse(b.properties.hs_createdate ?? '') -
          Date.parse(a.properties.hs_createdate ?? ''),
      )
      .map((item) => normalizeSentiment(item.properties.hs_sentiment))
      .find((value) => value !== 'unknown') ??
      normalizeSentiment(company.properties.hs_csm_sentiment);

    const unavailable = ['usage'];
    if (!hasBilling) unavailable.push('billing');
    if (sentiment === 'unknown') unavailable.push('crm');

    return accountSignalsSchema.parse({
      tenantId: this.config.tenantId,
      accountId: company.id,
      name: company.properties.name || `HubSpot company ${company.id}`,
      renewalAt: normalizeDate(company.properties[this.config.hubspotRenewalProperty]),
      ownerId: company.properties.hubspot_owner_id || null,
      usage: { previousAdoption: null, currentAdoption: null },
      support: {
        urgentOpenTickets: tickets.filter(
          (ticket) =>
            ticket.properties.hs_ticket_priority === 'HIGH' &&
            !ticket.properties.closed_date,
        ).length,
      },
      billing: {
        standing: getBillingStanding(hasBilling, daysPastDue),
        daysPastDue: hasBilling ? daysPastDue : null,
      },
      crm: { sentiment },
      unavailable,
    });
  }

  private async readAssociated(company: HubSpotObject, object: string, properties: string[]) {
    let page = company.associations[object];
    const ids = new Set(page?.results.map(({ id }) => id));
    const cursors = new Set<string>();
    while (page?.paging?.next) {
      const { after, link } = page.paging.next;
      if (cursors.has(after)) throw new Error('HubSpot repeated an association cursor');
      cursors.add(after);
      page = associationPageSchema.parse(await this.request(
        link ?? `${HUBSPOT_OBJECTS_PATH}/companies/${encodeURIComponent(company.id)}/associations/${object}?after=${encodeURIComponent(after)}`,
      ));
      page.results.forEach(({ id }) => ids.add(id));
    }

    const inputs = [...ids].map((id) => ({ id }));
    const records: HubSpotObject[] = [];
    for (let index = 0; index < inputs.length; index += 100) {
      const batch = inputs.slice(index, index + 100);
      const result = hubspotPageSchema.parse(await this.request(`${HUBSPOT_OBJECTS_PATH}/${object}/batch/read`, {
        method: 'POST', body: JSON.stringify({ inputs: batch, properties }),
      }));
      if (batch.some(({ id }) => !result.results.some((record) => record.id === id))) {
        throw new Error(`HubSpot returned incomplete ${object} signals`);
      }
      records.push(...result.results);
    }
    return records;
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
        await this.request(`${HUBSPOT_OBJECTS_PATH}/companies?${query}`),
      );

      for (let index = 0; index < page.results.length; index += this.config.maxConcurrency) {
        accounts.push(...await Promise.all(
          page.results.slice(index, index + this.config.maxConcurrency).map((company) => this.merge(company)),
        ));
      }
      after = page.paging?.next?.after;
    } while (after);

    return accounts;
  }

  async getAccount(accountId: string) {
    const query = this.companyQuery();
    const company = hubspotObjectSchema.parse(
      await this.request(
        `${HUBSPOT_OBJECTS_PATH}/companies/${encodeURIComponent(accountId)}?${query}`,
      ),
    );

    return this.merge(company);
  }

  async saveReview(review: Review, checkpoint: WriteCheckpoint = (_, write) => write()) {
    const taskIds: string[] = [];
    // Persist each completed operation before starting the next one.
    for (const [index, action] of review.actions.entries()) {
      const task = await checkpoint(`task-${index}`, async () => hubspotObjectSchema.parse(
        await this.request(`${HUBSPOT_OBJECTS_PATH}/tasks`, {
          method: 'POST',
          body: JSON.stringify({
            properties: {
              hs_timestamp: action.dueAt,
              hs_task_subject: action.title,
              hs_task_status: 'NOT_STARTED',
              hs_task_type: 'TODO',
            },
            associations: associateCompany(review.accountId, HUBSPOT_TASK_TO_COMPANY_ASSOCIATION_ID),
          }),
        }, false),
      ));
      taskIds.push(task.id);
    }
    const note = await checkpoint('note', async () => hubspotObjectSchema.parse(
      await this.request(`${HUBSPOT_OBJECTS_PATH}/notes`, {
        method: 'POST',
        body: JSON.stringify({
          properties: {
            hs_timestamp: review.createdAt,
            hs_note_body: formatReview(review),
          },
          associations: associateCompany(review.accountId, HUBSPOT_NOTE_TO_COMPANY_ASSOCIATION_ID),
        }),
      }, false),
    ));
    return { writeId: note.id, taskIds };
  }
}

function associateCompany(id: string, associationTypeId: number) {
  return [
    {
      to: { id },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId }],
    },
  ];
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeDate(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function daysSince(value: string | null | undefined) {
  const date = normalizeDate(value);
  return date ? Math.floor((Date.now() - Date.parse(date)) / 86_400_000) : null;
}

function getBillingStanding(hasBilling: boolean, daysPastDue: number) {
  if (!hasBilling) return 'unknown';
  if (daysPastDue >= 30) return 'delinquent';
  if (daysPastDue > 0) return 'past_due';
  return 'current';
}

type KnownSentiment = 'positive' | 'neutral' | 'negative';

const sentimentMap: Record<string, KnownSentiment | undefined> = {
  positive: 'positive',
  happy: 'positive',
  promoter: 'positive',
  easy: 'positive',
  healthy: 'positive',
  neutral: 'neutral',
  passive: 'neutral',
  negative: 'negative',
  unhappy: 'negative',
  detractor: 'negative',
  difficult: 'negative',
  at_risk: 'negative',
};

function normalizeSentiment(value: string | null | undefined): KnownSentiment | 'unknown' {
  return sentimentMap[value?.toLowerCase() ?? ''] ?? 'unknown';
}

const htmlEntities: Record<string, string | undefined> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => htmlEntities[character] ?? character);
}

function formatReview(review: Review) {
  const actions = review.actions
    .map((action) => `<li>${escapeHtml(action.title)}</li>`)
    .join('');

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
    saveReview: (review, checkpoint) => base.saveReview(review, checkpoint),
    getAccount: async (accountId) => {
      const account = await base.getAccount(accountId);
      if (!account) return null;
      const response = await fetch(
        new URL(`/accounts/${encodeURIComponent(accountId)}/signals`, config.signalsApiUrl),
        {
          signal: AbortSignal.timeout(30_000),
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
