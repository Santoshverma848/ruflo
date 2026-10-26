/**
 * The mission ledger lives in the plugin's own host store, and one plugin can have two (the console loaded inline, and the same console from
 * the marketplace): a mission made under one was absent under the other after a restart. The ledger is also copied into the project
 * (`.claude-flow/console/mission-ledger.json`) and taken back from it when the store has no ledger for the project. Run with
 *   npx vitest run plugins/ruflo-console/tests/mission-ledger-project-copy.spec.ts
 */
import { describe, expect, it } from 'vitest'

import { setWriteFlavor } from '../hooks/data/write-flavor'
import type { Host } from '../hooks/host'
import { activeMission, ledgerKeyOf, loadLedger, mcOf, saveLedger } from '../hooks/mission-control'
import { mirrorPathOf } from '../hooks/mission-ledger'
import type { MissionRecord } from '../hooks/mission-types'
import { newState, type State } from '../hooks/state'

const A = '/home/me/project-a'
const B = '/home/me/project-b'
const ID_A = 'msn_aaaaaaaaaaaaaaaaaaaaaaaa'
const ID_B = 'msn_bbbbbbbbbbbbbbbbbbbbbbbb'

const mission = (id: string, extra: Partial<MissionRecord> = {}): MissionRecord => ({
  id,
  objective: `goal ${id}`,
  profile: 'feature',
  rigor: 'standard',
  tasks: [],
  acceptance: [],
  events: [],
  paused: false,
  cancelled: false,
  auto: false,
  createdAtMs: 1,
  ...extra,
})

const stateIn = (cwd: string): State => Object.assign(newState(), { cwd })
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const idsAt = (stored: Map<string, unknown>, key: string): string[] => ((stored.get(key) as { missions?: MissionRecord[] } | undefined)?.missions ?? []).map(m => m.id)

/** A host with a store and an in-memory project folder (the Windows host-fs flavor writes through `fs.write`). */
const hostOf = (stored: Map<string, unknown>, files: Map<string, string>): Host =>
  ({
    storeGet: async (key: string) => stored.get(key),
    storeSet: async (key: string, value: unknown) => void stored.set(key, value),
    fs: {
      read: async (path: string) => files.get(path) ?? Promise.reject(new Error('ENOENT')),
      stat: async (path: string) => (files.has(path) ? { kind: 'file', size: files.get(path)?.length } : undefined),
      list: async () => [],
      write: async (path: string, text: string) => void files.set(path, text),
      exists: async (path: string) => files.has(path),
    },
  }) as unknown as Host

const withHostFs = async (run: () => Promise<void>) => {
  setWriteFlavor('host-fs')
  try {
    await run()
  } finally {
    setWriteFlavor(null)
  }
}

describe('mission ledger copy in the project', () => {
  it('a save writes the copy, and a store that never saw the mission gets it back', () =>
    withHostFs(async () => {
      const files = new Map<string, string>()
      const first = stateIn(A)
      mcOf(first).missions.set(ID_A, mission(ID_A, { cwd: A }))
      mcOf(first).active = ID_A
      saveLedger(first, hostOf(new Map(), files))
      await flush()
      expect(files.has(mirrorPathOf(A))).toBe(true)

      const otherStore = new Map<string, unknown>()
      const again = stateIn(A)
      await loadLedger(again, hostOf(otherStore, files))
      expect(activeMission(again)?.id).toBe(ID_A)
      expect(idsAt(otherStore, ledgerKeyOf(A))).toEqual([ID_A])
    }))

  it("does not take another project's mission from the copy", () =>
    withHostFs(async () => {
      const files = new Map<string, string>([[mirrorPathOf(A), JSON.stringify({ active: ID_B, missions: [mission(ID_B, { cwd: B })] })]])
      const state = stateIn(A)
      await loadLedger(state, hostOf(new Map(), files))
      expect(mcOf(state).missions.size).toBe(0)
      expect(activeMission(state)).toBeNull()
    }))

  it('leaves a store that already has a ledger for the project alone', () =>
    withHostFs(async () => {
      const files = new Map<string, string>([[mirrorPathOf(A), JSON.stringify({ missions: [mission(ID_A, { cwd: A })] })]])
      const store = new Map<string, unknown>([[ledgerKeyOf(A), { missions: [] }]])
      const state = stateIn(A)
      await loadLedger(state, hostOf(store, files))
      expect(mcOf(state).missions.size).toBe(0)
    }))

  it('ignores a copy that is not JSON', () =>
    withHostFs(async () => {
      const state = stateIn(A)
      await loadLedger(state, hostOf(new Map(), new Map([[mirrorPathOf(A), '{not json']])))
      expect(mcOf(state).missions.size).toBe(0)
    }))

  it('a host with no file API still saves and loads through the store alone', async () => {
    const stored = new Map<string, unknown>()
    const host = { storeGet: async (key: string) => stored.get(key), storeSet: async (key: string, value: unknown) => void stored.set(key, value) } as unknown as Host
    const first = stateIn(A)
    mcOf(first).missions.set(ID_A, mission(ID_A, { cwd: A }))
    saveLedger(first, host)
    await flush()
    const again = stateIn(A)
    await loadLedger(again, host)
    expect(mcOf(again).missions.has(ID_A)).toBe(true)
  })
})
