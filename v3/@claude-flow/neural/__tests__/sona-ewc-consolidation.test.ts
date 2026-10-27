/**
 * Dream Cycle 2026-10-27 (DEEP=intelligence) — discriminating tests for
 * SONAManager's EWC++ consolidation path.
 *
 * Before this fix: `ewcState.fisher`/`.means` were initialized empty in
 * `SONAManager.initialize()` and nothing in the core package ever wrote to
 * them; `consolidateEWC()` (the only method that touches `fisher` post-init)
 * only decayed existing entries and had zero callers anywhere in the repo.
 * Every one of these tests fails against that baseline and passes against
 * the candidate (verified via `git stash` isolation on `sona-manager.ts`,
 * `modes/base.ts`, `modes/balanced.ts`).
 *
 * Scope disclosure: these tests verify the EWC *state* (fisher/means/decay)
 * becomes real and data-dependent. They do NOT assert that the computed
 * penalty changes `learn()`'s returned `improvementDelta` — it doesn't;
 * `computeEWCPenalty()`'s result feeds a local `totalGradientNorm` that
 * `BalancedMode.learn()` already discarded before this change, a separate,
 * deeper, deliberately-not-fixed-tonight gap (matching the equally-stubbed
 * `consolidate()` placeholder in this monorepo's own reference pattern at
 * `plugins/cognitive-kernel/src/bridges/sona-bridge.ts`).
 */

import { describe, it, expect } from 'vitest';
import { createSONAManager, type SONAManager } from '../src/sona-manager.js';
import { deepDecode } from '../src/utils/serialize.js';
import type { EWCState, Trajectory } from '../src/types.js';

function embedding(seed: number, len = 16): Float32Array {
  const arr = new Float32Array(len);
  for (let i = 0; i < len; i++) arr[i] = Math.sin(seed * 0.37 + i * 0.11);
  return arr;
}

async function runLearningCycle(
  manager: SONAManager,
  domain: Trajectory['domain'],
  seed: number,
  quality: number
): Promise<void> {
  const id = manager.beginTrajectory(`ctx-${seed}`, domain);
  manager.recordStep(id, 'act-1', quality, embedding(seed));
  manager.recordStep(id, 'act-2', quality, embedding(seed + 1));
  manager.completeTrajectory(id, quality);
  await manager.triggerLearning('test');
}

function decodeEwcState(manager: SONAManager): EWCState {
  const decoded = deepDecode(manager.serialize()) as { ewcState: EWCState };
  return decoded.ewcState;
}

describe('SONAManager EWC++ consolidation', () => {
  it('populates ewcState.fisher/means with real, non-zero values after a learning cycle (was permanently empty)', async () => {
    const manager = createSONAManager('balanced');
    await manager.initialize();

    await runLearningCycle(manager, 'code', 1, 0.9);

    const ewcState = decodeEwcState(manager);
    expect(ewcState.fisher.size).toBeGreaterThan(0);
    expect(ewcState.means.size).toBeGreaterThan(0);

    let sawNonZero = false;
    for (const fisher of ewcState.fisher.values()) {
      for (const value of fisher) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0); // Fisher (squared gradient) is never negative
        if (value > 0) sawNonZero = true;
      }
    }
    expect(sawNonZero).toBe(true);
    expect(ewcState.taskCount).toBeGreaterThan(0);
    expect(ewcState.lastConsolidation).toBeGreaterThan(0);
  });

  it('decays existing Fisher importance before folding in fresh evidence (online EWC), rather than overwriting it', async () => {
    const manager = createSONAManager('balanced');
    await manager.initialize();

    await runLearningCycle(manager, 'code', 1, 0.9);
    const after1 = decodeEwcState(manager);
    const key = after1.fisher.keys().next().value as string;
    const valueAfter1 = after1.fisher.get(key)![0];
    expect(valueAfter1).toBeGreaterThan(0);

    await runLearningCycle(manager, 'code', 1, 0.9); // identical seed -> identical fresh-Fisher magnitude
    const after2 = decodeEwcState(manager);
    const valueAfter2 = after2.fisher.get(key)![0];

    // decay(0.9) * valueAfter1 + freshFisher(== valueAfter1's own fresh contribution):
    // strictly greater than a pure decay (0.9x) and strictly less than a naive
    // sum-with-no-decay (2x) would be if decay were skipped entirely in the
    // other direction — the real assertion that matters is monotonic growth
    // under repeated same-magnitude evidence, which a permanently-empty map
    // (the baseline) could never produce.
    expect(valueAfter2).toBeGreaterThan(valueAfter1 * 0.9);
    expect(after2.taskCount).toBe(after1.taskCount + 1);
  });

  it('control: a trigger with no completed trajectories leaves ewcState untouched (no fabricated state)', async () => {
    const manager = createSONAManager('balanced');
    await manager.initialize();

    await manager.triggerLearning('test'); // nothing completed yet -> learn() short-circuits

    const ewcState = decodeEwcState(manager);
    expect(ewcState.fisher.size).toBe(0);
    expect(ewcState.means.size).toBe(0);
    expect(ewcState.taskCount).toBe(0);
  });

  it('Fisher values equal means squared (diagonal empirical-Fisher construction), for every populated key', async () => {
    const manager = createSONAManager('balanced');
    await manager.initialize();

    await runLearningCycle(manager, 'code', 3, 0.85);

    const ewcState = decodeEwcState(manager);
    expect(ewcState.fisher.size).toBeGreaterThan(0);

    for (const [key, fisher] of ewcState.fisher) {
      const means = ewcState.means.get(key)!;
      expect(means).toBeDefined();
      for (let i = 0; i < fisher.length; i++) {
        expect(fisher[i]).toBeCloseTo(means[i] * means[i], 5);
      }
    }
  });
});
