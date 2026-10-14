import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Counters, Dash, Lane, LogLine, SubAgent, Tokens } from '../types'

const PANE = 'agent-dashboard'
const TITLE = 'Agent dashboard'
const MAX_LOG = 60
const MAX_MARKS = 4000
const MAX_AGENTS = 30

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const PLAN_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'TodoWrite'])
const TEST_RE = /\b(test|tests|jest|vitest|pytest|rspec|phpunit|mocha|playwright|cypress)\b/
const STAGES = ['scout', 'plan', 'edit', 'test', 'fix', 'verify']

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

function short(model: string): string {
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model)
  if (m === null) return model.replace(/^claude-/, '')
  return m[3] === undefined ? `${m[1]} ${m[2]}` : `${m[1]} ${m[2]}.${m[3]}`
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
        const phase = e.subagentType === 'Explore' && !d.isTurnRunning ? d.phase : e.subagentType === 'Explore' ? 'scout' : d.phase
        const next1 = { ...d, phase, agents: [...d.agents, agent].slice(-MAX_AGENTS) }
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
        out = { ...out, phase }
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
    const cols = Math.max(44, e.props.bodyColumns - 2)
    const isWide = cols >= 96
    const cardWidth = isWide ? Math.floor((cols - 2) / 3) : cols
    const startedAt = d.startedAt === 0 ? now : d.startedAt

    const clock = (at: number) => {
      const s = Math.max(0, Math.round((at - startedAt) / 1000))
      return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    }
    const pad = (text: string, n: number) => (text.length >= n ? text.slice(0, n) : text + ' '.repeat(n - text.length))

    const running = d.agents.filter(a => a.endedAt === null)
    const active = d.running !== null
      ? `${d.running.who} → ${d.running.tool}`
      : running.length > 0
        ? `${running[running.length - 1]?.type ?? 'subagent'} (subagent)`
        : d.isTurnRunning
          ? `${short(d.mainModel) || 'main'} thinking`
          : 'idle'
    const cost = d.costUsd === null ? '—' : `$${d.costUsd.toFixed(2)}`

    // header
    const header = (
      <Box flexDirection="column">
        <Text>
          <Text bold color="claude">AGENT DASHBOARD</Text>
          <Text dimColor> · {clock(now)} · </Text>
          <Text bold>{cost}</Text>
          <Text dimColor> · active: </Text>
          <Text bold color={active === 'idle' ? 'inactive' : 'success'}>{active}</Text>
        </Text>
        <Text>
          {STAGES.map(s => (
            <Text color={s === d.phase ? 'claude' : 'inactive'} bold={s === d.phase} inverse={s === d.phase}>
              {` ${s} `}
            </Text>
          ))}
          <Text dimColor>  phase (inferred from tool calls)</Text>
        </Text>
      </Box>
    )

    // cards
    const mainCard = (
      <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1} width={cardWidth}>
        <Text bold color="suggestion">MAIN · {short(d.mainModel) || 'session'}</Text>
        <Text dimColor>drives the session, edits the code</Text>
        <Text>turns  {pad(String(d.main.turns), 6)}tools  {d.main.tools}</Text>
        <Text>reads  {pad(String(d.main.reads), 6)}edits  {d.main.edits}</Text>
        <Text>
          tests  {pad(String(d.main.tests), 6)}errors <Text color={d.main.errors > 0 ? 'error' : 'text'}>{d.main.errors}</Text>
        </Text>
        <Text color={d.isTurnRunning ? 'success' : 'inactive'}>{d.isTurnRunning ? '▶ driving' : '◦ waiting for you'}</Text>
      </Box>
    )

    const recentAgents = d.agents.slice(-4).reverse()
    const agentsCard = (
      <Box flexDirection="column" borderStyle="round" borderColor="success" paddingX={1} width={cardWidth}>
        <Text bold color="success">SUBAGENTS · {running.length} running · {d.agents.length} total</Text>
        {recentAgents.length === 0 && <Text dimColor>none yet (Explore scouts show here)</Text>}
        {recentAgents.map(a => (
          <Text wrap="truncate-end" color={a.endedAt === null ? 'success' : 'inactive'}>
            {a.endedAt === null ? '▶' : '✓'} {a.type} · {short(a.model)} · {a.tools} tools
            {a.endedAt === null ? ` · ${Math.round((now - a.startedAt) / 1000)}s` : ''}
          </Text>
        ))}
      </Box>
    )

    const recentAdvice = d.advisor.slice(-3).reverse()
    const advisorCard = (
      <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1} width={cardWidth}>
        <Text bold color="warning">ADVISOR · {d.advisor.length} calls</Text>
        {recentAdvice.length === 0 && <Text dimColor>no calls yet</Text>}
        {recentAdvice.map(a => (
          <Text color="warning">◆ {clock(a.at)} during {a.phase}</Text>
        ))}
        <Text color={d.repeatedErrors > 0 ? 'error' : 'inactive'}>
          {d.repeatedErrors > 0 ? `! same error came back ×${d.repeatedErrors}` : '◦ no repeated errors'}
        </Text>
      </Box>
    )

    const cards = isWide ? (
      <Box flexDirection="row" gap={1}>{mainCard}{agentsCard}{advisorCard}</Box>
    ) : (
      <Box flexDirection="column">{mainCard}{agentsCard}{advisorCard}</Box>
    )

    // timeline
    const label = 9
    const width = Math.max(10, cols - label - 4)
    const span = Math.max(60_000, now - startedAt)
    const lanes: { lane: Lane; name: string; color: string }[] = [
      { lane: 'main', name: 'main', color: 'suggestion' },
      { lane: 'scout', name: 'scouts', color: 'success' },
      { lane: 'agent', name: 'agents', color: 'merged' },
      { lane: 'advisor', name: 'advisor', color: 'warning' },
      { lane: 'error', name: 'errors', color: 'error' },
    ]
    const counts: Record<string, number[]> = {}
    for (const l of lanes) counts[l.lane] = new Array<number>(width).fill(0)
    for (const m of d.marks) {
      const col = Math.min(width - 1, Math.max(0, Math.floor(((m.at - startedAt) / span) * width)))
      const row = counts[m.lane]
      if (row !== undefined) row[col] = (row[col] ?? 0) + 1
    }
    const cell = (lane: Lane, n: number) => (n === 0 ? '·' : lane === 'advisor' ? '◆' : lane === 'error' ? '✕' : n === 1 ? '▒' : n <= 3 ? '▓' : '█')
    const minutes = Math.round(span / 60_000)
    const timeline = (
      <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text bold>SESSION TIMELINE</Text>
        {lanes.map(l => (
          <Text wrap="truncate-end">
            <Text color={l.color}>{pad(l.name, label)}</Text>
            <Text color={l.color}>{(counts[l.lane] ?? []).map(n => cell(l.lane, n)).join('')}</Text>
          </Text>
        ))}
        <Text dimColor>{pad('', label)}{pad('0m', Math.max(0, width - `${minutes}m`.length))}{minutes}m</Text>
      </Box>
    )

    // tokens
    const models = Object.entries(d.tokens)
    const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
    const usage = (
      <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text>
          <Text bold>COST & TOKENS</Text>
          <Text dimColor> · session total </Text>
          <Text bold>{cost}</Text>
        </Text>
        {models.length === 0 && <Text dimColor>no model calls yet</Text>}
        {models.map(([model, t]) => (
          <Text wrap="truncate-end">
            {pad(short(model), 12)}
            <Text dimColor>in </Text>{pad(k(t.input), 7)}
            <Text dimColor>out </Text>{pad(k(t.output), 7)}
            <Text dimColor>cache read </Text>{pad(k(t.cacheRead), 7)}
            <Text dimColor>cache write </Text>{k(t.cacheWrite)}
          </Text>
        ))}
      </Box>
    )

    // tail -f
    const room = Math.max(4, Math.min(14, (e.viewport?.rows ?? 48) - 34))
    const laneColor: Record<Lane, string> = { main: 'suggestion', scout: 'success', agent: 'merged', advisor: 'warning', error: 'error' }
    const tagWidth = 16
    const whatWidth = Math.max(10, cols - 6 - 16 - tagWidth - 6)
    const tail = (
      <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text bold>tail -f session.log</Text>
        {d.log.length === 0 && <Text dimColor>waiting for the first event…</Text>}
        {d.log.slice(-room).map(line => (
          <Text wrap="truncate-end">
            <Text dimColor>{clock(line.at)} </Text>
            <Text color={laneColor[line.lane]}>{pad(line.who, 16)}</Text>
            {pad(line.what, whatWidth)}
            <Text color={line.tag === 'error' || line.tag === 'same error again' ? 'error' : 'inactive'}> {line.tag}</Text>
          </Text>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={0}>
        {header}
        {cards}
        {timeline}
        {usage}
        {tail}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (options.band === false || e.props.hasSurvey) return next(e)
    const d = await read($, dash)
    if (d.main.turns === 0 && d.agents.length === 0) return next(e)

    const { Text } = $.ui.resolve(e)
    const running = d.agents.filter(a => a.endedAt === null).length
    const cost = d.costUsd === null ? '' : ` · $${d.costUsd.toFixed(2)}`
    return (
      <Text dimColor wrap="truncate-end">
        phase [{d.phase}] · {short(d.mainModel) || 'main'} [{d.isTurnRunning ? 'driving' : 'idle'}] · subagents [{running} running] · advisor [{d.advisor.length}]{cost} · /dashboard
      </Text>
    )
  })
}
