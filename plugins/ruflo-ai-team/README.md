# RuFlo AI Team

RuFlo AI Team is a separate, multi-tenant MCP service and Claude plugin. It turns a reviewed goal into explicit team, run, task, memory, and evidence records without exposing raw operator tools or credentials.

The public v0.1 surface coordinates work; it does not silently send messages, deploy software, execute shell commands, make purchases, or approve consequential actions. Claude Code and Cowork agents use the service as a shared control plane while the user remains the authority for external effects.

## Setup: connect the service first

The plugin ships skills, commands and agents, but all team state lives in the hosted RuFlo AI Team service. **Nothing works until you connect it.**

1. Install the plugin (Customize → Plugins → ruflo-ai-team, or `/plugin install ruflo-ai-team` in Claude Code).
2. Open **Customize → Connectors** and find **ruflo-ai-team** (`https://team.ruv.io/mcp`). Choose **Connect**.
3. Sign in on the OAuth page and approve the requested scopes. Your tenant is derived from your sign-in; you never enter a tenant ID.
4. Start a new conversation and run `/team-start <goal>`. If the connector is working, Claude lists the team templates before proposing a plan.

In Claude Code, run `/mcp` and authenticate **ruflo-ai-team** if it shows "needs authentication".

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Skills load but Claude says the tools are unavailable | Connector not connected | Customize → Connectors → connect **ruflo-ai-team** |
| 401 or "authorization required" mid-session | Sign-in expired or scope not granted | Disconnect, reconnect, approve all scopes |
| Tools appear but return nothing for a team you created elsewhere | Different account signed in | Teams are tenant-isolated; sign in with the same account |
| Memory search reports `degraded: true` | Lexical fallback is active | Expected by default; results are keyword matches, not semantic |

Without the connector, Claude is instructed to stop and ask you to connect it rather than pretend to run a team.

## Architecture

- OAuth 2.1 resource server with RFC 9728 discovery and issuer/audience/scope verification.
- Tenant identity derived only from verified token claims; no tool accepts a tenant ID.
- Firestore is canonical storage; an in-memory store is used for tests and local development.
- The default vector backend is the bounded, tenant-scoped `lexical-degraded` fallback. Set `RUFLO_AI_TEAM_VECTOR=native` only after the exact `@ruvector/core` binary passes the startup self-test; an unavailable or incompatible binding falls back explicitly and never claims semantic search.
- Stored task, memory, and evidence content is provenance-labelled and nonce-fenced as untrusted data.
- Twelve focused tools, two prompts, and one public template resource.

## Local verification

```bash
npm install
npm test
npm run smoke
```

Run locally with `RUFLO_AI_TEAM_STORE=memory npm start`. Production requires a unique OAuth audience, Firestore IAM, and the environment variables documented in `deploy/cloud-run.yaml`.

## Compatibility

The plugin targets Ruflo / `@claude-flow/cli` v3.48 and pins its remote MCP contract at service version 0.1.x. Claude discovers skills, commands, and agents from the canonical plugin directories; the manifest intentionally contains no component arrays.

## Namespace coordination

The plugin owns the `ruflo-ai-team-*` namespace. Tenant data is never separated by a user-supplied namespace: authorization derives the tenant and every repository operation requires it. This follows the `ruflo-agentdb` ADR-0001 namespace convention while treating namespaces as organization aids, not security boundaries.

## Verification

`bash plugins/ruflo-ai-team/scripts/smoke.sh` runs structural checks and the Node test suite. The tests assert the exact tool inventory, complete annotations, OAuth challenges, scope errors, cross-tenant denial, bounded vector indexes, fenced retrieval, and evidence export.

## Architecture decisions

- [ADR-0001: Multi-tenant service boundary](docs/adrs/0001-multitenant-service-boundary.md)
- [ADR-0002: Approval and external-action boundary](docs/adrs/0002-approval-and-external-action-boundary.md)
- [ADR-0003: Tenant-scoped RuVector memory](docs/adrs/0003-tenant-scoped-ruvector-memory.md)
- [ADR-0004: Metered unit budget](docs/adrs/0004-metered-unit-budget.md)
