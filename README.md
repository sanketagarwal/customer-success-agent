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
npm run validate
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

The demo then runs the at-risk account through the actual suspend/resume
workflow. A fixture CSM approves the bound artifacts, the fixture CRM creates
one inspectable internal note and four follow-up tasks, and a replay returns the
same write without duplication. A separate fixture run demonstrates rejection
with no CRM write.

## Mastra primitives

- `weekly-customer-success` is a scheduled workflow with bounded account fan-out.
- `customer-success-account` uses step retries, RequestContext identity, and a
  persisted suspend/resume approval gate.
- Model mode uses Zod-backed Mastra structured output, resource-scoped working
  memory, and optional observational memory and semantic recall.
- Connector-neutral Mastra tools expose account listing, CRM-note reads, and an
  approval-required CRM draft write. The deterministic workflow remains the
  authority for financial/customer-facing safety decisions.
- Typed operational memory remains authoritative for risk-score drift even when
  optional model memory is enabled.

## Approval flow

Run `customer-success-account` in Studio with a unique run ID. At-risk accounts
suspend at `request-csm-approval`. Resume that step with a decision containing
the exact `artifactHash` and `artifactAsOf` shown in the suspend payload, plus
the approver, decision time, and an expiry no later than the request expiry.
Rejected, expired, changed, or mismatched artifacts never reach the CRM writer.

### Approving a suspended run in Studio

The **Traces** view is observability-only. To approve a run, open **Workflows**,
select `customer-success-account`, choose the suspended run under **Recent
runs**, and open `request-csm-approval`. The step's suspend payload contains the
values the approval must be bound to:

```json
{
  "artifactHash": "<64-character SHA-256 hash>",
  "artifactAsOf": "<assessment timestamp>",
  "requestedAt": "<approval-request timestamp>",
  "expiresAt": "<maximum approval expiry>"
}
```

Studio renders the resume schema as a form:

| Studio field | Meaning | Value to provide |
| --- | --- | --- |
| `Decision` | Whether the CSM accepts the proposed artifacts | `approved` or `rejected` |
| `Approver Id` | Identity of the CSM making the decision | The authenticated CSM ID; it must match RequestContext `csm-id` when supplied |
| `Decided At` | When the decision was made | A trusted ISO timestamp |
| `Expires At` | Last instant the decision is valid | An ISO timestamp no later than the suspend payload's `expiresAt` |
| `Bound To Hash` | Fingerprint of the exact assessment, plan, and outreach reviewed | Copy `artifactHash` from the suspend payload |
| `Bound To As Of` | Source-data snapshot time reviewed by the CSM | Copy `artifactAsOf` from the suspend payload |
| `Feedback` | Optional CSM rationale or requested changes | Free text; monitoring records its presence, not its contents |

The fixture clock is deliberately pinned. For a fixture Studio run, use the
suspend payload's `requestedAt` as `Decided At`, its `expiresAt` as `Expires
At`, and its `artifactAsOf` as `Bound To As Of`. Date pickers may display those
same instants in the browser's local timezone.

`artifactHash` is generated automatically before suspension. The template
canonicalizes the structured assessment, account plan, and outreach draft,
adds a contract version, and calculates a SHA-256 hash. The assessment includes
the source snapshot hash, so the approval is indirectly bound to the verified
source data as well. If any bound artifact changes, the hash changes and the
old decision returns `stale_approval`. Immediately before writing, the workflow
also re-reads the sources and rejects the approval if the data has changed.

The CSM should not find or type hashes in a production interface. A host
application or CRM approval adapter receives the suspend payload, stores the
hash and timestamps as hidden fields, displays the human-readable assessment,
plan, and outreach, and sends the hidden values back to Mastra's resume API.
The CSM normally sees only **Approve**, **Reject**, and optional feedback.

The CSM approves in **Mastra Studio or the application calling Mastra's resume
API**, not in the CRM. When the host application knows the authenticated CSM,
put that identity in RequestContext as `csm-id`; the workflow rejects a payload
whose `approverId` does not match. A CRM-native approval experience is an
optional adapter: create a CRM task/button or webhook that calls the same Mastra
resume API. Approval semantics remain provider-neutral.

The three registered CRM tools are:

- `list-customer-accounts`
- `read-customer-crm-notes`
- `write-approved-customer-success-draft` (tool approval required)

The account workflow still performs its stronger artifact-bound CSM approval
before invoking a writer; tool approval is defense in depth for direct tool use.

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
MODEL_INPUT_COST_PER_MILLION=0
MODEL_OUTPUT_COST_PER_MILLION=0
```

The authoritative operational history remains the typed `AccountMemoryStore`;
model memory is contextual assistance, not the source of truth for drift.

To exercise structured output, working memory, observational memory, semantic
recall, and account-level token/cost capture together:

```bash
OPENAI_API_KEY=... npm run demo:model-memory
```

Set the two per-million pricing values for the selected model if non-zero cost
reporting is desired. Deterministic fixture runs correctly report zero tokens
and zero model cost.

## Evals and monitoring

`npm run evals` executes credential-free scorer gates against the fixture
dataset. Supported outputs must score `1`; fabricated evidence, generic
outreach, and irrelevant actions must score `0`. The gates cover risk-factor
extraction, account-plan quality, unsupported claims, outreach personalization,
and action relevance.

`npm run monitoring:report` produces tenant and account summaries for:

- latest risk score and score drift
- recommendation and accepted-recommendation counts
- approval decisions and outreach approvals
- human-feedback counts (feedback text is not emitted)
- token usage, configured model cost, average latency, and p95 latency

Monitoring events are durable in LibSQL through `MonitoringStore`. Mastra's
storage exporter continues to retain redacted execution spans for trace-level
inspection.

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
customer record. Associated notes and tasks are read in HubSpot-sized batches,
so accounts with more than 100 timeline records remain supported.

### Verifying an approved write in HubSpot

Fixture-mode approvals write only to the in-memory mock CRM and never appear in
HubSpot. After an explicitly configured `DATA_SOURCE=hubspot` run is approved,
open **CRM → Companies**, select the company whose ID matches the workflow
`accountId`, and inspect its activity timeline. Filter the timeline to **Notes**
and **Tasks** if needed.

The associated note is headed **Customer Success review draft — internal
only** and contains the health status and score, grounded summary, account-plan
actions, and outreach marked **not sent**. Each approved plan action also
appears as an associated `NOT_STARTED` task with its owner-independent subject,
rationale, due date, and priority. The same tasks can be viewed from HubSpot's
task workspace and filtered by the associated company. No marketing or sales
email appears because this template deliberately never invokes an email API.

For a report, capture the Mastra suspended approval, the completed workflow
output containing its `writeId`, the HubSpot company note, and the associated
task list. The approval itself remains in Mastra unless an adopter implements a
CRM-native approval button or webhook that calls Mastra's resume API.

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

HubSpot is an example adapter, not a template requirement. Adopters can replace
any combination of `UsageRepository`, `SupportRepository`, `BillingRepository`,
`CrmRepository`, and `CrmWriter` without changing schemas, workflows, approval,
evals, or monitoring.

## Architecture

- `schemas/`: canonical Zod contracts
- `ports/`: provider-neutral dependencies
- `adapters/fixture/`: deterministic fixtures and mock CRM writer
- `adapters/model/`: Mastra structured-output intelligence
- `adapters/hubspot/`: HubSpot CRM reader/writer
- `memory/`: durable operational account, approval, idempotency, and CRM write-intent state
- `monitoring/`: account/tenant metrics aggregation
- `services/`: grounding, drift, and account orchestration
- `tools/`: connector-neutral Mastra CRM tools
- `workflows/`: account approval workflow and scheduled isolated fan-out
- `scorers/`: groundedness, extraction, plan, personalization, and relevance

## Build order

The implementation follows: data layer → assessment and groundedness → memory
and drift → plan and outreach → approval and CRM write → scheduling and
observability → HubSpot adapter. The groundedness tests deliberately fabricate
references, values, assessment prose, plan rationales, and outreach claims;
each must be rejected before the pipeline can proceed.

`npm run validate` is the CI contract: typecheck → unit/integration tests → eval
gates → complete fixture demo → monitoring assertions → production build. CI
also runs the production dependency audit after validation.

## Verified API baseline

The project was scaffolded with `create-mastra` 1.25.0 and pins
`@mastra/core` 1.59.0, `@mastra/libsql` 1.20.0, `@mastra/memory` 1.26.2, and
`@mastra/observability` 1.17.0. The deployer is held at 1.59.0 because 1.60.0
logs a virtual-entrypoint path error during an otherwise successful build. API
usage was checked against the documentation bundled with those packages and
the official Mastra and HubSpot documentation.

## Pullfrog review gate

`.github/workflows/pullfrog.yml` is Pullfrog's official manual dispatch
workflow; it does not make Pullfrog run on every PR by itself. Automatic PR
reviews require the Pullfrog GitHub App to be installed for this repository and
PR-review automation to be enabled in Pullfrog. CI runs independently on every
PR and every push to `main`. Project code should not be merged until
`CI / validate` passes and, when the app is configured, Pullfrog has completed
its review.
