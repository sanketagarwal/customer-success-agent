# Customer Success Agent

A scheduled agent that finds accounts at risk before renewal and coordinates the follow-up. It reads product usage, support, billing, and CRM data; prepares a health assessment, account plan, and outreach draft; waits for CSM approval; then creates the CRM note and follow-up tasks.

## Demo

The template runs end to end in Mastra Studio with included fixtures. No customer systems are required.

## Prerequisites

- Node.js 22.13 or newer
- npm
- An OpenAI API key

## Quickstart 🚀

```bash
git clone https://github.com/sanketagarwal/customer-success-agent.git
cd customer-success-agent
cp .env.example .env
npm install
```

Add `OPENAI_API_KEY` to `.env`, then run:

```bash
npm run dev
```

Open [localhost:4111](http://localhost:4111), select **Workflows → customer-success-account**, and click **Run**. The at-risk fixture account is prefilled.

The workflow has four steps:

1. Collect account data
2. Prepare the complete review
3. Request CSM approval
4. Update the CRM and create follow-up tasks

Approve as `demo-csm`. The completed run output contains the fixture CRM note and task IDs. Nothing is sent to a customer automatically.

## HubSpot demo

To write the approved note and tasks to HubSpot, update `.env`:

```bash
CRM_PROVIDER=hubspot
HUBSPOT_PRIVATE_APP_TOKEN=your-private-app-token
```

Restart Studio and run a company ID that also exists in `data/fixtures/accounts.json`, such as `340734348989`. After approval, open that company in HubSpot to see the internal note and associated tasks.

This is intentionally a hybrid demo: usage, support, and billing remain fixture-backed while CRM reads and writes use HubSpot. The connector boundary in `src/mastra/connectors.ts` lets you replace each source independently.

## Making it yours

- Replace fixture methods in `src/mastra/connectors.ts` with your APIs or database queries.
- Use `src/mastra/hubspot.ts` as an example, not a required CRM.
- Adjust the schedule, model, memory, and risk behavior through `.env` and `src/mastra/reviewer.ts`.

See [Mastra primitives](./docs/mastra-primitives.md), [evals](./docs/evals.md), and [monitoring](./docs/monitoring.md) for implementation details.
