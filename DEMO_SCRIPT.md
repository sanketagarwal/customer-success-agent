# Customer Success Agent — Live Demo

## Open these first

- Mastra Studio: http://localhost:4112
- Redwood Retail in HubSpot: https://app.hubspot.com/contacts/247084407/record/0-2/340734348989

In Studio, open **Workflows → customer-success-account**. Keep HubSpot open in a second tab on Redwood Retail’s activity view.

## The demo (about 4 minutes)

### 1. Introduce the problem

**Say:**

> Customer risk rarely lives in one system. A support issue may not look alarming until we connect it with an overdue invoice and negative account sentiment. This agent brings those signals together, recommends the next steps, and keeps every CRM action behind human approval.

**Do:** Show the Redwood Retail company record in HubSpot.

**Say:**

> This is our live demo account, Redwood Retail. The workflow will read this company and its associated records directly from HubSpot.

### 2. Run the review

**Do:** In Studio, run `customer-success-account` with:

```json
{
  "accountId": "340734348989"
}
```

**Say while it runs:**

> Mastra is collecting the account’s support, billing, and CRM signals. The risk score and action plan are deterministic, so the business rules remain predictable and auditable.

### 3. Reveal the risk

**Expected result:** The workflow pauses at `request-csm-approval`.

Point out:

- Health score: **40/100**
- **1 urgent open support ticket**
- Invoice **18 days past due**
- **Negative** CRM sentiment
- Three owned follow-up actions
- Customer outreach marked **draft only**

**Say:**

> Redwood scores 40 out of 100 because three independent signals point to renewal risk. The agent explains every deduction with evidence, then turns those risks into an owned recovery plan: escalate support, resolve the outstanding balance, and schedule an executive check-in.

> It has also prepared outreach, but nothing has been sent and nothing has been written back to HubSpot yet.

### 4. Demonstrate human approval

**Do:** Open the suspended `request-csm-approval` step.

**Say:**

> This is the human-control boundary. The agent can analyze and recommend, but a CSM must approve the plan before it changes the CRM.

Resume with:

```json
{
  "decision": "approved",
  "approverId": "demo-csm",
  "feedback": "Reviewed with the account team. Proceed with the recovery plan."
}
```

### 5. Prove the outcome in HubSpot

**Expected result:** The workflow completes with outcome `written`, one `writeId`, and three `taskIds`.

**Do:** Return to HubSpot and refresh Redwood Retail.

Show:

- The internal Customer Success review note
- Three associated follow-up tasks
- The outreach preserved as a draft, not sent to the customer

**Say:**

> Approval creates the internal review and the follow-up tasks directly in HubSpot. The team gets an auditable plan they can act on immediately, while customer communication remains under human control.

### 6. Close

**Say:**

> That is the complete pattern: live customer data, evidence-backed risk detection, a concrete action plan, human approval, and a verified CRM update—all in one workflow.

## Presenter recovery notes

- If Studio is not open, use http://localhost:4112 and select the account workflow.
- If HubSpot is slow to display the new records, refresh the company activity once.
- Do not approve the same run twice.
- Do not use `weekly-customer-success` during the live demo; in HubSpot mode it reviews the full portal.
- If a run is accidentally rejected, start a new account-workflow run instead of trying to reuse it.

## Verified setup

- `.env` is configured with `DATA_SOURCE=hubspot` and deterministic generation.
- Company, ticket, invoice, note, task, and association access have been verified live.
- The real approval path successfully created one note and three tasks in a smoke test. Those test records were archived afterward, leaving Redwood clean for the presentation.
- The private app lacks optional `feedback_submissions.read` access. Redwood is unaffected because its sentiment is stored in `hs_csm_sentiment` on the company.
