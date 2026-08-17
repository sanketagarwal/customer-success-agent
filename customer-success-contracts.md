# Customer Success Agent Contracts

This document defines the provider-neutral domain boundary for the scheduled
customer-success workflow. The TypeScript schemas in `src/mastra/schemas` are
the executable form of these contracts.

## 1. Identity, time, and source semantics

- `tenantId` and `accountId` are opaque, non-empty strings. `accountId` is
  provider-neutral; the HubSpot adapter uses the HubSpot company ID as its v1
  value without exposing HubSpot-specific fields to the workflow.
- Every repository read receives an explicit inclusive `window` with ISO-8601
  `start` and `end` values.
- A read returns one of three states: `available`, `empty`, or `unavailable`.
  `empty` means the provider answered successfully with no records.
  `unavailable` is retryable and maps to `unknown_retry`.
- Time-dependent code receives a `Clock`; domain code never reads wall-clock
  time directly.

## 2. Canonical schemas

### Evidence

`EvidenceRef` is a deterministic pointer containing `source`, `recordId`,
`fieldPath`, and `window`. `Evidence` adds the displayed `metricOrQuote` and a
required observed `value`. Evidence resolution succeeds only when the record,
field path, time window, and exact primitive value resolve in the normalized
source snapshot used for the run. Customer-specific prose is rendered from
these verified facts; arbitrary generated prose cannot pass the deterministic
grounding gate.

The canonical schemas are:

- `UsageSeries`: tenant/account/window plus timestamped usage points.
- `SupportHistory`: tenant/account/window plus support tickets.
- `BillingStatus`: tenant/account/as-of billing and renewal state.
- `CrmNotes`: tenant/account/window plus normalized CRM notes.
- `RiskFactor`: stable ID, category, severity, status, explanation, and one or
  more evidence items.
- `HealthAssessment`: score, status, summary, risk factors, data completeness,
  source snapshot hash, and `asOf`.
- `AccountMemory`: scoped, versioned assessment/plan history.
- `Drift`: score direction plus new, worsening, improving, persistent, and
  resolved factor IDs.
- `AccountPlan`: evidence-backed goals and actions.
- `OutreachDraft`: a draft-only subject/body with evidence-backed claims.
- `RunOutcome`: `no_action`, `action_required`, `awaiting_approval`,
  `approved`, `rejected`, `written`, `insufficient_data`, `unknown_retry`,
  `grounding_failed`, `stale_approval`, or `failed`.

### Approval

An approval binds the approver and decision to a canonical artifact-bundle
hash, the bundle's `asOf`, an approval timestamp, and an expiry timestamp. The
hash is SHA-256 over versioned canonical JSON containing the assessment, plan,
and outreach draft. A write is forbidden when the hash changes or the approval
is expired. Rejection and expiry never write.

## 3. Ports

The application depends only on these interfaces:

- `UsageRepository`
- `SupportRepository`
- `BillingRepository`
- `CrmRepository`
- `CrmWriter`
- `AccountMemoryStore`
- `ApprovalStore`
- `Clock`
- `CustomerSuccessIntelligence`

Fixture and HubSpot modules are adapters. Workflow steps receive only narrow
dependencies from the composition root and never inspect `process.env`.

## 4. Invariants

- `scopeKey(tenantId, accountId)` is mandatory for operational memory and model
  memory resources. No lookup may omit either component.
- `idempotencyKey(tenantId, accountId, artifactType, runOrAsOf)` identifies one
  logical CRM mutation. Replays return the original result.
- `evidenceResolves(ref, sources)` is deterministic and provider-neutral.
- Evidence must match the exact primitive source value and source window;
  customer-specific prose is rendered only from verified evidence.
- Request-scoped tenant/account/as-of values are authoritative. A model cannot
  supply or override identity fields used for memory, approval, or CRM writes.
- Approval freshness is checked through write time, so records arriving after
  assessment force a new assessment and approval.
- A source transport failure maps to `unknown_retry`, never to missing data.
- A first run creates a baseline; drift begins on the second assessment.
- Healthy accounts exit before plan and outreach generation.
- CRM output is draft/internal-only. This template never sends outreach.
- HubSpot create requests are not blindly retried after ambiguous responses;
  the adapter reconciles its hidden marker before continuing.
- One account failure cannot terminate the scheduled batch.

## 5. Data handling

CRM note bodies, outreach bodies, CSM feedback, tokens, email addresses, and
other free-text customer data are sensitive. Observability must retain account
and run correlation while redacting these values from trace inputs, outputs,
and attributes. Raw CRM note bodies and support subjects must be removed before
serialized model prompts are created. Tests must verify both shapes.
