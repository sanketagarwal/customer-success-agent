# Customer Success Renewal and Churn-Risk Agent

A scheduled Mastra template that reviews every customer account, produces an
evidence-grounded health assessment, tracks drift, drafts an account plan and
outreach, waits for CSM approval, and writes the approved draft to CRM exactly
once. Customer-facing outreach is never sent automatically.

The complete fixture path runs without credentials. HubSpot is implemented
behind the same CRM ports and is enabled only when explicitly configured.

## Safety properties

- Structured evidence points to an exact source, record, field, window, and
  primitive value.
- Customer-specific assessment, plan, and outreach prose is deterministically
  rendered from verified facts; arbitrary generated prose cannot pass the gate.
- Request tenant/account/as-of identity overrides model output.
- Provider outages produce `unknown_retry`; successful empty reads can produce
  `insufficient_data`.
- Account memory is scoped to `(tenantId, accountId)`.
- Approvals bind to a canonical artifact hash, expire, and are rechecked against
  source records through CRM-write time.
- CRM writes are draft/internal-only and use durable write intents plus CRM
  markers for idempotency across retries and process restarts.
- Scheduled accounts run independently; one failure does not stop the batch.
- CRM notes, support subjects, drafts, feedback, credentials, and emails are
  redacted from traces; raw free text is removed before model prompts are built.

## Quick start

Requirements: Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env
npm run check
npm run demo
npm run dev
```

Mastra Studio starts at `http://localhost:4111`. The account workflow and the
weekly scheduled workflow appear under Workflows. Fixture time is deliberately
pinned by `FIXTURE_NOW` so demos and tests remain repeatable.

Expected demo outcomes:

| Account | Outcome |
| --- | --- |
| `340739743463` | `no_action` |
| `340734348989` | `awaiting_approval` |
| `340737895140` | `insufficient_data` |
| `340878324429` | `unknown_retry` |

## Approval flow

Run `customer-success-account` in Studio with a unique run ID. At-risk accounts
suspend at `request-csm-approval`. Resume that step with a decision containing
the exact `artifactHash` and `artifactAsOf` shown in the suspend payload, plus
the approver, decision time, and an expiry no later than the request expiry.
Rejected, expired, changed, or mismatched artifacts never reach the CRM writer.

## Model-backed generation and memory

Fixtures default to deterministic generation so clone-and-run needs no API key.
To use Mastra structured model output:

```env
GENERATION_MODE=model
MODEL=openai/gpt-5-mini
OPENAI_API_KEY=...
```

Working memory is configured with resource scope. Observational memory and
semantic recall are opt-in because both incur model calls:

```env
ENABLE_OBSERVATIONAL_MEMORY=true
ENABLE_SEMANTIC_RECALL=true
EMBEDDING_MODEL=openai/text-embedding-3-small
```

The authoritative operational history remains the typed `AccountMemoryStore`;
model memory is contextual assistance, not the source of truth for drift.

## HubSpot

Set:

```env
DATA_SOURCE=hubspot
TENANT_ID=your-tenant
FIXTURE_TENANT_ID=demo-tenant
HUBSPOT_PRIVATE_APP_TOKEN=...
HUBSPOT_BASE_URL=https://api.hubapi.com
HUBSPOT_RENEWAL_PROPERTY=renewal_date
```

Required private-app access must permit reading companies, notes, tasks, and
association labels and creating notes and tasks. The writer creates an internal
note containing the health summary, account plan, and draft outreach, then
creates idempotent follow-up tasks from the approved plan due dates. Hidden
idempotency markers make partial retries safe. It never calls an email-sending
API. Non-idempotent create requests are attempted once; if a response is
ambiguous, the adapter re-reads the company associations and reconciles the
marker instead of blindly replaying the POST. A LibSQL write intent is claimed
atomically before each create, so a reconciliation error or process restart
cannot lose the ambiguity guard. Response parsing and local intent-completion
failures also preserve the pending claim after HubSpot may have committed. If
HubSpot never exposes a marker after an ambiguous response, the intent
deliberately remains pending for manual review rather than risking a duplicate
customer record.

Set `HUBSPOT_RENEWAL_PROPERTY` to the internal name of your HubSpot company
renewal-date property. Create that property in HubSpot first if the portal does
not already have one.

Usage, support, and billing remain fixture-backed in v1. Replace fixture account
IDs with the corresponding HubSpot company IDs so signals join correctly, or
implement new adapters against their existing ports. `FIXTURE_TENANT_ID` names
the tenant stored in the bundled fixture file, while `TENANT_ID` remains the
runtime tenant exposed to the workflow. Hybrid runs deliberately use
`FIXTURE_NOW` as their clock so the bundled evidence does not age out; switch to
a system clock when all source ports are backed by live providers.

## Architecture

- `schemas/`: canonical Zod contracts
- `ports/`: provider-neutral dependencies
- `adapters/fixture/`: deterministic fixtures and mock CRM writer
- `adapters/model/`: Mastra structured-output intelligence
- `adapters/hubspot/`: HubSpot CRM reader/writer
- `memory/`: durable operational account, approval, idempotency, and CRM write-intent state
- `services/`: grounding, drift, and account orchestration
- `workflows/`: account approval workflow and scheduled isolated fan-out
- `scorers/`: groundedness, extraction, plan, personalization, and relevance

## Build order

The implementation follows: data layer → assessment and groundedness → memory
and drift → plan and outreach → approval and CRM write → scheduling and
observability → HubSpot adapter. The groundedness tests deliberately fabricate
references, values, assessment prose, plan rationales, and outreach claims;
each must be rejected before the pipeline can proceed.

## Verified API baseline

The project was scaffolded with `create-mastra` 1.25.0 and pins
`@mastra/core` 1.59.0, `@mastra/libsql` 1.20.0, `@mastra/memory` 1.26.2, and
`@mastra/observability` 1.17.0. API usage was checked against the documentation
bundled with those packages and the official Mastra and HubSpot documentation.

## Pullfrog review gate

The repository includes Pullfrog's official dispatch workflow. The repository
owner must install the Pullfrog GitHub App, select this repository in the
Pullfrog console, configure model access, and enable the PR-review automation.
Project code must not be merged to `main` until both `CI / validate` and the
configured Pullfrog review pass.
