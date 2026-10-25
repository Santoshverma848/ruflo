# Managed workflows ruOS integration validation

Date: 2026-10-25. Machine: Work Desktop, Fly ID `85050dc77130e8`.
Source: PR #4471 commit `8e08b5fbe48b9c7a55e4224cd1f5c15bf9095554`, followed by
the recall hydration fix in this commit. Node 20.20.2; Claude Code 2.1.283;
installed Ruflo 3.47.1 was left unchanged. The candidate was checked out into
`/home/ruv/work/ruflo-managed-e2e-4471`; tests and terminal bundle use that source.
No tenant model route, login, capability grant or global runtime was changed.

## Verified results

| Boundary | Result |
| --- | --- |
| Candidate backend contracts on ruOS | 167 tests passed before the recall fix |
| Candidate focused console regressions on ruOS | 101 tests passed |
| Complete pure console spec suite on ruOS, one worker | 3,516 passed, 35 skipped; 236 files passed, five skipped; 214.74 seconds; exit 0 |
| Backend regressions after recall fix, local workspace | 168 passed; strict adapter types passed locally and on ruOS |
| Standalone console build | Actual candidate terminal bundle built successfully |
| Disk snapshot to terminal host to Workflows view | Passed five assertions: managed run, provider unverified, workers unverified, acceptance unverified, reported budget |
| Signed local ledger to new process | Three fixture receipts survived and were reverified |
| Native indexing with declared memory 3.0.9 | Three records durably indexed with embeddings |
| Native search after process restart, before fix | Failed: zero of three receipts recalled |
| Native search after process restart, after fix | Passed: three of three receipts authenticated; advisory strategy returned; defaults unchanged |

The terminal check injected workersInspected=true, acceptancePassed=true and
verification=verified into a snapshot. The real Node filesystem reader and
bundled terminal host still displayed all three verification boundaries as
unverified. This was a local fixture integration test, not provider execution or
validation of the Claude Code function-hook host. Its snapshot was read without
a CLI entry or model transport.

Native tests used `scripts/e2e-managed-native.mts` in separate write and recall
processes. The fixture signing key was generated in memory and never persisted;
only its public key and signed synthetic metadata were stored. The observations
are explicitly synthetic plumbing evidence, not model-quality measurements or
production evaluation receipts. There were zero model calls and no automatic
promotion. The test used the real memory initializer, native SQLite writer and
embedding backend, rather than mocked memory APIs.

The complete pure spec command used `--maxWorkers=1 --testTimeout=30000` and
excluded `**/*.test.ts` as the plugin smoke does for host-kit tests. This resolves
the earlier incomplete pure suite result under contention; it does not claim
that the authenticated host-kit tests or full monorepo suite passed.
Machine-readable native and terminal evidence: [receipt](managed-ruos-e2e.json).

## Defect found and corrected

`searchEntries` returns 60-character content previews plus an ellipsis. The
initial implementation tried to parse those previews as complete signed JSON,
so actual authenticated recall returned no evidence even though native rows and
embeddings were present. Mocked contracts had supplied full JSON and missed it.

Recall now hydrates each eligible hit using the existing `getEntry` operation
with the exact project database, fixed namespace and admitted digest key. It
then rechecks row key, namespace, size, schema, signature, content digest and
local training-cohort membership. Search rank never establishes verification.
A regression covers truncated previews and mismatched hydrated namespaces.
Recommendations still use the complete eligible training cohort.

## Host incompatibility and unresolved live gate

The desktop's installed `@claude-flow/memory` was 3.0.0-alpha.26. A diagnostic
initialization with that older package aborted its process (exit 134) with
`memory allocation of 4158883080 bytes failed`. This is not evidence that the
candidate's pinned dependency has the same failure. The isolated probe was
aligned to the candidate manifest's memory 3.0.9 without changing global
packages; write and restart recall then passed after the hydration fix.

The isolated dependency install disabled lifecycle scripts and reused the
desktop's already working better-sqlite3 12.11.1 native binding of the same
installed package version. Initial old-backend versions were AgentDB
3.0.0-alpha.20 and RuVector core 0.1.32. No claim of arbitrary historical backend
compatibility follows from the successful current-dependency run.

The real headless Claude console driver failed before any tool call:
`Failed to authenticate: OAuth session expired and could not be refreshed`.
It reported cost $0 and zero calls. ANTHROPIC_API_KEY and CLAUDE_API_KEY were
absent from the executor environment and Claude settings. The ruOS vault lists
an Anthropic slot, but the exposed tools do not supply a verified key-delivery
path for this running executor. Secret values were never requested or printed.

Therefore direct Anthropic Managed Agents execution, live budget pauses,
fresh remote controls and the actual Claude function-hook console host remain
unvalidated. A Claude Code login alone also does not establish Managed Agents
API credentials or beta entitlement. Refresh the host login and securely deliver
an authorized API key with beta access before rerunning a bounded provider test.

## Reproduction and acceptance

With the candidate's declared native dependencies and tsx available:

```sh
node node_modules/tsx/dist/cli.mjs scripts/e2e-managed-native.mts write /tmp/managed-native-probe
node node_modules/tsx/dist/cli.mjs scripts/e2e-managed-native.mts recall /tmp/managed-native-probe
```

Use a new isolated directory for each write. The second command must run in a
new process, recall all three signed rows and leave defaults unchanged. Native
abort diagnostics must run in an isolated process; JavaScript cannot catch a
native process abort. Do not substitute a sql.js fallback for the native gate.

Release acceptance additionally requires one bounded live workflow visible in
the actual console host, a policy denial at execution, verified remote cleanup,
and independent task acceptance evidence. Until then PR #4471 remains draft.
