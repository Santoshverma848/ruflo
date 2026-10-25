# ADR 0005: Independent proof of managed learning value

Status: experimental host API and local executable experiment. Depends on ADR 0004 and PR #4471. No production promotion authority.

## Problem and decision

A valid verifier signature proves who asserted a score, not that the scoring rule
measures correctness. A shallow acceptance test can create correctly signed false
positives. A learned router can then become more efficient at selecting mistakes.
We need to falsify this failure mode before claiming real agent improvement.

Add a separate host evaluation process with a persistent, bounded campaign:

1. Execute training workloads, authenticate observations and use the existing
   `cycleLearning` operation to recommend a strategy. Record the complete search
   set, including the fixed baseline, before audit access.
2. Register the selected strategy, source, evaluator, oracle, training digest,
   audit input hashes, strategy set, seed, equal per-task budget and timeout in a
   durable registry before exposing audit inputs or running any arm.
3. Run fixed baseline, seeded randomized routing and learned routing on the same
   unseen cases. The random arm uses the same strategy set and envelope.
4. Score outputs through a separate host oracle. Oracle signatures bind the
   registration hash, task, arm, strategy, source, output hash, success, safety,
   status, cost and latency. Training-verifier signatures cannot substitute.
5. Collapse correlated cases/trials into conservative family-level conjunctions.
   A family succeeds only if every declared task passes. Missing, failed, timed
   out, unsafe, over-budget or over-time results remain failures in denominators.
6. Reuse the pinned rGi exact paired sign test: minimum 30 independent families,
   Bonferroni alpha .05/6 for two controls across at most three registered rounds,
   domain nonregression, cost ratio at most one and capability vetoes. Add the
   stricter existing Ruflo per-task no-regression rule and at least 10% relative
   success lift against each control. A zero-success baseline cannot establish a
   relative improvement claim.
7. Return an advisory result only. Live improvement classification additionally
   requires host-labelled live-provider and metered-cost evidence. Local execution
   or synthetic prices cannot receive that classification, even if statistics pass.

The campaign consumes audit task IDs and semantic-input hashes at registration,
not after success. Crashes, poor outcomes and abandoned runs do not free them.
A later round needs fresh audit data; consumed audit inputs cannot be relabelled
as training. Evaluation is once per registered plan. The optimizer never receives
an authority to change the oracle or broaden capability/budget ceilings.

## Actual ecosystem integration and source boundaries

| Component | Reuse | Boundary |
| --- | --- | --- |
| Ruflo | Actual `cycleLearning`, signed training evidence and advisory recommendation | No MCP control or routing default changes |
| rGi | Exact standalone `src/evaluation.ts`, vendored from fe5456234bcae654c513d1360f6f2d67d5933fb3 | No rGi runtime or SQLite promotion ledger starts; provenance retained, no invented upstream license |
| Autogenous | Bounded variation and Better ∧ Safe ∧ Authorized ∧ Reversible design | Mesh evolution is not code-agent evidence; its published example selects and promotes on the same benchmark |
| MetaHarness AVO | Separate proposer/evaluator authority, frozen workspace binding and mechanism/performance claim distinction | No AVO operator or SWE-bench release claim is reported as executed |

Primary source references:

* [rGi evaluator](https://github.com/ruvnet/rGi/blob/fe5456234bcae654c513d1360f6f2d67d5933fb3/src/evaluation.ts)
* [rGi promotion ledger](https://github.com/ruvnet/rGi/blob/fe5456234bcae654c513d1360f6f2d67d5933fb3/src/promotion-ledger.ts)
* [Autogenous bounded evolution](https://github.com/ruvnet/autogenous/blob/905aa6cbe213392f8b3cab5d4f17bc3a48e0a509/packages/radio-moe/src/mesh-evolve.ts)
* [Autogenous receipt limitations](https://github.com/ruvnet/autogenous/blob/905aa6cbe213392f8b3cab5d4f17bc3a48e0a509/packages/radio-moe/src/receipt-export.ts)
* [AVO operator](https://github.com/ruvnet/metaharness/blob/d59130b3649c2906a020b3a1aad53cfd10727897/packages/avo/src/operator.ts)
* [AVO claim gate](https://github.com/ruvnet/metaharness/blob/d59130b3649c2906a020b3a1aad53cfd10727897/packages/avo/src/claim-gate.ts)

AVO's existing performance gate requires 100 unseen SWE-bench tasks and 20%
resolution lift in its specific three-arm design. This local experiment does not
satisfy that gate. Autogenous's example receipt explicitly has no independent
promotion holdout and no metered resource evidence, so its optimization score
cannot establish this integration's real-world value.

## Executable experiment and interpretation

`scripts/e2e-managed-proof.mts` invokes existing Ruflo metadata validators and the
MetaHarness acceptance function in fresh Node subprocesses. A weak baseline
checks only outer object shape; a strict strategy calls the actual implementation.
The host owns explicit expected outcomes and never passes labels or signing keys
to the worker. Training uses ten disjoint inputs per strategy; each of two audit
rounds uses 30 cases grouped into five real source-function families.

The deliberately weak baseline is a fault-injection control, not a competitive
agent baseline. A static strict comparator is also executed. If learned routing
merely selects strict always, its advantage over static strict is zero. Report
that directly rather than attributing stronger hand-written validation to adaptive
intelligence. Correctly signed weak training scores are intentionally injected in
a separate learning store to demonstrate that signature validity alone can choose
the wrong route. The independent oracle catches those output errors.

Five families are not 30 independent tasks. Both rounds must remain inconclusive
regardless of raw case accuracy. This is a falsification and routing-mechanism
experiment, not proof of LLM improvement or savings. Test-only positive fixtures
exercise the gate with 40 independent declared families; they are not empirical
performance evidence.

## Trust, durability and rollback

Host API arguments and corpus labels are trusted evaluation configuration, never
model-supplied MCP input. Distinct keys separate authorities but cannot prove human
or organizational independence. A host must audit oracle code, provision its key
separately and enforce hidden-data isolation. `oracleHash` is a binding supplied by
the host, not remote attestation. Process separation alone is not an OS sandbox.

Semantic duplicates and family independence require corpus curation; string IDs
cannot establish them. The registry enforces reuse within one retained campaign
directory. Creating a new directory or deleting state resets that protection, so
operators must retain and govern the campaign root. It is not a global audit ledger.

Registration uses an exclusive lock, atomic file replacement and directory fsync.
Platforms lacking those semantics fail rather than claim durability. Stale locks
or transaction remnants fail closed and need host inspection before manual
recovery; do not delete reservations to rerun an unfavourable audit. Same-user
filesystem adversaries require OS isolation. Disable the invoking host job to stop
this process. No background daemon, automatic deployment, model update or promotion
is introduced.

## Acceptance

Run the proof test and E2E commands in the validation report. Require rejection
for training/audit overlap, holdout reuse, changed plans, aliased signer keys,
forged oracle scores, missing results, unsafe outcomes, exhausted campaigns and
correlated-case inflation. Positive statistical fixtures must pass while local
workloads remain ineligible for live improvement claims. Broader proof requires
fresh, independently curated production-like tasks, sensible fixed and static
best controls, separately operated oracle and actual metered actor execution.
