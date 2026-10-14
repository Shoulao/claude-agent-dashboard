// The dashboard's state shape and its defaults: pure, so tests and previews load it alone.
import type { Counters, Dash, Lane } from '../types'

export const zero = (): Counters => ({ turns: 0, tools: 0, reads: 0, edits: 0, bash: 0, tests: 0, errors: 0 })

export const empty = (): Dash => ({
  startedAt: 0,
  mainModel: '',
  advisorModel: '',
  isTurnRunning: false,
  isPaneOpen: false,
  running: null,
  main: zero(),
  toolMix: {},
  agents: [],
  advisor: [],
  lastError: '',
  repeatedErrors: 0,
  tokens: {},
  costUsd: null,
  phase: 'idle',
  phases: [],
  marks: [],
  log: [],
  context: null,
  limits: [],
  files: [],
  tests: [],
  slow: [],
  mcp: {},
  compactions: [],
  git: null,
})

const toLane = (lane: string): Lane => (lane === 'scout' || lane === 'agent' ? 'worker' : (lane as Lane))

/** A value written by an older version, brought up to the current shape. */
export function normalize(raw: Dash): Dash {
  const d = { ...empty(), ...raw }
  return {
    ...d,
    main: { ...zero(), ...d.main },
    advisor: d.advisor.map(a => ({ ...a, turn: typeof a.turn === 'number' ? a.turn : 0 })),
    marks: d.marks.map(m => ({ ...m, lane: toLane(m.lane) })),
    log: d.log.map(l => ({ ...l, lane: toLane(l.lane) })),
  }
}

