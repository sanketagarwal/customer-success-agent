# Monitoring

Every review records account-scoped operational metrics:

- risk score and score drift
- recommendations and accepted recommendations
- approval and outreach status
- human feedback
- model tokens and estimated cost
- workflow latency

Mastra observability provides step traces in Studio. The small LibSQL event log in `src/mastra/state.ts` stores account-level metrics for dashboards or exports.

Sensitive CRM notes, outreach bodies, tokens, feedback, and email fields are filtered from exported spans.
