# Canonical exact-key recall

When memory_search.query exactly matches a safe stored memory key, the service reads the canonical tenant document and verifies team scope before constructing any vector snapshot. It returns only that record with backend canonical-exact, degraded false, score1 and match exact-id. These fields describe lookup identity, not semantic confidence, trust or authority. Existing OAuth scopes, team checks and result fencing in server.mjs remain unchanged.

This avoids the capped1000-document similarity snapshot and stale same-key content. On an exact miss, the same key is excluded from cached similarity results so a record moved out of the team cannot reappear. Other similarity cache staleness remains unchanged. Native fallback may return fewer than limit after exclusion. Custom stores without getMemory retain their prior search path. Database read errors propagate. Native startup probing is unchanged.

Verification on dedicated ruOS CPU, Node24.21.0, October24,2026 Toronto: source baseline973d0ab497c9138d7bee1dc3c7a4d3985e37bf9e passes2/fails7 of9new regressions; candidate passes9/9 plus4existing store tests,13/13 total. Firestore uses an interface mock proving direct document lookup without listing; no live Firestore, actual native binary, OAuth end-to-end, full package suite or service deployment is claimed. No dependencies, locks, credentials, schemas, scopes or permission settings changed. No latency or semantic-quality improvement claimed. Infrastructure cost unknown.

Run from plugins/ruflo-ai-team:

```sh
node --test test/exact-memory.node.mjs test/store.node.mjs
```

Rollback: revert this isolated patch. Deployment and promotion remain separate gates. After deployment, verify a known safe key with memory_search; expect backend canonical-exact and exact record content, and verify a foreign team cannot retrieve it. A GitHub receipt is not automatically synchronized into private Ruflo memory.
