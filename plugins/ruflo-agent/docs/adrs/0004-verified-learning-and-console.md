---
id: ADR-0004
title: First class managed console runs and verified advisory learning
status: Proposed
date: 2026-10-25
---

## Outcome

Extend [ADR 0003](0003-managed-dynamic-workflows.md) across all five requested
integration priorities: unified run model, one collector per session, budgets
and blockers, policy checked actions, and verified outcome feedback. Reuse
the console's workflow navigation, bounded readers, action confirmation and
Learning page; do not add a second dashboard or a provider client in hooks.

The resulting loop observes execution, records an outcome, authenticates a host
verifier's evidence, recalls training patterns, recommends a strategy and checks
it on a frozen holdout. No step silently promotes or deploys a default policy.

## Architecture and ownership

| Component | Input | Output and authority |
| --- | --- | --- |
| ManagedRunCollector | Explicit primary event/session reads | Incremental run, phase, worker and blocker facts; no correctness claim |
| Project collector lease | Project/session and host credential scope | One active collection; concurrent same-scope callers share it |
| Managed snapshot projection | Sanitized collected metadata | Six sessions, 60 worker rows/page, full aggregate counts, 128 KB maximum |
| Console | Local cached snapshots and learning summary | First class managed workflow rows, budgets, blockers and evidence; no provider traffic |
| managed_agent_control | Session/action, optional inspection offset | Fresh host policy and provider checks before dispatch; input cannot grant approval |
| Learning ledger | Closed metadata and optional Ed25519 receipt | Quarantine or authenticated measured outcome; 500 rows, 2 MB maximum |
| RuVector/AgentDB bridge | Authenticated training evidence | Native append-only index; independently revalidated recall hits |
| Advisory evaluator | Complete paired signed heldout results | Existing MetaHarness accept conjunction plus efficiency/safety gates; never a default write |

Production sources: `managed-run-collector.ts`, `managed-run-store.ts`,
`managed-learning.ts`, `managed-learning-store.ts` in the CLI services directory.
The two new MCP operations are `managed_agent_control` and
`managed_agent_learning`; the existing tool names remain available.

## 1. Unified console run model

`WfRun.kind` adds `managed`. Native, swarm and managed execution share workflow
navigation, but native controls are never offered for managed rows. Provider
phases and worker phase IDs are used when present; absent facts remain unknown.

The UI distinguishes provider completion, worker inspection and acceptance.
The collector always writes workersInspected=false, acceptancePassed=false and
verification=unverified. A completed provider run cannot produce a verified
badge. Signed learning receipts attest measured outcomes separately; they do
not make an unchecked snapshot an authorization token.

Each session carries its own observation timestamp. Refreshing one session
cannot make another session fresh. Observations older than 30 seconds or from
an implausible future timestamp are marked stale. Unknown cost is n/a, not zero.
Provider list cost is not mixed into unrelated local model budget totals.
Pending event IDs are shown for inspection; there is no blanket approval action.

## 2. Shared collector and bounded observation

Prompt polling and primary event inspection use one process-local singleflight
collector, with inclusive processed_at watermark, event-ID deduplication and
semantic replay equality. A 1 second cache prevents immediate duplicate reads.
Only explicit requests cause reads; snapshots, pagination and panel refreshes
never invoke a provider. There are no background collection timers.

A project/session OS lease prevents another process from collecting concurrently.
The lease is exclusive, never automatically stolen, and released on completion.
A crashed process may leave a lease requiring operator inspection. Singleflight
sharing never crosses host credential scopes. Session/action authorization is
not inferred from either the lease or cached data.

The collector caps six sessions, 10,000 events and 16 MB. It retains worker
aggregates while publishing 60 workers at a time. The console bounds file reads
and reuses parsed objects when text is unchanged. A collector cache is not a
restart journal; after restart it reloads provider history within the same caps.

## 3. Budget and approval visibility

Budget and reported list cost are integer US cents. Remaining budget and any
overshoot are displayed as observations. Provider budgets stop new requests,
so in flight work can exceed the cap. The console does not extrapolate unknown
cost or treat a budget pause as completion.

Permission requests, custom tool calls and requires_action event IDs populate
the blocker view. Confirmation/result events remove resolved IDs. Correctness
and host permissions are never inferred from a provider's completion label.

## 4. Controls recheck policy at execution

Console buttons use the existing confirmed, fixed CLI action:

```text
mcp exec -t managed_agent_control -p {sessionId,action,threadOffset?}
```

The handler accepts only inspect, interrupt and terminate. It requires
RUFLO_MANAGED_CONTROL=1 and an exact comma-separated session allowlist in
RUFLO_MANAGED_CONTROL_SESSIONS. It reads current provider state, then reads host
policy again immediately before dispatch. Unknown state, a changed policy,
unknown input fields, or a caller supplied approval flag fails closed.

Interrupt requests a pause and never confirms cancellation. Successful deletion
updates the observed session termination, without claiming acceptance or worker
inspection. Unexpected asynchronous deletion responses are not treated as
confirmed termination. Other direct managed tools retain their existing host
permission boundary; this control policy is not organization-wide authorization.

## 5. Verified learning and optimization

Learning writes require host RUFLO_MANAGED_LEARNING=1. The host configures the
trusted Ed25519 public key in RUFLO_MANAGED_VERIFIER_PUBLIC_KEY; an MCP caller
cannot supply a public key, declare itself verified, or request shell execution
through the learning API. The verifier's private key stays outside this service.

Version 1 observation metadata contains task/attempt/source/artifact/policy/
corpus/evaluator hashes, coarse task type, strategy ID/model/worker count/template,
split/trial, admitted budget, measured cost/duration, acceptance and safety
results, replay/adversarial verdicts, drift and rollback measurements. No raw
prompt, transcript, arbitrary command or credential field is accepted.

The trusted verifier must independently check the source and artifact and sign
the complete canonical observation after measuring the outcome. Cryptography
authenticates that verifier's statement; it does not replace the verifier's
tests or prove its operational independence. Unknown cost/duration cannot be
used for recommendations. Cumulative session list cost must not be mislabeled
as one task's measured cost.

Unsigned observations stay quarantined and cannot reserve a trusted attempt ID.
Quarantine has a separate 100-row ceiling, leaving capacity for authenticated
results. A matching valid attestation can attach to an unsigned observation;
two conflicting valid outcomes for one attempt are refused. Every reload and
memory recall rechecks signatures. Recommendations/evaluations are rederived
from currently valid receipts; old JSON advice cannot survive verifier rotation
or tampered evidence as supported advice.

Recommendations use only authenticated training observations in the exact task,
policy and evaluator cohort, require three distinct training tasks per strategy,
include failures in cost/quality denominators and enforce a latency constraint.
They return model, worker count, template, sample count, observed success rate,
successes per dollar, p95 latency and evidence IDs. Sample size is evidence,
not a calibrated probability. All-failed or unsupported cohorts abstain.

The optional memory index uses namespace managed-workflow-evidence, native
append-only writes and strict insertion. Uncertain persistence is an error;
missing embeddings are reported explicitly. Heldout and unsigned records are
never indexed. Semantic recall checks namespace, receipt signature, content
digest and local cohort membership. Similarity is not verification, and recall
does not select a favorable subset for efficiency scoring. The full eligible
training cohort determines the advisory recommendation.

Actual native integration showed that search results contain display previews,
not complete receipts. Recall hydrates the exact scoped row via getEntry before
checking its size, identity and signature. ruOS write/restart/recall validates
three embedded fixture receipts with the declared memory 3.0.9 dependency;
older desktop memory alpha.26 aborts during native initialization and is not
qualified. See the [ruOS validation](../../../../docs/validation/managed-ruos-e2e.md).

### Frozen evaluation gate

The heldout manifest declares 2 to 100 unique task hashes and 3 to 10 trials;
its canonical hash must match all paired receipts. Both strategies must have
exactly one result per task/trial, matching source identity and admitted budget.
Training/holdout task overlap is rejected. A project ledger binds a corpus to
one confirmation comparison, preventing candidate switching on that holdout.

Numeric domains are validated before the existing MetaHarness accept() function.
The gate requires at least 10% more verified successes per actual dollar, no
per-task acceptance regression, no safety failure, no p95 latency regression,
and the existing adversarial, replay, drift, receipt and rollback conjunction.
Fitness passed to MetaHarness is normalized cost efficiency, not raw pass rate.
Eligibility is advisory. No router champion, configuration, signing authority,
capability envelope or deployment state is modified. Statistical significance
and real model superiority require separately designed live experiments.

## Acceptance and measured limits

Required regressions include 1,000 workers with duplicate/reordered reconnects,
budget/permission pauses and failures; one collector and OS lease; no inactive
provider traffic; safe worker paging; stale policy denial; forged receipts;
quarantine poisoning; key rotation; heldout leakage; incomplete/mismatched trials;
failed persistence; and native tool/console compatibility.

The local bounded rendering target is under 16 ms. Validation measures warm
rendering with the actual view functions and fixture kit, not native GPU/UI
latency. CPU benchmarks and synthetic learning gate results cannot establish
live provider performance, dollar savings or model-quality improvements.

## Failure and rollback boundaries

Local files are advisory projections, not an action authority. Same-user
adversarial filesystem races are outside the directory-check guarantee. Atomic
file replacement and directory fsync are used; platforms without those semantics
must fail rather than claim durable writes. Ledger and summary are separate
atomic writes, so a crash can leave an older display summary.

Disable learning/control environment flags to stop those effects. Stop using
dynamicWorkflows for new sessions and explicitly terminate owned remote sessions
before removing the adapter. No existing default model, native workflow schema,
router state or memory row is migrated or overwritten by this integration.

Validation receipt: [managed learning and console](../../../../docs/validation/managed-learning-console.md).
