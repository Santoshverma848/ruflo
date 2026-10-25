import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { managedAgentTools } from '../src/mcp-tools/managed-agent-tools.js';
import { dynamicConfig, ManagedProgress, readManagedEvents, type ManagedEvent } from '../src/services/managed-workflows.js';

const event = (id: string, type: string, extra = {}): ManagedEvent => ({ id, type, processed_at: '2026-10-24T12:00:00Z', ...extra });
const idle = (id: string, reason = 'end_turn') => event(id, 'session.status_idle', { stop_reason: { type: reason } });
const call = (name: string, input: Record<string, unknown> = {}) => managedAgentTools.find(t => t.name === name)!.handler(input) as Promise<any>;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
let testRoot = '';
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'managed-api-'));
  vi.stubEnv('CLAUDE_FLOW_CWD', testRoot);
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-do-not-log');
  vi.stubEnv('RUFLO_MANAGED_AGENTS_BASE_URL', 'https://api.anthropic.com');
  fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('dynamic workflow admission', () => {
  it('keeps legacy create unchanged and dynamic off', () => {
    expect(dynamicConfig({})).toMatchObject({ enabled: false, networking: { type: 'unrestricted' } });
  });
  it.each([undefined, '', '0', '01', '-1', '25.00', '1e3', 2500, '1000000000'])('rejects invalid cents %s before side effects', async budgetCents => {
    expect((await call('managed_agent_create', { dynamicWorkflows: true, budgetCents })).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('builds explicit bounded workflow config with restricted agents', () => {
    expect(dynamicConfig({ dynamicWorkflows: true, budgetCents: '2500', predefinedAgents: ['agent_abc'] })).toMatchObject({
      budget: { type: 'limit', max_list_cost: { amount: '2500', currency: 'USD' } },
      multiagent: { type: 'multiagent_20261001', subagents: { type: 'disabled' }, workflows: { inline_agents: { type: 'disabled' }, predefined_agents: ['agent_abc'] } },
      networking: { type: 'limited', allowed_hosts: [] },
    });
  });
  it.each([{ networking: 'unrestricted' }, { allowedHosts: ['*'] }, { allowedHosts: ['https://example.com'] }, { predefinedAgents: [] }, { predefinedAgents: ['../../x'] }, { dynamicWorkflows: 'true' }])('rejects malformed policy %j', async bad => {
    expect((await call('managed_agent_create', { dynamicWorkflows: true, budgetCents: '2500', ...bad })).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('attaches budget at session creation and multiagent to agent', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'agent_a' })).mockResolvedValueOnce(json({ id: 'env_a' })).mockResolvedValueOnce(json({ id: 'sesn_a' }));
    const result = await call('managed_agent_create', { dynamicWorkflows: true, budgetCents: '2500', allowedHosts: ['github.com'] });
    expect(result.success).toBe(true);
    const bodies = fetchMock.mock.calls.map(c => JSON.parse(c[1].body));
    expect(bodies[0].multiagent.type).toBe('multiagent_20261001');
    expect(bodies[1].config.networking).toEqual({ type: 'limited', allowed_hosts: ['github.com'] });
    expect(bodies[2].budget.max_list_cost.amount).toBe('2500');
  });
});

describe('provider lifecycle evidence', () => {
  it('does not mistake an open workflow for completion', () => {
    const p = new ManagedProgress();
    p.accept([event('r', 'workflow_run.created', { workflow_run_id: 'w' }), idle('i')]);
    expect(p.snapshot()).toMatchObject({ finished: false, openRuns: 1, verification: 'unverified' });
    p.accept([event('end', 'workflow_run.status_ended', { workflow_run_id: 'w', result: { type: 'completed' } })]);
    expect(p.snapshot()).toMatchObject({ finished: false, needsThreadInspection: true, verification: 'unverified' });
    p.accept([idle('final')]);
    expect(p.snapshot().finished).toBe(true);
  });
  it.each(['budget_reached', 'requires_action'])('returns pause distinctly: %s', reason => {
    const p = new ManagedProgress(); p.accept([idle('i', reason)]);
    expect(p.snapshot()).toMatchObject({ blocked: true, finished: false });
  });
  it('does not erase an observed worker error when workflow completes', () => {
    const p = new ManagedProgress();
    p.accept([event('err', 'session.error'), event('e', 'workflow_run.status_ended', { workflow_run_id: 'w', result: { type: 'completed' } }), idle('i')]);
    expect(p.snapshot()).toMatchObject({ observedFailures: 1, verification: 'unverified' });
  });
  it('does not accept an interrupt idle as completion', () => {
    const p = new ManagedProgress(); p.accept([event('int', 'user.interrupt'), idle('i')]);
    expect(p.snapshot()).toMatchObject({ finished: false, interrupted: true });
    p.accept([event('next', 'user.message'), idle('nextIdle')]);
    expect(p.snapshot()).toMatchObject({ finished: true, interrupted: false });
  });
  it('deduplicates inclusive watermark replay and tracks usage', () => {
    const p = new ManagedProgress(); const events = [event('a', 'agent.message', { content: [{ type: 'text', text: 'hello' }] }), event('u', 'session.usage', { usage: { list_cost: { amount: '42', currency: 'USD' }, active_seconds: 10 } })];
    p.accept(events); p.accept(events);
    expect(p.snapshot()).toMatchObject({ assistantText: 'hello', eventCount: 2, listCost: { amount: '42' } });
  });
  it('handles queued user events when they later process', () => {
    const p = new ManagedProgress(); p.accept([event('q', 'user.message', { processed_at: null })]);
    expect(p.snapshot().eventCount).toBe(0);
    p.accept([event('q', 'user.message')]); expect(p.snapshot().eventCount).toBe(1);
  });
});

describe('pagination and observation', () => {
  it('follows opaque next_page with URL encoding and deduplicates', async () => {
    const read = vi.fn().mockResolvedValueOnce({ data: [idle('a')], next_page: 'opaque&x=y' }).mockResolvedValueOnce({ data: [idle('a'), idle('b')] });
    expect((await readManagedEvents(read)).map(e => e.id)).toEqual(['a', 'b']);
    expect(new URLSearchParams(read.mock.calls[1][0]).get('page')).toBe('opaque&x=y');
  });
  it('rejects cursor cycles', async () => {
    await expect(readManagedEvents(async () => ({ data: [], next_page: 'same' }))).rejects.toThrow('Repeated');
  });
  it.each([null, {}, { data: [null] }, { data: [{}] }, { data: [], next_page: 5 }])('fails closed on malformed pages %j', async value => {
    await expect(readManagedEvents(async () => value)).rejects.toThrow('Invalid');
  });
  it('propagates event HTTP failure without echoing upstream secrets', async () => {
    fetchMock.mockImplementation(() => json({ error: { message: 'test-key-do-not-log' } }, 403));
    const result = await call('managed_agent_events', { sessionId: 'sesn_a' });
    expect(result.success).toBe(false); expect(result.error).toContain('403'); expect(JSON.stringify(result)).not.toContain('test-key');
  });
  it('ignores historical idle before the acknowledged current message', async () => {
    vi.useFakeTimers();
    const initial = [idle('old'), event('current', 'user.message'), event('running', 'session.status_running')];
    fetchMock.mockResolvedValueOnce(json({ data: [event('current', 'user.message', { processed_at: null })] }))
      .mockResolvedValueOnce(json({ data: initial }))
      .mockResolvedValueOnce(json({ id: 'sesn_a', status: 'running' }))
      .mockResolvedValueOnce(json({ data: [...initial, event('text', 'agent.message', { content: [{ type: 'text', text: 'new answer' }] }), idle('new')] }))
      .mockResolvedValueOnce(json({ id: 'sesn_a', status: 'idle' }));
    const pending = call('managed_agent_prompt', { sessionId: 'sesn_a', message: 'run', maxWaitMs: 5000 });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;
    expect(result).toMatchObject({ finished: true, assistantText: 'new answer', verification: 'unverified' });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(new URL(fetchMock.mock.calls[3][0]).searchParams.has('created_at[gte]')).toBe(true);
  });
  it('rejects concurrent local prompts without sending twice', async () => {
    let release!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const first = call('managed_agent_prompt', { sessionId: 'sesn_a', message: 'one' });
    expect((await call('managed_agent_prompt', { sessionId: 'sesn_a', message: 'two' })).success).toBe(false);
    release(json({ data: [] })); await first;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('reads worker thread events through an encoded path', async () => {
    fetchMock.mockImplementation(() => json({ data: [event('err', 'session.error')] }));
    const result = await call('managed_agent_events', { sessionId: 'sesn_a', threadId: 'thread_a', raw: true });
    expect(fetchMock.mock.calls[0][0]).toContain('/threads/thread_a/events?limit=100');
    expect(result.observedFailures).toBe(1);
  });
  it('accepts legitimate tool confirmation result strings', async () => {
    fetchMock.mockImplementation(() => json({ data: [event('confirm', 'user.tool_confirmation', { result: 'allow' }), event('run', 'session.status_running'), idle('done')] }));
    expect((await call('managed_agent_events', { sessionId: 'sesn_a' })).finished).toBe(true);
  });
  it('rejects workflow lifecycle events without a run ID', async () => {
    fetchMock.mockImplementation(() => json({ data: [event('broken', 'workflow_run.created'), idle('done')] }));
    expect((await call('managed_agent_events', { sessionId: 'sesn_a' })).success).toBe(false);
  });
  it('does not contaminate a new prompt with old failed runs', async () => {
    const events = [event('oldErr', 'workflow_run.error', { workflow_run_id: 'old' }), event('oldEnd', 'workflow_run.status_ended', { workflow_run_id: 'old', result: { type: 'error' } }), idle('oldIdle'), event('current', 'user.message'), idle('done')];
    fetchMock.mockResolvedValueOnce(json({ data: [event('current', 'user.message')] })).mockResolvedValueOnce(json({ data: events })).mockResolvedValueOnce(json({ id: 'sesn_a', status: 'idle' }));
    expect(await call('managed_agent_prompt', { sessionId: 'sesn_a', message: 'new task' })).toMatchObject({ success: true, finished: true, observedFailures: 0 });
  });
});

describe('transport and cleanup security', () => {
  it('marks ambiguous initial agent creation for inspection without blind cleanup', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network outcome unknown'));
    expect(await call('managed_agent_create')).toMatchObject({ success: false, stage: 'agent', cleanupRequired: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(json({ id: 'unexpected' }));
    expect(await call('managed_agent_create')).toMatchObject({ success: false, stage: 'agent', cleanupRequired: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('does not reuse a generic model proxy or follow redirects', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://wrong.example');
    fetchMock.mockImplementation(() => json({ id: 'sesn_a' }));
    await call('managed_agent_status', { sessionId: 'sesn_a' });
    expect(fetchMock.mock.calls[0][0]).toContain('https://api.anthropic.com/');
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
    expect(fetchMock.mock.calls[0][1].headers['anthropic-beta']).toBe('managed-agents-2026-04-01');
  });
  it.each(['http://api.anthropic.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?token=x'])('rejects unsafe endpoint %s', async base => {
    vi.stubEnv('RUFLO_MANAGED_AGENTS_BASE_URL', base);
    expect((await call('managed_agent_status', { sessionId: 'sesn_a' })).error).toContain('transport');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('cleans up created resources after definite session rejection', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'agent_a' })).mockResolvedValueOnce(json({ id: 'env_a' }))
      .mockResolvedValueOnce(json({}, 400)).mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await call('managed_agent_create', { dynamicWorkflows: true, budgetCents: '100' });
    expect(result).toMatchObject({ success: false, stage: 'session', environmentDeleted: true, agentDeleted: true });
  });
  it('preserves resources after ambiguous session creation failure', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'agent_a' })).mockResolvedValueOnce(json({ id: 'env_a' })).mockRejectedValueOnce(new Error('socket closed'));
    const result = await call('managed_agent_create', { dynamicWorkflows: true, budgetCents: '100' });
    expect(result).toMatchObject({ success: false, stage: 'session', cleanupRequired: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('does not delete an environment if session deletion failed', async () => {
    fetchMock.mockImplementation(() => json({}, 500));
    expect((await call('managed_agent_terminate', { sessionId: 'sesn_a', environmentId: 'env_a' })).success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('reports environment cleanup failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(json({}, 409));
    expect((await call('managed_agent_terminate', { sessionId: 'sesn_a', environmentId: 'env_a' })).success).toBe(false);
  });
  it('never calls a queued interrupt confirmed cancellation', async () => {
    fetchMock.mockImplementation(() => json({ data: [] }));
    expect(await call('managed_agent_interrupt', { sessionId: 'sesn_a' })).toMatchObject({ interruptRequested: true, cancellationConfirmed: false });
  });
});

it('discards an observation when host credentials rotate during provider reads', async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/events?')) {
      process.env.ANTHROPIC_API_KEY = 'rotated-host-key';
      return json({ data: [idle('done')] });
    }
    return json({ id: 'sesn_a', status: 'idle' });
  });
  const result = await call('managed_agent_events', { sessionId: 'sesn_a' });
  expect(result.success).toBe(false);
  expect(result.error).toContain('scope changed');
});
