# Mastra primitives

| Primitive | Implementation |
| --- | --- |
| Scheduled workflows | `weekly-customer-success` runs the account workflow for every account returned by the CRM. |
| Structured output | The agent returns one typed assessment, plan, and outreach draft. |
| Approval | `request-csm-approval` suspends the run and resumes from a decision, approver ID, and optional feedback. |
| Workflow retries | Data collection, generation, and CRM writes each retry twice. |
| Request context | Scheduled runs bind tenant and account identity; approval can bind the CSM identity. |
| Working memory | The agent retains current risks, approved actions, and open CSM questions per account. |
| Observational memory | Enable with `ENABLE_OBSERVATIONAL_MEMORY=true`. |
| Semantic recall | Enable with `ENABLE_SEMANTIC_RECALL=true`; account memories are stored in LibSQL vector storage. |
| CRM tools | Connector-neutral list, read, and approval-gated write tools are registered in Studio. |
| Observability | Mastra traces are stored locally with sensitive CRM and outreach fields filtered. |

The workflow is defined in `src/mastra/workflows.ts`; agent memory and generation are in `src/mastra/reviewer.ts`.
