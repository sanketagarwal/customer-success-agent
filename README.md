# Customer Renewal Risk and Recovery

Give the workflow a customer account ID and it combines product usage, support, billing, and CRM signals into an evidence-backed health assessment, owned recovery plan, and outreach draft. At-risk plans wait for CSM approval before the workflow records an internal CRM note and follow-up tasks.

## Why we built this

Renewal risk rarely lives in one system. A drop in adoption can look harmless until it appears alongside an urgent support ticket, overdue billing, and negative customer sentiment.

This template brings those signals together early enough for a customer success team to act, while keeping the assessment explainable and the final CRM update under human control.

## Features

- Reviews usage, support, billing, and CRM signals for one customer account
- Explains the health score with the exact risks and evidence behind it
- Produces an owned recovery plan and customer outreach that remains a draft
- Handles healthy accounts and missing data without inventing risk
- Pauses at-risk reviews for CSM approval before creating CRM records

## Prerequisites

- [Node.js 22.13 or newer](https://nodejs.org/en/download)
- A model-provider API key (`OPENAI_API_KEY` for the default `openai/gpt-5-mini`). Swap `MODEL` to another supported `provider/model-name` with tool-calling and structured-output support, and supply that provider's key.
- A HubSpot private-app token for your customer data, or your own `CustomerDataSource` implementation.

## Quickstart

1. Run `npx create-mastra@latest --template customer-renewal-risk-and-recovery`.
2. Copy `.env.example` to `.env` and configure your model and data source:

   ```dotenv
   GENERATION_MODE=model
   MODEL=openai/gpt-5-mini
   OPENAI_API_KEY=your-provider-key
   DATA_SOURCE=hubspot
   HUBSPOT_PRIVATE_APP_TOKEN=your-hubspot-token
   ```

3. Run `npm run dev`, open [localhost:4111](http://localhost:4111), and select **Workflows → renewal-risk-review**. Enter your HubSpot company ID.

The model drafts outreach; the connected data source supplies customer facts.

## Optional fixture demo

For a credential-free workflow demo, keep `DATA_SOURCE=fixture` and `GENERATION_MODE=deterministic`. Agent chat still requires a model-provider key.

| Account ID | Scenario | Expected result |
| --- | --- | --- |
| `340734348989` | Falling adoption, urgent support, overdue billing, and negative sentiment | Pauses for approval |
| `340739743463` | Healthy adoption and positive account signals | Completes with `no_action` |
| `340737895140` | Too few reliable signals | Completes with `insufficient_data` |

Run **weekly-renewal-review** with `{}` for the portfolio. Resume pending approvals using the returned `runId` at `request-csm-approval`.

## Connect HubSpot

Grant the private app read access to companies, tickets, invoices, and feedback, plus write access for notes and tasks. Set `HUBSPOT_RENEWAL_PROPERTY` for a custom renewal field; use `SIGNALS_API_URL` and `SIGNALS_API_TOKEN` for product-usage data. Outreach is never sent.

## Making it yours

Implement [CustomerDataSource](src/mastra/data.ts) for other systems, adjust [risk rules and action ownership](src/mastra/workflows/account.ts), or change `CUSTOMER_SUCCESS_CRON`. Custom adapters should checkpoint each write and use `WriteNotAppliedError` only for confirmed non-writes.

Keep `MASTRA_DB_URL` persistent and reconcile uncertain CRM writes before retrying. On upgrades, stop old writers and reapply any schedule pause to `wf_weekly-renewal-review`. Fixtures are not bundled for deployment.

## About Mastra templates

Mastra templates are ready-to-use projects that show what you can build with Mastra. Clone one, try it in Studio, and adapt it to your use case.

Want to contribute? Open an issue or pull request in the [canonical repository](https://github.com/sanketagarwal/customer-success-agent).
