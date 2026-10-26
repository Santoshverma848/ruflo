# Performance SOTA Report — 2026-10-25

TL;DR: `CacheManager` (`v3/@claude-flow/memory/src/cache-manager.ts`) re-stringified a cache entry's *old* value via `JSON.stringify` on every overwrite, delete, and LRU eviction — purely to recompute a byte-size estimate already computed (and discarded) at write time. Size is now cached on the LRU node and reused: `estimateSize()` calls drop from one-per-write-plus-one-per-removal to exactly one-per-write. ~32% wall-clock reduction on a representative lifecycle microbenchmark; `getStats().memoryUsage` byte-identical to baseline. This corrects and narrows an overclaimed finding from the 2026-10-20 night. An independent adversarial critic found one real, low-severity, pre-existing caveat (cached `size` no longer self-heals if a consumer mutates a `get()` result in place), disclosed in-source rather than fixed, since the fix would cost more on the far hotter read path than it saves. **Verdict: ACCEPT-with-caveats.** Two stronger-looking SCAN candidates (security, hive-mind) were scored and deliberately deferred — see Hypothesis.

## What's New in 2026

| Finding | Source | Grade |
|---|---|---|
| No major agent framework (LangGraph, MS Agent Framework/AutoGen, CrewAI, OpenAI Agents SDK) publishes byte-size-based eviction for session memory — all use count/TTL where eviction exists at all | LangGraph `CacheConfig` docs; AutoGen `cache_store` docs; `crewai-ts`; Ema SDK blog | B/C |
| Vector-DB vendors that *do* size-budget (Qdrant, Weaviate) use closed-form arithmetic on a fixed-width schema, never serializing arbitrary payloads | Qdrant/Weaviate docs | B |
| JS memoization ecosystem has treated `JSON.stringify` on a hot path as known-bad since 2019 (for keying, not sizing) | `memize` vs `fast-memoize` READMEs; V8.dev blog | B |
| 4 independent 2026 CVEs (PraisonAI, Zed, mcp-filesystem-server, filesystem-mcp) hit the exact symlink-not-realpath'd gap already disclosed-but-deferred in Ruflo's `hooks_codemod` | CVE-2026-55540/27967/79534, CVE-2025-67366 | A |
| No reproducible benchmark exists anywhere for CPU cost of eviction-*trigger-metadata* computation (vs. eviction *policy quality*, actively researched: AgentKV/ICML'26, MemDecay arXiv 2607.10582, Apple arXiv 2602.10238) — a real, narrow, unaddressed gap | Targeted arXiv/vendor search | A (absence), C (Mem0's single-source "80%" claim) |

## Ruflo Current Capability

`CacheManager<T>` is a doubly-linked-list LRU cache with optional TTL and byte-budgeted (`maxMemory`) eviction, used by `AgentDBAdapter` as AgentDB's in-process L1 cache. `maxMemory` is never passed by that production caller (confirmed via grep), so budget eviction is dormant — but `currentMemory`/`memoryUsage` is real, consumed telemetry (`agentdb-adapter.ts`'s `estimateMemoryUsage()` reads it). `estimateSize()` (`JSON.stringify(data).length*2`) ran once per `set()` (unavoidable) **plus again** on every overwrite, delete, and eviction, recomputing a size already known and discarded.

## Competitor Comparison

| Competitor | Approach | Grade |
|---|---|---|
| LangGraph | TTL-based node cache; byte-budgeted store is an unmerged proposal | C |
| MS Agent Framework/AutoGen | No documented byte-budget eviction (ChromaDB-backed) | C |
| CrewAI | No official eviction policy; unofficial `crewai-ts` port: count-based LRU | C |
| OpenAI Agents SDK | No published eviction/size-limit behavior | C |
| Qdrant / Weaviate | Closed-form arithmetic on fixed-width vector schema, not serialization | B |

Byte-accurate size accounting for arbitrary payloads appears industry-wide not worth the cost — every named framework evicts by count/TTL, never measured size. Not a Ruflo-specific gap; where size-budgeting *is* worth it (Qdrant/Weaviate), it works because the payload has a declared fixed shape, which Ruflo's generic `CachedEntry<T>` lacks.

## Hypothesis

> Given `CacheManager` under a workload of N writes (V overwrites), D deletes, E evictions, when `estimateSize()`'s result is cached on the `LRUNode` at write time and reused for overwrite-accounting/delete/eviction instead of re-stringifying the removed value, then stringify calls drop from N+V+D+E to N, subject to: (1) `getStats().memoryUsage` byte-identical to baseline; (2) LRU ordering/eviction decisions unchanged; (3) zero new test regressions, `tsc --noEmit` byte-identical. Frozen before evaluation.

**Override disclosed up front**: tonight's rotation is `DEEP=performance`. Two SCAN findings scored at or above this candidate on the same rubric (`0.25·fit+0.20·testability+0.20·measurability+0.15·production_value+0.10·novelty+0.10·reviewability`): **security** — realpath/symlink hardening of `hooks_codemod` (closing the 10-20 night's own disclosed CWE-59 gap), **4.65**, backed by 4 real 2026 CVEs; **hive-mind** — `TopologyManager.calculateInitialConnections()` uses a node's raw role instead of its resolved role (confirmed, concrete 3-node repro), but only **3.70** (zero reachable call path today). This candidate and a tied alternative (`JsonMemoryBackend` clone-on-every-op) both scored **4.65**. The 09-24/10-20 override precedent requires the SCAN finding to score *strictly above* the DEEP candidate — tonight it's a tie, not an override, so the rotation is kept and both SCAN findings are carried forward (Recommended Next Steps). Between the two tied performance candidates, `CacheManager` was chosen for its zero-aliasing-risk fix vs. `JsonMemoryBackend`'s need for an unverified caller-mutation audit.

## Benchmarks

No agent-task benchmark corpus exists for this kind of fix — consistent with every accepted fix since 2026-08-18, which used stash-isolated discriminating unit tests plus a wall-clock microbenchmark instead. A 40,000-op lifecycle probe (3,000-key keyspace, 2,000-entry budget, forcing overwrites/evictions, warmup+3 trials, median): **baseline 194.92ms → candidate 132.59ms (~32%, ~1.47x)**, `getStats()` byte-identical both ways (`hits:5715, misses:0, evictions:34500, memoryUsage:1511554`). A single deterministic microbenchmark, not a randomized significance test — reported as such.

## Evaluation

**evaluated: accepted (ACCEPT-with-caveats).** Real evaluator: Vitest 4.1.8 (pnpm workspace installed/built this session).

New file `cache-manager-estimate-size-reuse.test.ts` (6 tests: 5 discriminating `JSON.stringify`-call-count assertions via a `toJSON()` counter hook — overwrite, delete, 2 eviction paths — plus 1 non-discriminating control). Stash-isolated baseline: **5/6 fail exactly as predicted**; control passes both ways. Candidate: **13/13 pass** (new file + 2 pre-existing regression files). Independently re-reproduced from scratch by an adversarial critic.

Full `@claude-flow/memory` suite: **649/652 both before and after** — the 3 failures (a chmod-based permission test, a timing-flaky benchmark, a 30s-timeout embedding benchmark) are pre-existing/environmental, 2 of 3 independently confirmed identical on baseline. `tsc --noEmit`: **0 errors both ways**.

**Independent adversarial critique: CONFIRMED-WITH-CAVEATS.** Verified every `LRUNode.size` write site, no bypass via `TieredCacheManager`, re-reproduced the stash-isolation result, confirmed no reward-hacking signal. Found one real caveat: `get()` returns the live object by reference, and `agentdb-adapter.ts`'s `updateAccessStats()` mutates it in place without calling `set()` — previously harmless because delete/eviction re-stringified the *current* object, self-correcting drift; now the cached `size` no longer self-heals, so `memoryUsage` can drift a few bytes per mutated-counter digit-boundary over a long-running cache. Low severity, pre-existing design (not introduced by this diff), and routing the mutation through `set()` would reintroduce a full stringify on every cache **hit** — far hotter than writes, costing more than this fix saves. Disclosed as an in-source `KNOWN LIMITATION` JSDoc on `get()` instead, matching this repo's own established pattern (2026-08-31/10-13/10-20 nights).

## Darwin Results

Skipped — binary correctness/efficiency fix, no continuous/categorical parameter for Darwin's interface to search over. Same skip class as nearly every accepted fix since 2026-08-18.

## SOTA Proof & Witness

Session commit:   f02989a78c06edbe97f99377f9c5c48d36168575
Candidate commit: (this branch's head)
Gist SHA-256 (pre-witness, witness block stripped to PENDING): 57bd77cb192fecff96eadd2590b573c37643e64f334f2da6f50853a781098f10
Witness stamp:    b701bb8e0be38428e2335df0e14a24196f87c7a9047c8dab2e09ab23399bd896

Verifier: fetch this file, strip this block's filled-in values back to `PENDING`, SHA-256 the file, concatenate with the Session commit above, SHA-256 again — must equal the Witness stamp.

Evaluation receipt identity: `cache-manager-estimate-size-reuse.test.ts` + 2 pre-existing regression files, stash-isolated 5/6-fail-baseline → 13/13-pass-candidate, independently reproduced. Flywheel evidence identity: none (`.claude-flow/flywheel/` doesn't exist, same as every prior night) — retained as this gist, the tests, the stash comparison, the wall-clock probe, and the adversarial critique. Darwin lineage identity: none (skipped).

## Recommended Next Steps

1. **Implement realpath/symlink hardening for `hooks_codemod`'s `resolveTargets()`** (security, score 4.65) — port the existing `safePathAsync()` pattern from `v3/@claude-flow/plugins/src/security/index.ts:193-213`. Backed by 4 real 2026 CVEs in comparable tools; strong candidate to directly implement on a future `security` night.
2. **Fix `TopologyManager.calculateInitialConnections()`'s raw-vs-resolved role bug** (hive-mind, score 3.70, confirmed with a concrete repro) — cheap, low-risk, but dormant, so lower urgency than #1.
3. **Resolve or delete the two "second-order path-containment" instances** the 10-20 night flagged as latent — tonight's research confirmed both `resource-registry.ts::createFileResource` and `input-validation.ts::validatePath` are dead code with zero real call sites.
