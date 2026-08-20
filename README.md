# Customer Success Agent

A scheduled agent that finds at-risk customer accounts before renewal and
coordinates the follow-up. It reads product usage, support history, billing
status, and CRM notes; creates a health assessment and account plan; drafts
outreach; waits for CSM approval; then records approved notes and tasks in the
configured CRM.

## Demo

This demo runs in Mastra Studio, but you can connect the workflow to your React,
Next.js, or Vue app using the Mastra Client SDK or agentic UI libraries like AI
SDK UI, CopilotKit, or Assistant UI.

The included fixtures let you try the complete flow without connecting customer
systems. An OpenAI model generates the assessment, plan, and outreach.

## Prerequisites

- Node.js 22.13 or newer
- An OpenAI API key
- Git with access to this GitHub repository

## Quickstart 🚀

```bash
git clone https://github.com/sanketagarwal/customer-success-agent.git
cd customer-success-agent
cp .env.example .env
npm install
```

After this template is published in Mastra's catalog, it can be installed with
`npx create-mastra@latest customer-success-agent --template customer-success-agent`
instead.

Add `OPENAI_API_KEY` to `.env`, then start Mastra Studio:

```bash
npm run dev
```

Open [localhost:4111](http://localhost:4111).

## Using it

Open **Workflows**, select `customer-success-account`, and click **Run**. The
fixture account ID is already filled in.

The workflow reads each source, prepares the assessment, plan, and outreach,
then pauses at `request-csm-approval`. Approve it as `demo-csm` to create the
internal CRM note and follow-up tasks. The outreach remains a draft and is not
sent automatically.

`weekly-customer-success` runs the same review for every account returned by
the configured CRM connector.

## Connecting real data

The demo reads from `data/fixtures/accounts.json`. To use your own systems,
implement the interfaces in `src/mastra/ports/index.ts` and connect them in
`src/mastra/composition/create-connectors.ts`. Product usage, support, billing,
CRM reads, and CRM writes can be replaced independently.

HubSpot is included as an optional CRM adapter. Set `CRM_PROVIDER=hubspot` and
`HUBSPOT_PRIVATE_APP_TOKEN` to enable it. This replaces only CRM reads and
writes; the HubSpot company ID must match the remaining fixtures, or you must
replace the usage, support, and billing connectors too.

## Making it yours

- Connect the data sources and CRM your company uses.
- Adjust the risk rules, review schedule, and account-plan actions.
- Move CSM approval into your application or CRM.
- Extend the included evals and monitoring for your production data.

Implementation details are documented in
[Mastra primitives](./docs/mastra-primitives.md), [evals](./docs/evals.md), and
[monitoring](./docs/monitoring.md).

## About Mastra templates

Mastra templates are ready-to-use projects that show what you can build. Use
the generated repository as your starting point, then customize it for your
application.

Want to contribute? See the
[Mastra contributing guide](https://github.com/mastra-ai/mastra/blob/main/CONTRIBUTING.md).
