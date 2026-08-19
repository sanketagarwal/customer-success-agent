# Evals

The eval suite checks whether the template extracts the expected risks, keeps
all claims grounded, creates operational plans, personalizes outreach from
verified signals, and recommends actions that map to identified risks. It is
credential-free and deterministic so it can run on every CI build.

## Running the evals

```bash
npm run evals
```

The command runs `scripts/run-evals.ts`. It creates the fixture runtime,
prepares one healthy account and one at-risk account, runs positive and negative
cases through the registered Mastra scorers, prints their scores, and exits
non-zero if any threshold fails.

`npm run validate` includes the eval command, so the same gates run in CI.

## Scorer registration

The scorer implementations live in `src/mastra/scorers/index.ts` and are
registered on the `Mastra` instance in `src/mastra/index.ts`. Registration also
makes them available to Mastra's trace and dataset evaluation surfaces.

The suite uses deterministic code-based scorers rather than model judges. This
makes failures reproducible and keeps the default template free of eval model
costs.

## Risk-factor extraction

Scorer ID: `risk-factor-extraction`

Input:

- the list of expected stable risk-factor IDs.

Output under evaluation:

- a `HealthAssessment`.

The scorer compares the actual factor IDs with the expected set. Expected
factors increase the score; unsupported extras reduce it. A healthy account
scores 1 only when it has no risk factors.

The fixture gate checks two cases:

- healthy account: no factors expected;
- at-risk account: declining adoption, urgent support, billing risk, and a
  negative relationship signal expected.

This scorer measures extraction precision and recall for known fixture labels.
Groundedness is evaluated separately.

## Unsupported-claim detection

Scorer ID: `groundedness`

There is no separate heuristic called `unsupported-claim`. Unsupported-claim
detection is the negative use of the groundedness scorer and the same grounding
functions used by production execution.

The scorer checks assessment, plan, and optional outreach artifacts. Every
evidence item must resolve to the exact source, record ID, field path, time
window, and primitive value in the supplied `SourceSnapshot`. Canonical summary,
title, rationale, claim, and outreach text must also match the verified
evidence rendering.

The negative gate changes a real fixture evidence value to `999`. The expected
score is 0. Production code would stop the same artifact with
`grounding_failed` before approval or CRM writing.

Additional unit tests cover fabricated record IDs, fabricated values,
unsupported prose, redacted data, and `unknown`-only risk evidence.

## Account-plan quality

Scorer ID: `account-plan-quality`

The score combines two equally weighted checks:

1. Risk coverage: each identified risk must share at least one evidence
   reference with a plan action.
2. Action validity: each action needs a useful title and rationale, evidence, a
   due date at or after the assessment time, and the expected owner.

Expected ownership is:

- billing risks → `billing`;
- support risks → `support`;
- other risks → `csm`.

The positive fixture plan must score 1.

## Outreach personalization

Scorer ID: `outreach-personalization`

The scorer requires:

- at least one claim;
- a non-trivial body;
- `draftOnly: true`;
- evidence coverage for every identified risk;
- every structured claim to appear in the outreach body.

The negative case replaces the body with a generic customer check-in. Even
though its surrounding object is valid, it scores 0 because it does not use the
verified account claims.

Personalization here means evidence-specific content, not unrestricted use of
CRM free text. CRM bodies and support subjects are deliberately excluded from
model prompts and traces.

## Action relevance

Scorer ID: `action-relevance`

For each plan action, the scorer checks whether at least one evidence reference
also belongs to an identified risk factor. The score is the fraction of actions
that map to risks.

The negative fixture rewrites every plan evidence record ID to a fabricated ID.
The expected score is 0.

## Current CI thresholds

The eval script uses strict fixture thresholds:

| Group | Required score |
| --- | --- |
| Positive cases | `1` |
| Negative cases | `0` |

The positive group currently includes healthy extraction, at-risk extraction,
groundedness, account-plan quality, personalization, and action relevance. The
negative group includes an unsupported claim, generic outreach, and irrelevant
actions.

These are binary release gates for the curated fixtures, not claims that every
real-world model output will be perfect.

## Relationship to unit and integration tests

Evals and tests have different jobs:

- Evals score artifact quality against explicit behavioral expectations.
- Unit tests verify schemas, evidence resolution, approval binding, drift,
  tenant isolation, retries, redaction, idempotency, HubSpot mapping, and
  persistence behavior.
- The fixture demo verifies the complete suspend/resume, rejection, replay, CRM
  draft, and task flow.

CI runs all three through `npm run validate`.

## Adding an eval case

1. Add or update a deterministic account in `data/fixtures/accounts.json`.
2. Give expected risks stable IDs in the fixture intelligence or expected model
   output.
3. Prepare the account in `scripts/run-evals.ts`.
4. Run the appropriate scorer with explicit input and output artifacts.
5. Add the result to the positive or negative score group.
6. Add a unit test when the case represents a security or data-integrity
   invariant rather than only output quality.
7. Run `npm run evals` and `npm run validate`.

## Adding a scorer

Create the scorer with Mastra's `createScorer`, export it from
`src/mastra/scorers/index.ts`, register it in `src/mastra/index.ts`, and invoke it
from `scripts/run-evals.ts` with both a passing and failing example.

Prefer deterministic scorers when correctness can be resolved from typed
artifacts. If an adopter adds a model judge for tone or strategy quality, pin
the judge model and prompt, store the evaluation dataset, define a numeric
threshold, and track variance and cost separately.

## Extending evals for production connectors

The bundled suite proves the template against normalized fixtures. Connector
implementations should add contract tests for their source mapping and a
sanitized evaluation dataset representing their real account shapes.

Useful additions include:

- missing or delayed provider data;
- conflicting billing and CRM timestamps;
- changed source data after approval;
- multilingual notes after normalization;
- high-volume account histories;
- model-version comparisons;
- CSM-rated plan and outreach quality.

Never add raw customer notes, credentials, or production account identifiers to
the repository's fixture or eval datasets.
