import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest, evaluate, evidenceOf, isVerified, manifestOf, observationOf, recommend, trustedEvidence, type Evidence, type Observation } from '../src/services/managed-learning.js';
import { evaluateLearning, indexLearning, learningStatus, recordLearning, recommendLearning, recallLearning } from '../src/services/managed-learning-store.js';

const memory = vi.hoisted(() => ({ store: vi.fn(), search: vi.fn(), get: vi.fn() }));
vi.mock('../src/memory/memory-initializer.js', () => ({ storeEntry: memory.store, searchEntries: memory.search, getEntry: memory.get }));
const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const scope = { taskType: 'code-review' as const, policyHash: digest('policy'), evaluatorHash: digest('evaluator') };
const manifest = manifestOf({ taskHashes: [digest('held-one'), digest('held-two')], trials: [0, 1, 2] });
function observation(patch: Partial<Observation> = {}): Observation {
  return observationOf({ v: 1, attemptId: digest('attempt'), taskHash: digest('task'), sourceHash: digest('source'), artifactHash: digest('artifact'), corpusHash: digest(manifest), ...scope, split: 'train', trial: 0,
    strategy: { id: 'baseline', model: 'claude-test', workers: 1, template: 'review' }, budgetCents: 250, costCents: 100, durationMs: 100,
    checks: { acceptance: true, safety: true, replay: true, adversarial: true, drift: 0, driftThreshold: .05, rollbackRate: 0 }, ...patch });
}
function signed(o: Observation): Evidence { return { observation: o, signature: sign(null, Buffer.from(canonical(o)), pair.privateKey).toString('base64') }; }
function training(): Evidence[] {
  return ['baseline', 'candidate'].flatMap(id => [0, 1, 2].map(trial => signed(observation({ attemptId: digest(`train-${id}-${trial}`), taskHash: digest(`training-${trial}`), trial, strategy: { id, model: 'claude-test', workers: id === 'baseline' ? 1 : 2, template: 'review' }, costCents: id === 'baseline' ? 100 : 50 }))));
}
function heldout(): Evidence[] {
  return ['baseline', 'candidate'].flatMap(id => manifest.taskHashes.flatMap(taskHash => manifest.trials.map(trial => signed(observation({ attemptId: digest(`${id}-${taskHash}-${trial}`), taskHash, trial, split: 'holdout', strategy: { id, model: 'claude-test', workers: id === 'baseline' ? 1 : 2, template: 'review' }, costCents: id === 'baseline' ? 100 : 50 })))));
}
const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), 'managed-learning-')); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); memory.store.mockReset(); memory.search.mockReset(); memory.get.mockReset(); });

describe('host verification boundary', () => {
  it('requires the host key and verifies all bound observation fields', () => {
    const evidence = signed(observation());
    expect(isVerified(evidence, publicKey)).toBe(true);
    expect(isVerified(evidence)).toBe(false);
    for (const key of ['sourceHash', 'artifactHash', 'policyHash', 'corpusHash', 'evaluatorHash']) {
      expect(isVerified({ ...evidence, observation: { ...evidence.observation, [key]: digest('tampered') } }, publicKey)).toBe(false);
    }
  });
  it('rejects self-asserted verified flags and arbitrary text', () => {
    expect(() => evidenceOf({ ...signed(observation()), verified: true })).toThrow();
    expect(() => observationOf({ ...observation(), prompt: 'private text' })).toThrow();
  });
  it('does not accept another signer or a mutated reloaded receipt', () => {
    const other = generateKeyPairSync('ed25519'); const evidence = signed(observation());
    expect(isVerified(evidence, other.publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBe(false);
    evidence.observation.costCents = 1;
    expect(trustedEvidence([JSON.parse(JSON.stringify(evidence))], publicKey)).toHaveLength(0);
  });
  it('detaches and freezes trusted evidence; direct raw objects cannot enter routing', () => {
    const raw = signed(observation()); const trusted = trustedEvidence([raw], publicKey);
    raw.observation.strategy.id = 'poison';
    expect(trusted[0]!.observation.strategy.id).toBe('baseline');
    expect(Object.isFrozen(trusted[0]!.observation.strategy)).toBe(true);
    expect(() => recommend([raw], scope)).toThrow('Host-verified');
  });
  it.each([NaN, Infinity, -1, 2])('rejects out-of-domain verifier metric %s', drift => {
    expect(() => observationOf({ ...observation(), checks: { ...observation().checks, drift } })).toThrow();
  });
  it('requires actual measured metrics for learning', () => {
    expect(trustedEvidence([signed(observation({ costCents: null }))], publicKey)).toHaveLength(0);
  });
});

describe('cohort learning and independent heldout gate', () => {
  it('learns advisory cost efficiency only from trusted training evidence', () => {
    const result = recommend(trustedEvidence(training(), publicKey), scope);
    expect(result).toMatchObject({ advisory: true, defaultsChanged: false, selected: { strategy: { id: 'candidate' }, successesPerDollar: 2, samples: 3 } });
    const unsigned = training().map(e => ({ observation: e.observation }));
    expect(recommend(trustedEvidence(unsigned, publicKey), scope).abstained).toBe(true);
  });
  it('never uses heldout observations to propose a strategy', () => {
    expect(recommend(trustedEvidence(heldout(), publicKey), scope).abstained).toBe(true);
  });
  it('isolates policy/evaluator scope and respects latency bounds', () => {
    const verified = trustedEvidence(training(), publicKey);
    expect(recommend(verified, { ...scope, policyHash: digest('other') }).abstained).toBe(true);
    expect(recommend(verified, scope, 99).abstained).toBe(true);
  });
  it('accepts a synthetic complete equal-budget paired experiment without changing defaults', () => {
    expect(evaluate(trustedEvidence([...training(), ...heldout()], publicKey), scope, manifest, 'baseline', 'candidate')).toMatchObject({ eligible: true, delta: 1, pairedResults: 6, noRegression: true, defaultsChanged: false, metaharness: { accept: true } });
  });
  it('rejects an incomplete experiment and a changed corpus manifest', () => {
    expect(() => evaluate(trustedEvidence(heldout().slice(1), publicKey), scope, manifest, 'baseline', 'candidate')).toThrow('Missing');
    const different = manifestOf({ ...manifest, taskHashes: [digest('different'), manifest.taskHashes[1]!] });
    expect(() => evaluate(trustedEvidence(heldout(), publicKey), scope, different, 'baseline', 'candidate')).toThrow();
  });
  it.each(['safety', 'replay', 'adversarial'])('refuses promotion when %s fails', field => {
    const rows = heldout(); const target = rows.find(e => e.observation.strategy.id === 'candidate')!;
    target.observation.checks = { ...target.observation.checks, [field]: false }; rows[rows.indexOf(target)] = signed(target.observation);
    expect(evaluate(trustedEvidence(rows, publicKey), scope, manifest, 'baseline', 'candidate').eligible).toBe(false);
  });
  it('rejects cheaper output that regresses on a previously successful task', () => {
    const rows = heldout(); const target = rows.find(e => e.observation.strategy.id === 'candidate')!;
    target.observation.checks.acceptance = false; rows[rows.indexOf(target)] = signed(target.observation);
    expect(evaluate(trustedEvidence(rows, publicKey), scope, manifest, 'baseline', 'candidate')).toMatchObject({ eligible: false, noRegression: false });
  });
  it('requires matching source identities and admitted budgets', () => {
    for (const patch of [{ sourceHash: digest('other') }, { budgetCents: 251 }]) {
      const rows = heldout(); const target = rows.find(e => e.observation.strategy.id === 'candidate')!;
      rows[rows.indexOf(target)] = signed(observation({ ...target.observation, ...patch }));
      expect(() => evaluate(trustedEvidence(rows, publicKey), scope, manifest, 'baseline', 'candidate')).toThrow('differ');
    }
  });
  it('rejects training overlap, duplicate manifest tasks and duplicate attempts', () => {
    const rows = heldout(); rows.push(signed(observation({ attemptId: digest('overlap'), taskHash: manifest.taskHashes[0]!, strategy: rows[0]!.observation.strategy })));
    expect(() => evaluate(trustedEvidence(rows, publicKey), scope, manifest, 'baseline', 'candidate')).toThrow('overlap');
    expect(() => manifestOf({ ...manifest, taskHashes: [manifest.taskHashes[0], manifest.taskHashes[0]] })).toThrow('unique');
    const first = training()[0]!;
    expect(() => trustedEvidence([first, signed(observation({ ...first.observation, costCents: 1 }))], publicKey)).toThrow('Conflicting');
  });
});

describe('durable quarantine, attestation and RuVector bridge', () => {
  it('keeps observations quarantined until a valid host attestation arrives', () => {
    const r = root(), e = signed(observation());
    expect(recordLearning(r, { observation: e.observation }, publicKey)).toMatchObject({ stored: true, verified: false });
    expect(learningStatus(r, publicKey)).toMatchObject({ verified: 0, quarantined: 1 });
    expect(recordLearning(r, e, publicKey)).toMatchObject({ stored: true, verified: true });
    expect(learningStatus(r, publicKey)).toMatchObject({ verified: 1, quarantined: 0 });
    expect(recordLearning(r, e, publicKey).duplicate).toBe(true);
    expect(JSON.parse(readFileSync(join(r, '.claude-flow/managed-learning/summary.json'), 'utf8'))).toMatchObject({ verified: 1, advisory: true, defaultsChanged: false });
  });
  it('quarantine cannot reserve a future verified attempt ID', () => {
    const r = root(), actual = signed(observation());
    recordLearning(r, { observation: observation({ costCents: 1 }) }, publicKey);
    expect(recordLearning(r, actual, publicKey)).toMatchObject({ stored: true, verified: true });
    expect(learningStatus(r, publicKey)).toMatchObject({ verified: 1, quarantined: 1 });
    expect(trustedEvidence([{ observation: observation({ costCents: 1 }) }, actual], publicKey)).toHaveLength(1);
  });
  it('rejects fake receipts and conflicting immutable outcomes before overwriting', () => {
    const r = root(), e = signed(observation()); recordLearning(r, e, publicKey);
    expect(() => recordLearning(r, signed(observation({ costCents: 1 })), publicKey)).toThrow('Conflicting');
    expect(() => recordLearning(r, { ...e, observation: observation({ sourceHash: digest('tampered') }) }, publicKey)).toThrow('Untrusted');
    expect(learningStatus(r, publicKey).verified).toBe(1);
  });
  it('revalidates reloaded records instead of trusting a modified local file', () => {
    const r = root(); recordLearning(r, signed(observation()), publicKey);
    const p = join(r, '.claude-flow/managed-learning/state.json'); const state = JSON.parse(readFileSync(p, 'utf8'));
    state.records[0].observation.costCents = 1; writeFileSync(p, JSON.stringify(state));
    expect(learningStatus(r, publicKey)).toMatchObject({ verified: 0, quarantined: 1 });
  });
  it('persists advisory recommendations and an eligible comparison without promotion', () => {
    const r = root(); for (const e of [...training(), ...heldout()]) recordLearning(r, e, publicKey);
    expect(recommendLearning(r, scope, publicKey).selected?.strategy.id).toBe('candidate');
    expect(evaluateLearning(r, { scope, manifest, baselineId: 'baseline', candidateId: 'candidate' }, publicKey).eligible).toBe(true);
    expect(learningStatus(r, publicKey)).toMatchObject({ lastEvaluation: { eligible: true }, defaultsChanged: false });
  });
  it('invalidates cached advice when receipts or host verifier change', () => {
    const r = root(); for (const e of [...training(), ...heldout()]) recordLearning(r, e, publicKey);
    recommendLearning(r, scope, publicKey); evaluateLearning(r, { scope, manifest, baselineId: 'baseline', candidateId: 'candidate' }, publicKey);
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(learningStatus(r, other)).toMatchObject({ verified: 0, lastRecommendation: { abstained: true }, lastEvaluation: null });
    const p = join(r, '.claude-flow/managed-learning/state.json'); const state = JSON.parse(readFileSync(p, 'utf8'));
    state.records.find((e: any) => e.observation.split === 'holdout').observation.costCents = 1;
    state.lastEvaluation = { eligible: true }; writeFileSync(p, JSON.stringify(state));
    expect(learningStatus(r, publicKey).lastEvaluation).toBeNull();
  });
  it('semantic recall revalidates every memory hit and excludes unsigned or heldout rows', async () => {
    const r = root(), rows = training(); for (const e of rows) recordLearning(r, e, publicKey);
    const valid = rows[0]!, forged = { observation: rows[1]!.observation };
    memory.search.mockResolvedValue({ success: true, results: [
      { key: digest(valid.observation), content: JSON.stringify(valid), score: .9, namespace: 'managed-workflow-evidence' },
      { key: digest(forged.observation), content: JSON.stringify(forged), score: 1, namespace: 'managed-workflow-evidence' },
    ] });
    memory.get.mockImplementation(async ({ key }) => ({ success: true, found: true, entry: { key, namespace: 'managed-workflow-evidence', content: JSON.stringify(key === digest(valid.observation) ? valid : forged) } }));
    const result = await recallLearning(r, scope, publicKey);
    expect(result).toMatchObject({ available: true, advisory: true, similarityIsVerification: false });
    expect(result.evidence).toHaveLength(1);
    expect(result.recommendation.selected?.strategy.id).toBe('candidate');
    expect(memory.search).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'managed-workflow-evidence' }));
  });
  it('hydrates truncated native search previews and rejects wrong scoped rows', async () => {
    const r = root(), e = training()[0]!, key = digest(e.observation);
    recordLearning(r, e, publicKey);
    memory.search.mockResolvedValue({ success: true, results: [{ key, content: JSON.stringify(e).slice(0, 60) + '...', score: .5, namespace: 'managed-workflow-evidence' }] });
    memory.get.mockResolvedValue({ success: true, found: true, entry: { key, namespace: 'managed-workflow-evidence', content: JSON.stringify(e) } });
    expect((await recallLearning(r, scope, publicKey)).evidence).toHaveLength(1);
    expect(memory.get).toHaveBeenCalledWith({ key, namespace: 'managed-workflow-evidence', dbPath: join(r, '.swarm/memory.db') });
    memory.get.mockResolvedValue({ success: true, found: true, entry: { key, namespace: 'other', content: JSON.stringify(e) } });
    expect((await recallLearning(r, scope, publicKey)).evidence).toHaveLength(0);
  });
  it('refuses symlink state locations and concurrent writer locks', () => {
    const r = root(), other = root(); symlinkSync(other, join(r, '.claude-flow'));
    expect(() => recordLearning(r, signed(observation()), publicKey)).toThrow('symlink');
    const r2 = root(); mkdirSync(join(r2, '.claude-flow/managed-learning'), { recursive: true });
    writeFileSync(join(r2, '.claude-flow/managed-learning/writer.lock'), 'held');
    expect(() => recordLearning(r2, signed(observation()), publicKey)).toThrow();
  });
  it('indexes only verified training evidence through native append-only storage', async () => {
    const r = root(), e = signed(observation()); recordLearning(r, e, publicKey);
    memory.store.mockResolvedValue({ success: true, embedding: { dimensions: 384 } });
    expect(await indexLearning(r, digest(e.observation), publicKey)).toMatchObject({ indexed: true, hasEmbedding: true });
    expect(memory.store).toHaveBeenCalledWith(expect.objectContaining({ requireNative: true, appendOnly: true, upsert: false, namespace: 'managed-workflow-evidence' }));
    memory.store.mockResolvedValue({ success: true, persistWarning: 'uncertain' });
    await expect(indexLearning(r, digest(e.observation), publicKey)).rejects.toThrow('durable');
  });
  it('never writes a vector entry for holdout or unsigned evidence', async () => {
    for (const e of [{ observation: observation() }, signed(observation({ split: 'holdout' }))]) {
      const r = root(); recordLearning(r, e, publicKey);
      await expect(indexLearning(r, digest(e.observation), publicKey)).rejects.toThrow('Verified training');
    }
    expect(memory.store).not.toHaveBeenCalled();
  });
});
