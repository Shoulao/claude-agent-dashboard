import { expect, mock, test } from 'claude-code/testing'

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

test('the pane draws its sections on terminal and desktop', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /SIGNS OFF/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /session timeline/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /tail -f session.log/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a main-loop tool call is counted and logged', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Read app\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /100% tools/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the same error twice is flagged for the advisor', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('tool.call', () => ({ result: 'exit 1', isError: true, text: 'TypeError: x is undefined' }) as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /same error\s+1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▶ fix/})).toBeDefined()
    await ui.unmount()
  }
})
