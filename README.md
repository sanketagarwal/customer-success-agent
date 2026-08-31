# Customer Success Renewal Agent

Give the workflow a customer account ID and it combines product usage, support, billing, and CRM signals into an evidence-backed health assessment, owned recovery plan, and outreach draft. At-risk plans wait for CSM approval before the agent records an internal CRM note and follow-up tasks.

## Why we built this

Renewal risk rarely lives in one system. A drop in adoption can look harmless until it appears alongside an urgent support ticket, overdue billing, and negative customer sentiment.

This template brings those signals together early enough for a customer success team to act, while keeping the assessment explainable and the final CRM update under human control.

## Features

- Reviews usage, support, billing, and CRM signals for one customer account
- Explains the health score with the exact risks and evidence behind it
- Produces an owned recovery plan and customer outreach that remains a draft
- Handles healthy accounts and missing data without inventing risk
- Pauses at-risk reviews for CSM approval before creating CRM records

## Quick start

Requires Node.js 22.13 or newer.

### 1. Clone the template

Run:

```bash
npx create-mastra@latest --template customer-success-agent
cd customer-success-agent
```

### 2. Add your API keys

Copy the example environment file:

```bash
cp .env.example .env
```

The included fixture demo runs without API keys. Leave `DATA_SOURCE=fixture` and `GENERATION_MODE=deterministic` for the first run.

### 3. Start the dev server

```bash
npm run dev
```

Open [Mastra Studio](http://localhost:4111), select **Workflows → customer-success-account**, and run the prefilled account `340734348989`. Redwood Retail receives a 5/100 health score for falling adoption, an urgent support ticket, overdue billing, and negative sentiment. The workflow proposes four follow-up actions and an outreach draft, then pauses at `request-csm-approval` without writing to a CRM.

Expand the approval request to review its evidence and actions. Resume with `approved` and an approver ID such as `demo-csm`; the completed fixture run returns an internal note ID and four task IDs. The outreach remains a draft and is never sent.

## Try the other outcomes

The bundled accounts cover the workflow's main decisions:

| Account ID | Scenario | Expected result |
| --- | --- | --- |
| `340734348989` | Falling adoption, urgent support, overdue billing, and negative sentiment | Pauses for approval |
| `340739743463` | Healthy adoption and positive account signals | Completes with `no_action` |
| `340737895140` | Too few reliable signals | Completes with `insufficient_data` |

Run **Workflows → weekly-customer-success** with `{}` to review the complete fixture portfolio. Healthy and insufficient-data accounts complete automatically; at-risk accounts are returned as `awaiting_approval` for individual review.

## Connect HubSpot

Set `DATA_SOURCE=hubspot` and add `HUBSPOT_PRIVATE_APP_TOKEN` to read companies, tickets, invoices, and feedback from HubSpot. Approved reviews create an internal note and associated tasks; the workflow never calls an email-sending API.

The private app needs read access to the relevant CRM objects plus permission to create notes and tasks. Set `HUBSPOT_RENEWAL_PROPERTY` when the portal uses a different internal property name for renewal dates. Add `SIGNALS_API_URL` and `SIGNALS_API_TOKEN` when product usage comes from a separate normalized endpoint.

## Making it yours

- Connect your product analytics and CRM systems through the existing customer data source boundary.
- Adjust the risk thresholds, action ownership, approval policy, or portfolio schedule to match your customer success process.

## About Mastra templates

Mastra templates are ready-to-use projects that show what you can build with Mastra. Clone one, try it in Studio, and adapt it to your use case.

Want to contribute? See the [customer success template contributing guide](https://github.com/mastra-ai/mastra/blob/main/templates/template-customer-success-agent/CONTRIBUTING.md).
