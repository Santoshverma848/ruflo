import { describe, expect, it } from 'vitest'

import { under } from '../hooks/data/files'
import { baseOf } from '../hooks/data/paths'
import { safeInstallPath } from '../hooks/data/research'
import { isRunFile } from '../hooks/data/wf-drill-io'
import { isUnder } from '../hooks/wf-cost-live'
import { isRunPath } from '../hooks/wf-actions'

// The console builds paths as `<root>/<name>` even when the root is `C:\Users\x\.claude`, so a run's folder is `C:\Users\x\.claude/projects/...`.
// Its guards must see `..` under either separator, and a config folder that ends in a backslash must still match.
const CONFIG = 'C:\\Users\\x\\.claude'
const RUN = `${CONFIG}/projects/-C--proj/sess/subagents/workflows/wf_1`

describe('the run-path guards on a Windows config folder', () => {
  it('accept a run folder and file under projects/', () => {
    expect(isRunPath(RUN, CONFIG)).toBe(true)
    expect(isRunFile(`${RUN}/agent.jsonl`, CONFIG)).toBe(true)
    expect(isUnder(`${CONFIG}/projects/x`, CONFIG)).toBe(true)
  })

  it('refuse a .. segment written with a backslash, which the old "/"-only split missed', () => {
    for (const path of [`${CONFIG}/projects/..\\..\\secret.txt`, `${CONFIG}/projects/a\\..\\b`, `${CONFIG}/projects/../x`]) {
      expect(isRunPath(path, CONFIG), path).toBe(false)
      expect(isRunFile(path, CONFIG), path).toBe(false)
      expect(isUnder(path, CONFIG), path).toBe(false)
    }
  })

  it('still match when the config folder ends in a backslash or a slash', () => {
    for (const config of [`${CONFIG}\\`, `${CONFIG}/`]) {
      expect(isRunPath(RUN, config), config).toBe(true)
      expect(isRunFile(`${RUN}/a.jsonl`, config), config).toBe(true)
      expect(isUnder(`${config.replace(/[\\/]+$/, '')}/projects/x`, config), config).toBe(true)
      expect(under(config, 'projects/x'), config).toBe(`${CONFIG}/projects/x`)
    }
  })

  it('keep the POSIX rules exactly', () => {
    expect(isRunPath('/h/.claude/projects/a/wf_1', '/h/.claude')).toBe(true)
    expect(isRunPath('/h/.claude/projects/../x', '/h/.claude')).toBe(false)
    expect(isRunPath('/h/.claude-other/projects/a', '/h/.claude')).toBe(false)
    expect(under('/h/.claude/', 'projects')).toBe('/h/.claude/projects')
    expect(isUnder('/h/.claude/projects/a..b/c', '/h/.claude')).toBe(true)
  })
})

describe('a plugin install path on Windows (the research reader)', () => {
  it('accepts a drive path and refuses a climbing, relative or shell-looking one, as on POSIX', () => {
    expect(safeInstallPath('C:\\Users\\x\\.claude\\plugins\\cache\\ruflo\\ruflo-goals\\0.3.0')).toBeDefined()
    expect(safeInstallPath('/home/u/.claude/plugins/cache/ruflo/ruflo-goals/0.3.0')).toBeDefined()

    for (const bad of ['relative', 'C:\\a\\..\\b', 'C:\\x; calc', 'C:\\x$(id)', '', undefined, 42]) expect(safeInstallPath(bad), String(bad)).toBeUndefined()
  })
})

describe('the project name shown on the menu and boot screen', () => {
  it('is the last folder under either separator, a trailing separator included', () => {
    expect(baseOf('/work/proj')).toBe('proj')
    expect(baseOf('/work/proj/')).toBe('proj')
    expect(baseOf('C:\\Users\\x\\proj')).toBe('proj')
    expect(baseOf('C:\\Users\\x\\proj\\')).toBe('proj')
    expect(baseOf('C:/Users/x/proj')).toBe('proj')
    expect(baseOf('\\\\srv\\share\\proj')).toBe('proj')
    expect(baseOf('')).toBe('')
  })
})
