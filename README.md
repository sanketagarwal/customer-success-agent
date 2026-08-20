# Customer Success Renewal Agent

Catch churn risk before renewal and turn it into an approved follow-up plan.

This template combines product usage, support history, billing status, and CRM
notes into an evidence-backed health assessment. It identifies risks, creates an
account plan, drafts outreach, waits for CSM approval, then records approved
notes and tasks in CRM. The complete demo runs in Mastra Studio with bundled
fixture data and never sends customer-facing messages automatically.

## Why we built this

Customer risk rarely lives in one system. This template shows how Mastra can
turn scattered signals into a scheduled operational workflow with structured
outputs, memory, approval, retries, evals, and monitoring.

## Demo

The default demo is intentionally one-click:

1. Start the project and open Mastra Studio.
2. Open **Workflows** → `customer-success-account`.
3. Keep the prefilled demo account ID and click **Run**.
4. Inspect the assessment, plan, and outreach when the workflow pauses.
5. Approve it as `demo-csm` to create the fixture CRM note and tasks.

All 17 steps run automatically and remain visible for inspection. The only
manual action is the intentional CSM approval.

This demo runs in Studio, but the same workflow can be called from an app with
the [Mastra Client SDK](https://mastra.ai/docs/server/mastra-client).

## Quick start

Requires Node.js 22.13 or newer. No API key or `.env` file is required for the
fixture demo.

```bash
npx create-mastra@latest --template customer-success-agent
cd customer-success-agent
npm run dev
```

Open [localhost:4111](http://localhost:4111) and follow the demo above.

## Try each outcome

| Account ID     | Scenario         | Expected result                    |
| -------------- | ---------------- | ---------------------------------- |
| `340734348989` | Renewal risk     | Pauses for approval, then writes   |
| `340739743463` | Healthy          | Completes with `no_action`         |
| `340737895140` | Missing signals  | Completes with insufficient data   |
| `340878324429` | Provider failure | Retries, then returns retry status |

The scheduled `weekly-customer-success` workflow runs the same review across
all accounts with bounded concurrency.

## Connect your systems

Fixtures are included in `data/fixtures/accounts.json` so the template works
immediately. The workflow itself depends only on provider-neutral interfaces
for usage, support, billing, CRM reads, and CRM writes.

`src/mastra/composition/create-connectors.ts` is the single connector boundary.
Implement the interfaces in `src/mastra/ports/index.ts`, then replace or
override any connector without changing the workflow, approval, eval, or
monitoring logic. You can keep fixtures for some sources while connecting live
providers for others.

HubSpot is included only as an example CRM adapter. To try it, copy
`.env.example` to `.env` and set:

```env
CRM_PROVIDER=hubspot
TENANT_ID=your-tenant
HUBSPOT_PRIVATE_APP_TOKEN=your-private-app-token
```

Approved HubSpot runs create internal notes and follow-up tasks; they do not
send the outreach draft.

HubSpot replaces only the CRM read/write connector in this example. The bundled
usage, support, and billing fixtures are keyed by account ID, so add the HubSpot
company ID to those fixtures or replace those connectors before running a live
company. Without that alignment, the workflow correctly returns
`insufficient_data`.

## Making it yours

- Connect your product analytics, support, billing, and CRM providers in
  `create-connectors.ts`.
- Set the portfolio-review cron, timezone, and concurrency in `.env`.
- Set `GENERATION_MODE=model` to use model-backed assessment and drafting.
- Connect workflow resume to your app or CRM-native approval experience.

Detailed guides cover the [Mastra primitives](./docs/mastra-primitives.md),
[evals](./docs/evals.md), [monitoring](./docs/monitoring.md), and
[structured contracts](./customer-success-contracts.md).

## About Mastra templates

[Mastra templates](https://mastra.ai/templates) are ready-to-use projects that
show what you can build—clone one, explore it in Studio, and make it yours. They
live in the [Mastra monorepo](https://github.com/mastra-ai/mastra) and are
automatically synced to standalone repositories.

Want to contribute? See [CONTRIBUTING.md](./CONTRIBUTING.md).
