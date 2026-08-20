# Customer Success Renewal Agent

A scheduled AI agent that identifies at-risk accounts and coordinates follow-up
before renewal.

It combines product usage, support history, billing status, and CRM notes into a
structured health assessment, creates an account plan, drafts personalized
outreach, waits for CSM approval, and records approved notes and tasks in CRM.

## Why we built this

Customer risk rarely lives in one system. This template shows how Mastra can
turn scattered account signals into an ongoing operational workflow with
memory, structured outputs, approval, retries, evals, and monitoring.

## Demo

This demo runs in Mastra Studio, but you can connect the workflow to your app
using the [Mastra Client SDK](https://mastra.ai/docs/server/mastra-client) or
agentic UI libraries like
[AI SDK UI](https://mastra.ai/guides/build-your-ui/ai-sdk-ui),
[CopilotKit](https://mastra.ai/guides/build-your-ui/copilotkit), or
[Assistant UI](https://mastra.ai/guides/build-your-ui/assistant-ui).

## Prerequisites

- Node.js 22.13 or newer
- An [OpenAI API key](https://platform.openai.com/api-keys)

## Quick start

```bash
npx create-mastra@latest --template customer-success-agent
cd customer-success-agent
cp .env.example .env
```

Add your OpenAI API key to `.env`:

```env
OPENAI_API_KEY=your-api-key
```

Start Mastra Studio:

```bash
npm run dev
```

Open [localhost:4111](http://localhost:4111).

## Using it

1. Open **Workflows** and select `customer-success-account`.
2. Keep the prefilled account ID and click **Run**.
3. Inspect the health assessment, risk factors, account plan, and outreach.
4. When `request-csm-approval` pauses, approve it as `demo-csm`.
5. Resume the workflow to create the CRM note and follow-up tasks.

All 17 steps run automatically. The outreach stays draft-only and is never sent
without additional application logic.

The `weekly-customer-success` workflow runs the same review across every account
returned by the configured CRM connector.

## Connecting to real data

The bundled data lives in `data/fixtures/accounts.json`. To connect your own
systems, implement the provider-neutral interfaces in
`src/mastra/ports/index.ts` and wire them in
`src/mastra/composition/create-connectors.ts`. You can replace product usage,
support, billing, CRM reads, and CRM writes independently.

HubSpot is included as an optional CRM example, not a workflow dependency. It
replaces only CRM reads and writes, so align the HubSpot company ID with the
remaining fixtures or replace those connectors as well. See `.env.example` for
the optional HubSpot configuration.

## Making it yours

Connect your providers, adjust the review schedule and risk rules, or move CSM
approval into your application or CRM. Learn more about the
[Mastra primitives](./docs/mastra-primitives.md), [evals](./docs/evals.md),
[monitoring](./docs/monitoring.md), and
[structured contracts](./customer-success-contracts.md).

## About Mastra templates

[Mastra templates](https://mastra.ai/templates) are ready-to-use projects that
show what you can build—clone one, explore it in Studio, and make it yours. They
live in the [Mastra monorepo](https://github.com/mastra-ai/mastra) and are
automatically synced to standalone repositories.

Want to contribute? See [CONTRIBUTING.md](./CONTRIBUTING.md).
