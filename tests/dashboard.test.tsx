import { expect, mock, test } from 'claude-code/testing'

import { drawPane } from '../hooks/pane'
import { normalize } from '../hooks/state'
import type { Dash } from '../types'

const PANE = {
  plugin: 'agent-dashboard',
  component: 'Pane',
  requestId: 'agent-dashboard',
  props: {
    title: 'Agent dashboard',
    isFocused: false,
    bodyColumns: 110,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

test('the pane draws its sections on terminal and desktop', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    for (const text of [/SIGNS OFF/, /WORKER/, /CONTEXT/, /FILES/, /TESTS/, /COST/, /LIMITS/, /TOOLS/, /session timeline/, /tail -f session.log/]) {
      expect(await ui.find({ type: 'Text', text })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('a value stored by an older version still draws', async () => {
  // 0.3.x stored no files, tests, context or limits, and lanes named scout/agent.
  const old = {
    startedAt: 1, mainModel: 'claude-sonnet-5-5', isTurnRunning: false, running: null,
    main: { turns: 1, tools: 1, reads: 1, edits: 0, bash: 0, tests: 0, errors: 0 },
    agents: [], advisor: [{ at: 5, phase: 'plan' }], lastError: '', repeatedErrors: 0, tokens: {}, costUsd: 0.1,
    phase: 'plan', phases: [], marks: [{ at: 2, lane: 'scout' }], log: [{ at: 2, lane: 'scout', who: 'Explore', what: 'scan', tag: 'spawned' }],
  } as unknown as Dash
  for (const cols of [110, 70, 50]) {
    const text = drawPane(normalize(old), 10_000, cols).map(l => l.map(s => s.t).join('')).join('\n')
    expect(text).toContain('MAIN · SONNET 5.5')
    expect(text).toContain('turn 0 · plan')
  }
})

test('an edit is counted in FILES with its lines', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a\nb', new_string: 'a\nb\nc' } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /\+3\s+−2\s+src\/app\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /edits\s+1/ })).toBeDefined()
    await ui.unmount()
  }
})

test('test runs are told apart from commands that only mention tests', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as never)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "add test"' } as never)
  await $.tool.call({ tool: 'Bash', command: 'cd web && npm test' } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /passed\s+1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\[✓\] green/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the same error twice is flagged for the advisor', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('tool.call', () => ({ result: 'exit 1', isError: true, text: 'TypeError: x is undefined' }) as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /same error\s+1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /same error again: ask/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\[✗\] red/ })).toBeDefined()
    await ui.unmount()
  }
})
