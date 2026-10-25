/**
 * Managed Agent MCP tools — Anthropic Claude Managed Agents as a *cloud*
 * agent runtime alongside ruflo's local WASM-sandboxed agents (`rvagent` /
 * `wasm_agent_*`). See ADR-115.
 *
 * Wraps the Managed Agents REST API (beta, `anthropic-beta:
 * managed-agents-2026-04-01`) with plain `fetch` — no new SDK dependency.
 * Needs `ANTHROPIC_API_KEY` (or `CLAUDE_API_KEY`); every tool degrades
 * gracefully with a structured error when the key is absent so the CLI/MCP
 * server stays up.
 *
 * Lifecycle (mirrors `wasm_agent_*`):
 *   managed_agent_create   → agents.create + environments.create + sessions.create  ↔ wasm_agent_create
 *   managed_agent_prompt   → events.send(user.message) + poll events until idle      ↔ wasm_agent_prompt
 *   managed_agent_status   → GET /v1/sessions/{id}
 *   managed_agent_events   → GET /v1/sessions/{id}/events  (full transcript)          ↔ wasm_agent_files (artifacts/log)
 *   managed_agent_list     → GET /v1/sessions
 *   managed_agent_terminate→ DELETE /v1/sessions/{id} (+ optionally the env)          ↔ wasm_agent_terminate
 */

import type { MCPTool } from './types.js';
import { dynamicConfig, eventPage, readManagedEvents, ManagedProgress, type ManagedEvent } from '../services/managed-workflows.js';

// Dedicated override avoids forwarding credentials to a generic model proxy.
function apiBase(): string {
  const url = new URL(process.env.RUFLO_MANAGED_AGENTS_BASE_URL || 'https://api.anthropic.com');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Managed Agents endpoint must be an HTTPS origin');
  }
  return url.origin;
}
const BETA_HEADER = 'managed-agents-2026-04-01';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const POLL_INTERVAL_MS = 1500;
const DEFAULT_MAX_WAIT_MS = 180_000; // 3 min — long enough for a real task, bounded so a tool call never hangs forever

function apiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || null;
}

function headers(key: string): Record<string, string> {
  return {
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': BETA_HEADER,
    'content-type': 'application/json',
  };
}

const NEEDS_KEY = {
  error:
    'managed-agent runtime needs ANTHROPIC_API_KEY (or CLAUDE_API_KEY) and Claude Managed Agents beta access. ' +
    'For a local, no-key agent runtime use wasm_agent_create instead (rvagent / WASM sandbox).',
};

async function maRequest<T = unknown>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; error: string; body?: unknown }> {
  const key = apiKey();
  if (!key) return { ok: false, status: 0, error: NEEDS_KEY.error };
  try {
    const res = await fetch(`${apiBase()}/v1${path}`, {
      method, headers: headers(key), redirect: 'error',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, 30_000))),
    });
    // Never echo upstream bodies: they may contain prompts, keys or MCP tokens.
    if (!res.ok) { await res.body?.cancel(); return { ok: false, status: res.status, error: `Managed Agents API HTTP ${res.status}` }; }
    if (res.status === 204) return { ok: true, status: res.status, data: undefined as T };
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 8_000_000) { await reader.cancel(); throw new Error('response limit'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return { ok: true, status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
  } catch {
    return { ok: false, status: 0, error: 'Managed Agents transport or response error; inspect provider status before retrying mutations' };
  }
}

// ---- shapes (only the fields we touch) -----------------------------------
interface MaAgent { id: string; version?: number; name?: string; model?: { id: string } }
interface MaEnvironment { id: string; name?: string; config?: unknown }
interface MaSession { id: string; status?: string; title?: string; error?: string | null; agent?: MaAgent; environment_id?: string }
type MaEvent = ManagedEvent;

function summarizeEvents(events: MaEvent[]) {
  const progress = new ManagedProgress();
  progress.accept(events);
  return progress.snapshot();
}

async function fetchSessionEvents(sessionId: string, since?: string, threadId?: string, deadline = Date.now() + 30_000): Promise<MaEvent[]> {
  return readManagedEvents(async query => {
    const thread = threadId ? `/threads/${encodeURIComponent(threadId)}` : '';
    const params = new URLSearchParams(query);
    if (threadId) { params.delete('order'); params.delete('created_at[gte]'); }
    if (Date.now() >= deadline) throw new Error('Managed Agents observation deadline reached');
    const r = await maRequest('GET', `/sessions/${encodeURIComponent(sessionId)}${thread}/events?${params}`, undefined, deadline - Date.now());
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }, since);
}

// Gate new-turn observations on the provider's acknowledged message ID, not
// on a local timestamp or a historical idle event. Calls are serialized locally.
const pendingPrompts = new Set<string>();
async function waitForIdle(sessionId: string, maxWaitMs: number, messageId: string) {
  const deadline = Date.now() + Math.max(1_000, Math.min(maxWaitMs, 600_000));
  const progress = new ManagedProgress();
  let started = false;
  while (Date.now() < deadline) {
    const events = await fetchSessionEvents(sessionId, started ? progress.watermark() : undefined, undefined, deadline);
    if (!started) {
      const boundary = events.findIndex(e => e.id === messageId && !!e.processed_at);
      if (boundary >= 0) {
        // Existing runs remain relevant when a user steers an active session.
        const prior = new ManagedProgress();
        const history = events.slice(0, boundary).filter(e => e.type.startsWith('workflow_run.'));
        prior.accept(history);
        const open = new Set(prior.snapshot().workflowRuns.filter(r => r.status !== 'ended').map(r => r.id));
        progress.accept(history.filter(e => e.workflow_run_id && open.has(e.workflow_run_id)));
        progress.accept(events.slice(boundary));
        started = true;
      }
    } else progress.accept(events);
    const state = progress.snapshot();
    if (started && (state.finished || state.blocked || (state.interrupted && state.status === 'idle') || state.status === 'terminated')) return state;
    await new Promise(r => setTimeout(r, Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))));
  }
  return progress.snapshot();
}

function definiteRejection(status: number): boolean { return [400, 401, 403, 404, 422].includes(status); }

function maName(prefix: string, given?: unknown): string {
  if (typeof given === 'string' && given.trim()) return given.trim().slice(0, 80);
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------

export const managedAgentTools: MCPTool[] = [
  {
    name: 'managed_agent_create',
    description:
      'Spin up an Anthropic-managed cloud agent (Agent + Environment + Session) — the CLOUD counterpart of wasm_agent_create. Use when wasm_agent_create (local WASM sandbox) is wrong because the task is long-running/async (minutes-hours), needs a real cloud container with pre-installed packages + network, or persistent filesystem + transcript across turns. For a fast, free, ephemeral, offline agent use wasm_agent_create (rvagent). Needs ANTHROPIC_API_KEY + Managed Agents beta access. Opt into dynamic workflows with dynamicWorkflows=true and mandatory budgetCents (integer US cents); networking is then limited. Returns {sessionId, agentId, environmentId}; pair with managed_agent_prompt.',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name (default: auto)' },
        model: { type: 'string', description: 'Model id (default: claude-sonnet-4-6)' },
        system: { type: 'string', description: 'System prompt' },
        title: { type: 'string', description: 'Session title' },
        mcpServers: {
          type: 'array',
          description: 'MCP servers to expose to the agent — each {type:"url", url, name, authorization_token?}. NOTE: the cloud agent must be able to *reach* the URL (a local `ruflo mcp start` is not reachable from Anthropic\'s cloud — deploy/tunnel it).',
          items: { type: 'object' },
        },
        skills: { type: 'array', description: 'Skills to attach to the agent', items: { type: 'object' } },
        packages: { type: 'object', description: 'Environment packages: {pip?:[], npm?:[], apt?:[], cargo?:[], gem?:[], go?:[]}' },
        networking: { type: 'string', enum: ['unrestricted', 'restricted', 'none', 'limited'], description: 'Legacy default unrestricted; dynamic workflows require limited' },
        dynamicWorkflows: { type: 'boolean', description: 'Opt in to multiagent_20261001 dynamic workflows (requires budgetCents)' },
        budgetCents: { type: 'string', pattern: '^[1-9][0-9]{0,8}$', description: 'Positive integer US cents string; 2500 means $25; in-flight requests may overshoot' },
        allowedHosts: { type: 'array', items: { type: 'string' }, description: 'Exact allowed hostnames for dynamic workflow limited networking' },
        predefinedAgents: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' }, description: 'Restrict workflows to these agent IDs; disables inline agents' },
        initScript: { type: 'string', description: 'Environment init script (bash, run at container start)' },
      },
    },
    handler: async (input) => {
      if (!apiKey()) return { success: false, ...NEEDS_KEY };

      let config: ReturnType<typeof dynamicConfig>;
      try { config = dynamicConfig(input); } catch (error) { return { success: false, error: (error as Error).message }; }

      // 1. Agent
      const agentBody: Record<string, unknown> = {
        name: maName('ruflo-managed', input.name),
        model: typeof input.model === 'string' && input.model ? input.model : DEFAULT_MODEL,
        tools: [{ type: 'agent_toolset_20260401' }],
      };
      if (typeof input.system === 'string') agentBody.system = input.system;
      if (config.multiagent) agentBody.multiagent = config.multiagent;
      if (Array.isArray(input.mcpServers) && input.mcpServers.length) agentBody.mcp_servers = input.mcpServers;
      if (Array.isArray(input.skills) && input.skills.length) agentBody.skills = input.skills;
      const a = await maRequest<MaAgent>('POST', '/agents', agentBody);
      if (!a.ok) return { success: false, stage: 'agent', error: a.error };
      if (!a.data || typeof a.data.id !== 'string' || !/^agent_[A-Za-z0-9]+$/.test(a.data.id)) return { success: false, stage: 'agent', error: 'Invalid agent acknowledgement; inspect provider resources before retrying' };

      // 2. Environment
      const envBody: Record<string, unknown> = {
        name: maName('ruflo-managed-env', input.name),
        config: { type: 'cloud', networking: config.networking },
      };
      if (input.packages && typeof input.packages === 'object') (envBody.config as Record<string, unknown>).packages = { type: 'packages', ...(input.packages as object) };
      if (typeof input.initScript === 'string' && input.initScript) (envBody.config as Record<string, unknown>).init_script = input.initScript;
      const e = await maRequest<MaEnvironment>('POST', '/environments', envBody);
      if (!e.ok) {
        if (!definiteRejection(e.status)) return { success: false, stage: 'environment', agentId: a.data.id, error: e.error, cleanupRequired: true };
        const cleanup = await maRequest('DELETE', `/agents/${encodeURIComponent(a.data.id)}`);
        return { success: false, stage: 'environment', agentId: a.data.id, error: e.error, agentDeleted: cleanup.ok };
      }

      if (!e.data || typeof e.data.id !== 'string' || !/^env_[A-Za-z0-9]+$/.test(e.data.id)) return { success: false, stage: 'environment', agentId: a.data.id, error: 'Invalid environment acknowledgement; inspect provider resources before retrying', cleanupRequired: true };

      // 3. Session
      const s = await maRequest<MaSession>('POST', '/sessions', {
        agent: a.data.id,
        environment_id: e.data.id,
        title: maName('ruflo-managed session', input.title),
        ...(config.budget ? { budget: config.budget } : {}),
      });
      if (!s.ok) {
        if (!definiteRejection(s.status)) return { success: false, stage: 'session', agentId: a.data.id, environmentId: e.data.id, error: s.error, cleanupRequired: true };
        const envCleanup = await maRequest('DELETE', `/environments/${encodeURIComponent(e.data.id)}`);
        const agentCleanup = await maRequest('DELETE', `/agents/${encodeURIComponent(a.data.id)}`);
        return { success: false, stage: 'session', agentId: a.data.id, environmentId: e.data.id, error: s.error, environmentDeleted: envCleanup.ok, agentDeleted: agentCleanup.ok };
      }

      if (!s.data || typeof s.data.id !== 'string' || !/^sesn_[A-Za-z0-9]+$/.test(s.data.id)) return { success: false, stage: 'session', agentId: a.data.id, environmentId: e.data.id, error: 'Invalid session acknowledgement; inspect provider resources before retrying', cleanupRequired: true };
      return {
        success: true,
        runtime: 'managed',
        sessionId: s.data.id,
        agentId: a.data.id,
        agentVersion: a.data.version,
        environmentId: e.data.id,
        status: s.data.status ?? 'idle',
        model: agentBody.model,
        dynamicWorkflows: config.enabled,
        budget: config.budget,
        verification: 'unverified',
        note: 'Cloud agent provisioned. Send work with managed_agent_prompt({sessionId, message}); inspect with managed_agent_events; clean up with managed_agent_terminate (running sessions consume runtime and tokens).',
      };
    },
  },
  {
    name: 'managed_agent_prompt',
    description:
      'Send a user turn to a managed cloud-agent session and wait for it to go idle, returning the assistant text + a tool-use trace — the CLOUD counterpart of wasm_agent_prompt. Use when wasm_agent_prompt (local WASM) is wrong because the work is long-running, needs the cloud container, or must persist across turns. Polls the session event log up to maxWaitMs (default 180s); for very long tasks raise maxWaitMs or follow up with managed_agent_events. Pair with managed_agent_create (for sessionId).',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id from managed_agent_create' },
        message: { type: 'string', description: 'The user turn / task for the agent' },
        maxWaitMs: { type: 'number', description: 'Max ms to wait for the session to go idle (default 180000, capped at 600000)' },
      },
      required: ['sessionId', 'message'],
    },
    handler: async (input) => {
      if (!apiKey()) return { success: false, ...NEEDS_KEY };
      const sessionId = String(input.sessionId ?? '');
      const message = String(input.message ?? '');
      if (!sessionId) return { success: false, error: 'sessionId is required' };
      if (!message) return { success: false, error: 'message is required' };

      if (input.maxWaitMs !== undefined && (typeof input.maxWaitMs !== 'number' || !Number.isFinite(input.maxWaitMs) || input.maxWaitMs <= 0)) return { success: false, error: 'maxWaitMs must be finite and positive' };
      if (pendingPrompts.has(sessionId)) return { success: false, error: 'A prompt is already pending for this session' };
      pendingPrompts.add(sessionId);
      try {
        const send = await maRequest('POST', `/sessions/${encodeURIComponent(sessionId)}/events`, {
          events: [{ type: 'user.message', content: [{ type: 'text', text: message }] }],
        });
        if (!send.ok) return { success: false, stage: 'send', sessionId, error: send.error };
        const sent = eventPage(send.data).data.find(e => e.type === 'user.message');
        if (!sent) return { success: false, sessionId, error: 'Missing message acknowledgement; inspect events before retrying' };
        const maxWait = typeof input.maxWaitMs === 'number' ? input.maxWaitMs : DEFAULT_MAX_WAIT_MS;
        const state = await waitForIdle(sessionId, maxWait, sent.id);
        return {
          success: state.observedFailures === 0 && state.status !== 'terminated',
          runtime: 'managed', sessionId, messageId: sent.id, ...state,
          note: 'Provider output is unverified. Inspect workflow threads and independently test artifacts. A wait timeout does not stop remote execution; inspect events or terminate explicitly.',
        };
      } catch (error) {
        return { success: false, sessionId, finished: false, error: (error as Error).message };
      } finally { pendingPrompts.delete(sessionId); }
    },
  },
  {
    name: 'managed_agent_status',
    description:
      'Get the lifecycle state of a managed cloud-agent session: idle/running/error, title, last error. Use when native conversation memory is wrong because you need the cloud session\'s server-side status across turns rather than guessing. For a local WASM agent use wasm_agent_list. Pair with managed_agent_events for the full transcript.',
    category: 'agent',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: 'Session id' } }, required: ['sessionId'] },
    handler: async (input) => {
      if (!apiKey()) return { ...NEEDS_KEY };
      const sessionId = String(input.sessionId ?? '');
      if (!sessionId) return { error: 'sessionId is required' };
      const r = await maRequest<MaSession>('GET', `/sessions/${encodeURIComponent(sessionId)}`);
      if (!r.ok) return { sessionId, error: r.error };
      return { runtime: 'managed', sessionId: r.data.id, status: r.data.status, title: r.data.title, error: r.data.error ?? null, environmentId: r.data.environment_id };
    },
  },
  {
    name: 'managed_agent_events',
    description:
      'Fetch the full server-persisted event log of a managed cloud-agent session (user turns, agent thinking, tool_use, tool_result, status) — the transcript/artifact view, the CLOUD counterpart of wasm_agent_files. Use when native Read is wrong because the work happened in Anthropic\'s cloud container, not on disk. For a local WASM agent\'s filesystem use wasm_agent_files. Returns the events plus a summary (assistantText, toolUses).',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id' },
        threadId: { type: 'string', description: 'Optional child thread ID from session.thread_created; inspect worker failures' },
        raw: { type: 'boolean', description: 'Include the full raw event objects (default: summary + compact list)' },
      },
      required: ['sessionId'],
    },
    handler: async (input) => {
      if (!apiKey()) return { ...NEEDS_KEY };
      const sessionId = String(input.sessionId ?? '');
      if (!sessionId) return { error: 'sessionId is required' };
      let events: MaEvent[];
      try { events = await fetchSessionEvents(sessionId, undefined, typeof input.threadId === 'string' ? input.threadId : undefined); } catch (error) { return { success: false, sessionId, error: (error as Error).message }; }
      const sum = summarizeEvents(events);
      const compact = events.map(e => {
        if (e.type === 'agent.message') return { type: e.type, text: (e.content ?? []).filter(b => b?.type === 'text').map(b => b.text ?? '').join('').slice(0, 500) };
        if (e.type === 'agent.tool_use') return { type: e.type, name: e.name, input: e.input };
        if (e.type === 'agent.tool_result') return { type: e.type, content: JSON.stringify(e.content ?? {}).slice(0, 500) };
        return { id: e.id, type: e.type, workflowRunId: e.workflow_run_id, threadId: e.session_thread_id, result: e.result, ...(e.stop_reason ? { stop_reason: e.stop_reason } : {}) };
      });
      return {
        runtime: 'managed',
        sessionId,
        ...sum,
        events: input.raw ? events : compact,
      };
    },
  },
  {
    name: 'managed_agent_list',
    description:
      'List managed cloud-agent sessions on this Anthropic org (id, status, title) — the CLOUD counterpart of wasm_agent_list. Use when native conversation memory is wrong because you need to see which cloud sessions exist (and which are still running / billing) across turns. For local WASM agents use wasm_agent_list. Pair with managed_agent_terminate to clean up idle sessions.',
    category: 'agent',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max sessions to return (default 50)' } } },
    handler: async (input) => {
      if (!apiKey()) return { ...NEEDS_KEY, sessions: [], total: 0 };
      const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(Math.floor(input.limit), 200) : 50;
      const r = await maRequest<{ data?: MaSession[]; sessions?: MaSession[] }>('GET', `/sessions?limit=${limit}`);
      if (!r.ok) return { sessions: [], total: 0, error: r.error };
      const list = (r.data.data ?? r.data.sessions ?? []) as MaSession[];
      return {
        runtime: 'managed',
        sessions: list.map(s => ({ sessionId: s.id, status: s.status, title: s.title, environmentId: s.environment_id })),
        total: list.length,
      };
    },
  },
  {
    name: 'managed_agent_interrupt',
    description: 'Request an interrupt for an Anthropic managed session. Use when native interruption cannot reach the remote cloud runtime; for local WASM use wasm_agent_terminate. This queues a pause, does not end workflow runs, and never confirms cancellation. Inspect managed_agent_events or explicitly terminate the session.',
    category: 'agent',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: 'Managed session to interrupt' } }, required: ['sessionId'] },
    handler: async input => {
      if (!apiKey()) return { success: false, ...NEEDS_KEY };
      if (typeof input.sessionId !== 'string' || !input.sessionId) return { success: false, error: 'sessionId is required' };
      const r = await maRequest('POST', `/sessions/${encodeURIComponent(input.sessionId)}/events`, { events: [{ type: 'user.interrupt' }] });
      return { success: r.ok, sessionId: input.sessionId, interruptRequested: r.ok, cancellationConfirmed: false, ...(!r.ok ? { error: r.error } : {}) };
    },
  },
  {
    name: 'managed_agent_terminate',
    description:
      'Delete a managed cloud-agent session (stops billing for it) — the CLOUD counterpart of wasm_agent_terminate. Use when native nothing applies because a running cloud session consumes runtime and tokens. For a local WASM agent use wasm_agent_terminate. Optionally also deletes the session\'s environment. Always call this when done with a managed agent.',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id to delete' },
        environmentId: { type: 'string', description: 'Optional: also delete this environment (the one returned by managed_agent_create)' },
      },
      required: ['sessionId'],
    },
    handler: async (input) => {
      if (!apiKey()) return { success: false, ...NEEDS_KEY };
      const sessionId = String(input.sessionId ?? '');
      if (!sessionId) return { success: false, error: 'sessionId is required' };
      const s = await maRequest('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
      const result: Record<string, unknown> = { runtime: 'managed', sessionId, sessionDeleted: s.ok };
      if (!s.ok) result.error = s.error;
      if (s.ok && typeof input.environmentId === 'string' && input.environmentId) {
        const e = await maRequest('DELETE', `/environments/${encodeURIComponent(String(input.environmentId))}`);
        result.environmentDeleted = e.ok;
        if (!e.ok) result.environmentError = e.error;
      }
      result.success = s.ok && result.environmentDeleted !== false;
      return result;
    },
  },
];
