import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Counters, Dash, Lane, LogLine, SubAgent, Tokens } from '../types'

import { dim } from './frame'
import { drawPane, short, statusLine } from './pane'

const PANE = 'agent-dashboard'
const TITLE = 'Agent dashboard'
const MAX_LOG = 60
const MAX_MARKS = 4000
const MAX_AGENTS = 30

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const PLAN_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'TodoWrite'])
const TEST_RE = /\b(test|tests|jest|vitest|pytest|rspec|phpunit|mocha|playwright|cypress)\b/

const zero = (): Counters => ({ turns: 0, tools: 0, reads: 0, edits: 0, bash: 0, tests: 0, errors: 0 })

const empty = (): Dash => ({
  startedAt: 0,
  mainModel: '',
  isTurnRunning: false,
  running: null,
  main: zero(),
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
})

const dash = atom({ plugin: 'agent-dashboard', key: 'dash' } as const, empty())

// ---- state helpers -------------------------------------------------------

type $ = EngineInterface

async function change($: $, fn: (d: Dash, now: number) => Dash): Promise<void> {
  try {
    const now = await $.clock.now()
    await update($, dash, d => fn(d, now))
  } catch {
    // The dashboard only observes: a failed write never touches the session.
  }
}

function logged(d: Dash, now: number, lane: Lane, who: string, what: string, tag = ''): Dash {
  const line: LogLine = { at: now, lane, who, what, tag }
  return {
    ...d,
    log: [...d.log, line].slice(-MAX_LOG),
    marks: [...d.marks, { at: now, lane }].slice(-MAX_MARKS),
  }
}

function withPhase(d: Dash, phase: string, now: number): Dash {
  if (phase === d.phase) return d
  return { ...d, phase, phases: [...d.phases, { at: now, phase }].slice(-50) }
}

function agentOf(d: Dash, agentId: string | undefined): SubAgent | undefined {
  return agentId === undefined ? undefined : d.agents.find(a => a.id === agentId)
}

function laneOf(agent: SubAgent | undefined, agentId: string | undefined): Lane {
  if (agentId === undefined) return 'main'
  return agent?.type === 'Explore' ? 'scout' : 'agent'
}

function whoOf(agent: SubAgent | undefined, agentId: string | undefined, mainModel: string): string {
  if (agentId === undefined) return short(mainModel) || 'main'
  return agent === undefined ? 'subagent' : `${agent.type}`
}

function base(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

function describeCall(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  if (str('file_path') !== '') return `${tool} ${base(str('file_path'))}`
  if (str('notebook_path') !== '') return `${tool} ${base(str('notebook_path'))}`
  if (str('command') !== '') return `${tool} ${oneLine(str('command'), 48)}`
  if (str('pattern') !== '') return `${tool} ${oneLine(str('pattern'), 40)}`
  if (str('url') !== '') return `${tool} ${oneLine(str('url'), 48)}`
  if (str('query') !== '') return `${tool} ${oneLine(str('query'), 40)}`
  if (str('description') !== '') return `${tool} ${oneLine(str('description'), 40)}`
  return tool
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function addTokens(into: Record<string, Tokens>, model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): Record<string, Tokens> {
  const was = into[model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  return {
    ...into,
    [model]: {
      input: was.input + u.input_tokens,
      output: was.output + u.output_tokens,
      cacheRead: was.cacheRead + u.cache_read_input_tokens,
      cacheWrite: was.cacheWrite + u.cache_creation_input_tokens,
    },
  }
}

async function refreshCost($: $): Promise<void> {
  try {
    const usage = await $.session.usage()
    await update($, dash, d => ({
      ...d,
      startedAt: d.startedAt === 0 ? usage.startedAt : d.startedAt,
      costUsd: usage.cost?.usd ?? d.costUsd,
    }))
  } catch {
    // No ledger on this host: the cost stays as it was.
  }
}

async function openPane($: $, isAsked: boolean): Promise<string> {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  if (opened.isPlaced) return 'Agent dashboard opened.'
  if (isAsked) $.ui.toast('This surface does not place panes; the band above the prompt shows the summary.')
  return 'This surface does not place panes; the band above the prompt shows the summary.'
}

// ---- hooks ----------------------------------------------------------------

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dashboard', description: 'Open the agent dashboard (subagents, advisor, timeline, cost, log)' })
    await refreshCost($)
    if (options.autoOpen !== false) void openPane($, false).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'dashboard' }, async $ => ({ text: await openPane($, true) }))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const now = await $.clock.now()
      await update($, dash, () => ({ ...empty(), startedAt: now }))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await change($, (d, now) => {
      const turns = d.main.turns + 1
      return logged({ ...d, isTurnRunning: true, main: { ...d.main, turns } }, now, 'main', whoOf(undefined, undefined, d.mainModel), `turn ${turns} started`)
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const calls = (r.serverToolUses ?? []).filter(u => u.name === 'advisor')
    await change($, (d, now) => {
      let out: Dash = d
      if (e.agentId === undefined && e.model !== '' && e.model !== d.mainModel) out = { ...out, mainModel: e.model }
      if (r.usage !== null) out = { ...out, tokens: addTokens(out.tokens, r.usage.model, r.usage) }
      for (const call of calls) {
        const at = call.startedAt || now
        out = logged({ ...out, advisor: [...out.advisor, { at, phase: out.phase }] }, at, 'advisor', 'advisor', `review · during ${out.phase}`, 'reads all')
      }
      return out
    })
    return r
  })

  on('turn.complete', async ($, e, next) => {
    await change($, (d, now) => {
      if (e.agentId !== undefined) {
        const agent = agentOf(d, e.agentId)
        const agents = d.agents.map(a => (a.id === e.agentId ? { ...a, endedAt: now } : a))
        return logged({ ...d, agents }, now, laneOf(agent, e.agentId), whoOf(agent, e.agentId, d.mainModel), `done in ${Math.round(e.durationMs / 1000)}s`, e.isAborted ? 'aborted' : 'report')
      }
      return logged({ ...d, isTurnRunning: false, running: null }, now, 'main', whoOf(undefined, undefined, d.mainModel), `turn done in ${Math.round(e.durationMs / 1000)}s`, e.reason)
    })
    await refreshCost($)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const agentId = r.agentId
    if (agentId !== undefined) {
      await change($, (d, now) => {
        const agent: SubAgent = {
          id: agentId,
          type: e.subagentType,
          model: r.model,
          description: e.description,
          startedAt: now,
          endedAt: null,
          tools: 0,
          reads: 0,
        }
        const scouted = e.subagentType === 'Explore' ? withPhase(d, 'scout', now) : d
        const next1 = { ...scouted, agents: [...scouted.agents, agent].slice(-MAX_AGENTS) }
        return logged(next1, now, laneOf(agent, agentId), agent.type, `${short(agent.model)} · ${oneLine(e.description, 40)}`, 'spawned')
      })
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const isMain = e.agentId === undefined
    const what = describeCall(e.tool, e)
    const command = e.tool === 'Bash' ? e.command : ''
    const isTest = command !== '' && TEST_RE.test(command)

    await change($, (d, now) => {
      const agent = agentOf(d, e.agentId)
      const who = whoOf(agent, e.agentId, d.mainModel)
      return { ...d, running: { tool: e.tool, who, since: now } }
    })

    const ran = await next(e)

    await change($, (d, now) => {
      const agent = agentOf(d, e.agentId)
      const lane = laneOf(agent, e.agentId)
      const who = whoOf(agent, e.agentId, d.mainModel)
      const isDenied = ran.deny !== undefined
      const isError = !isDenied && ran.isError === true
      const isRead = READ_TOOLS.has(e.tool)
      const isEdit = EDIT_TOOLS.has(e.tool)

      let out: Dash = { ...d, running: d.running?.since !== undefined && d.running.tool === e.tool ? null : d.running }

      if (isMain) {
        const m = out.main
        out = {
          ...out,
          main: {
            ...m,
            tools: m.tools + 1,
            reads: m.reads + (isRead ? 1 : 0),
            edits: m.edits + (isEdit && !isError && !isDenied ? 1 : 0),
            bash: m.bash + (e.tool === 'Bash' ? 1 : 0),
            tests: m.tests + (isTest ? 1 : 0),
            errors: m.errors + (isError ? 1 : 0),
          },
        }
        let phase = out.phase
        if (PLAN_TOOLS.has(e.tool)) phase = 'plan'
        else if (isEdit) phase = phase === 'fix' ? 'fix' : 'edit'
        else if (isTest) phase = isError ? 'fix' : 'verify'
        else if (isError) phase = 'fix'
        out = withPhase(out, phase, now)
      } else if (agent !== undefined) {
        out = {
          ...out,
          agents: out.agents.map(a => (a.id === agent.id ? { ...a, tools: a.tools + 1, reads: a.reads + (isRead ? 1 : 0) } : a)),
        }
      }

      if (isError) {
        const text = oneLine(ran.text ?? '', 120)
        const isRepeat = text !== '' && text === out.lastError
        out = { ...out, lastError: text, repeatedErrors: out.repeatedErrors + (isRepeat ? 1 : 0) }
        out = { ...out, marks: [...out.marks, { at: now, lane: 'error' as Lane }].slice(-MAX_MARKS) }
        return logged(out, now, lane, who, what, isRepeat ? 'same error again' : 'error')
      }

      const tag = isDenied ? 'denied' : isTest ? 'test' : isEdit ? 'edit' : isRead ? 'read-only' : ''
      return logged(out, now, lane, who, what, tag)
    })

    return ran
  }).catch(($, e, next) => next(e))

  // ---- drawing ------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const d = await read($, dash)
    const now = await $.clock.now()
    const lines = drawPane(d, now, Math.max(48, e.props.bodyColumns - 1))

    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text wrap="truncate-end">
            {line.length === 0 ? ' ' : line.map(s => (
              <Text color={s.c} bold={s.b} dimColor={s.d} inverse={s.inv}>{s.t}</Text>
            ))}
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (options.band === false || e.props.hasSurvey) return next(e)
    const d = await read($, dash)
    if (d.main.turns === 0 && d.agents.length === 0) return next(e)

    const { Text } = $.ui.resolve(e)
    const line = [...statusLine(d), dim('  · /dashboard')]
    return (
      <Text wrap="truncate-end">
        {line.map(s => (
          <Text color={s.c} bold={s.b} dimColor={s.d}>{s.t}</Text>
        ))}
      </Text>
    )
  })
}
