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
- No API key is required for the included fixture demo

## Quickstart

1. **Clone the template**
   - Run `npx create-mastra@latest --template customer-renewal-risk-and-recovery` to scaffold the project locally.
2. **Set up the environment**
   - Copy `.env.example` to `.env`. The defaults use fixture data and deterministic generation, so the demo runs without credentials.
3. **Start the dev server**
   - Run `npm run dev` and open [localhost:4111](http://localhost:4111). Select **Workflows → renewal-risk-review** and run the default Redwood Retail account; the account ID and data provider can be updated.

## Run the demo

The bundled accounts cover the workflow's main decisions:

| Account ID | Scenario | Expected result |
| --- | --- | --- |
| `340734348989` | Falling adoption, urgent support, overdue billing, and negative sentiment | Pauses for approval |
| `340739743463` | Healthy adoption and positive account signals | Completes with `no_action` |
| `340737895140` | Too few reliable signals | Completes with `insufficient_data` |

Run **Workflows → weekly-renewal-review** with `{}` to review the complete fixture portfolio. Healthy and insufficient-data accounts complete automatically; at-risk accounts return `awaiting_approval` and their individual `runId` for review and resumption at `request-csm-approval`.

## Connect HubSpot

Set `DATA_SOURCE=hubspot` and add `HUBSPOT_PRIVATE_APP_TOKEN` to read companies, tickets, invoices, and feedback from HubSpot. Approved reviews create an internal note and associated tasks; the workflow never calls an email-sending API.

The private app needs read access to the relevant CRM objects plus permission to create notes and tasks. Set `HUBSPOT_RENEWAL_PROPERTY` when the portal uses a different internal property name for renewal dates. Add `SIGNALS_API_URL` and `SIGNALS_API_TOKEN` when product usage comes from a separate normalized endpoint.

## Making it yours

Fixtures are for the local demo. Deployments should connect HubSpot or implement `CustomerDataSource` for their own systems; demo fixtures are not copied into the deployment bundle.

- Connect your product analytics and CRM systems through the existing customer data source boundary.
- Adjust the risk thresholds, action ownership, approval policy, or portfolio schedule to match your customer success process.

Keep `MASTRA_DB_URL` on persistent storage. Each successful CRM task/note is checkpointed, so a confirmed rejected request can be retried without repeating completed writes. A timeout or other uncertain outcome stays pending until the remote records are reconciled; do not clear that claim blindly. Custom adapters should use the optional `checkpoint` callback for each write and throw `WriteNotAppliedError` only when the provider confirms the operation was not applied.

Legacy customer-success workflow IDs remain available for saved runs, without adding a second schedule. The `customerSuccessAgent` API key aliases `renewalRiskAgent`; both use the same agent. Existing `cs_reviews` records are copied into renewal history without deleting the originals. Workflow approval records retain the supplied approver ID; authenticated integrations can also supply `reviewer-id` through request context for tool approvals. The save tool uses the stored workflow review rather than model-supplied review content.

When upgrading, stop old writers before starting this version. The renamed weekly workflow creates a new schedule: its old pause status is not carried over. A previously paused schedule must be paused again as `wf_weekly-renewal-review` in Studio; plan this as a maintenance change, not a drop-in rename.

Run `npm run validate` for type checking, regression tests, fixture evaluations, and the production build; CI runs the same checks on Node 22.13. The bundled scorers are structural checks; they do not establish factual accuracy of model-generated outreach.

## About Mastra templates

Mastra templates are ready-to-use projects that show what you can build with Mastra. Clone one, try it in Studio, and adapt it to your use case.

Want to contribute? Open an issue or pull request in the [canonical repository](https://github.com/sanketagarwal/customer-success-agent).
