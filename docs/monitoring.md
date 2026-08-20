# Monitoring and observability

The template has two complementary monitoring layers:

1. Business monitoring records stable, typed customer-success metrics in the
   operational store.
2. Mastra observability records redacted execution traces for workflows, steps,
   agents, and tools.

Keeping these layers separate makes dashboards stable even when trace schemas
or model providers change.

## Business monitoring events

`monitoringEventSchema` in `src/mastra/schemas/index.ts` defines the event
contract. Every event includes correlation and timing fields plus the metrics
needed for tenant and account reporting.

| Field                                        | Meaning                                                        |
| -------------------------------------------- | -------------------------------------------------------------- |
| `eventId`                                    | Unique event identifier                                        |
| `runId`                                      | Mastra/account workflow run identifier                         |
| `tenantId`, `accountId`                      | Reporting scope                                                |
| `phase`                                      | `assessment` or `approval`                                     |
| `outcome`                                    | Terminal domain outcome for that phase                         |
| `riskScore`                                  | Current health score, or null when no assessment exists        |
| `scoreDelta`                                 | Change from the prior assessment                               |
| `recommendationCount`                        | Number of proposed plan actions                                |
| `acceptedRecommendationCount`                | Actions counted as accepted after a successful write           |
| `approvalDecision`                           | Approved, rejected, or null                                    |
| `outreachApproved`                           | True only when the approved draft was written                  |
| `hasHumanFeedback`                           | Whether feedback was supplied, without storing it in the event |
| `inputTokens`, `outputTokens`, `totalTokens` | Account-level generation usage                                 |
| `costUsd`                                    | Configured estimate for model generation                       |
| `latencyMs`                                  | Phase execution latency                                        |
| `recordedAt`                                 | Operational clock timestamp                                    |

## Event emission points

`src/mastra/services/customer-success-service.ts` emits events at two points.

### Assessment event

`prepare()` measures the complete preparation phase and records:

- outcome, including `no_action`, `awaiting_approval`, `insufficient_data`,
  `unknown_retry`, or `grounding_failed`;
- current risk score and drift;
- proposed recommendation count;
- model token usage and configured cost;
- preparation latency.

Retries produce separate assessment events because each call to `prepare()` is
an observable attempt. This makes provider instability visible rather than
hiding it inside the final result.

### Approval event

`finalize()` records:

- the CSM decision;
- whether the outreach draft reached CRM;
- accepted recommendation count when the outcome is `written`;
- whether optional human feedback was present;
- approval/freshness/write latency.

Approval events do not repeat generation tokens or generation cost, so those
values are zero for the approval phase.

## Model token and cost accounting

`MastraCustomerSuccessIntelligence` accumulates usage across assessment, plan,
and outreach generation for each tenant/account key. `prepare()` consumes and
clears that usage once the run completes.

Set the selected model's prices explicitly:

```env
MODEL_INPUT_COST_PER_MILLION=0
MODEL_OUTPUT_COST_PER_MILLION=0
```

The estimate is:

```text
(input tokens × input price + output tokens × output price) / 1,000,000
```

The defaults are zero because prices vary by model, provider, contract, and
date. The template never guesses a price. Fixture mode correctly records zero
tokens and zero cost.

## Operational storage

`MonitoringStore` is provider-neutral. The production implementation,
`LibSqlOperationalStore`, stores events in `cs_monitoring_events`:

```text
event_id | tenant_id | recorded_at | payload
```

- `event_id` is the primary key, so replaying the same event ID replaces it.
- `tenant_id` supports scoped reads.
- `recorded_at` and SQLite row order provide deterministic event order when
  fixture timestamps tie.
- `payload` contains the Zod-validated event JSON.

The fixture runtime uses `InMemoryOperationalStore`, which implements the same
interface. Set `MASTRA_DB_URL` and optional `TURSO_AUTH_TOKEN` to move the
durable implementation to a remote LibSQL/Turso database.

## Aggregated report

Run:

```bash
npm run monitoring:report
```

`scripts/monitoring-report.ts` executes the fixture accounts, approves one
at-risk account, builds a report, prints JSON, and asserts the expected totals.
This makes monitoring behavior part of CI rather than an untested example.

`buildCustomerSuccessMonitoringReport()` in
`src/mastra/monitoring/customer-success-report.ts` returns tenant totals and
per-account summaries.

Tenant totals include:

- assessment runs;
- approval decisions;
- accepted recommendations;
- outreach approvals;
- human-feedback count;
- tokens and configured cost;
- average and p95 latency.

Account summaries include the latest risk score and score delta plus account
counts, tokens, cost, and average latency.

The report expects events in store order. LibSQL queries order equal timestamps
by insertion row ID, so the latest assessment remains deterministic when a
fixture clock is pinned.

## Suggested production indicators

The stored fields support the requested operational indicators without parsing
traces:

| Indicator                    | Calculation                                               |
| ---------------------------- | --------------------------------------------------------- |
| Risk-score drift             | Latest assessment `riskScore` and `scoreDelta` by account |
| Accepted recommendations     | Sum of `acceptedRecommendationCount`                      |
| Outreach approvals           | Count where `outreachApproved` is true                    |
| Approval rate                | Approved decisions divided by all decisions               |
| Rejection rate               | Rejected decisions divided by all decisions               |
| Human-feedback participation | Count or rate where `hasHumanFeedback` is true            |
| Account cost                 | Sum `costUsd` by tenant/account                           |
| Latency                      | Average and p95 `latencyMs`                               |
| Retry pressure               | Assessment attempts ending in `unknown_retry`             |
| Grounding failures           | Assessment attempts ending in `grounding_failed`          |

For production dashboards, export or query `MonitoringStore` events from the
organization's metrics stack. Keep the domain event schema stable and version
new fields deliberately.

## Recommendation acceptance semantics

A recommendation is counted as accepted only when the final outcome is
`written`. Approval alone is not enough: stale approval, changed source data,
provider failure, or CRM write failure produces zero accepted recommendations.

This is intentionally conservative. If adopters need partial action acceptance,
extend the approval contract with selected action IDs and change the event
calculation and evals together.

## Human feedback privacy

The approval decision can contain optional feedback for the operational audit
record. Monitoring stores only `hasHumanFeedback`; it never copies the feedback
text into metrics.

Mastra observability also redacts the `feedback` field. Downstream exporters and
dashboards should preserve this separation: aggregate presence and ratings, not
raw customer or employee text, unless a separately governed system requires it.

## Mastra observability and traces

`src/mastra/index.ts` configures:

- `Observability` as the trace pipeline;
- `MastraStorageExporter` with realtime persistence;
- `SensitiveDataFilter` as a span output processor;
- tenant and account RequestContext keys for correlation;
- application logging disabled in the observability configuration.

Open Mastra Studio and use the workflow's **Traces** view to inspect workflow,
step, agent, and tool timing. Traces explain an individual execution; the
business report explains trends across accounts and runs.

The LibSQL observability domain supports the trace inspection used by this
template. Some Mastra Studio versions may also request optional discovery or
feedback operations that the selected LibSQL storage version does not
implement, producing capability warnings. Those optional warnings do not
replace or invalidate the typed monitoring events described above.

## Redaction model

The `SensitiveDataFilter` redacts fields named:

- authorization;
- token;
- body;
- subject;
- feedback;
- notes and `crmNotes`;
- email.

Redaction is defense in depth. Before model calls, the model adapter replaces
support subjects and CRM bodies with `[REDACTED]` and removes CRM author IDs.
This prevents raw free text from entering serialized prompts and traces in the
first place.

`tests/redaction.test.ts` verifies both prompt preprocessing and span filtering.

## Testing monitoring changes

When adding a metric:

1. Extend `monitoringEventSchema` with an explicit type and privacy decision.
2. Populate it in the appropriate service phase.
3. Update both operational store implementations if persistence shape changes.
4. Add tenant and account aggregation logic.
5. Extend `tests/template-primitives.test.ts` with event and report assertions.
6. Extend `scripts/monitoring-report.ts` so CI exercises the new metric.
7. Confirm that no sensitive text appears in the event or trace exporter.
8. Run `npm run validate`.

## Monitoring boundaries

The bundled report is an aggregation library and executable demonstration, not
a hosted dashboard or alerting service. Adopters decide where to publish its
metrics and which thresholds should page a CSM or operations team.

The template deliberately does not:

- send alerts to Slack, email, or paging systems;
- transmit metrics to a third-party SaaS by default;
- store raw CSM feedback in monitoring events;
- infer model prices;
- treat trace retention as the source of truth for account health.
