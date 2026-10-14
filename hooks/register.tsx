import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Dash, FileChange, Lane, LogLine, SubAgent, Tokens } from '../types'

import { dim, fit, seg } from './frame'
import { drawPane, short, statusLine } from './pane'
import { EDIT_TOOLS, READ_TOOLS, empty, normalize } from './state'

const PANE = 'agent-dashboard'
const TITLE = 'Agent dashboard'
const MAX_LOG = 60
const MAX_MARKS = 4000
const MAX_AGENTS = 30
const MAX_FILES = 40
const MAX_TESTS = 30
const SLOW_MS = 10_000
// A pure grey: on a terminal that reports only 256 colours a hex colour is rounded
// to the nearest palette entry, and a near-black with any blue in it lands on navy.
const SCREEN_BG = '#161616'
const SCREEN_INK = '#c9cde3'

// Appended to an Explore worker's task: its report lands in main's context and
// is re-sent on every later turn, so a short report is the cheapest one.
const CONCISE_REPORT = 'Report back briefly: the answer first, then findings as `path:line` bullets of one line each. Do not paste file contents. Stay under 200 words unless the task asks for more.'

// The three moments to consult the advisor, as a system prompt section.
const ADVISOR_RULE = 'Consult the advisor only at three points: before locking in a plan, after hitting the same error twice, and before declaring a task done; not more often.'

const PLAN_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'TodoWrite'])
// Time spent here is waiting on a person or a whole subagent run, not a slow tool.
const UNTIMED_TOOLS = new Set(['Agent', 'Task', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'Workflow'])
// A test runner as a command word: `npm test`, `cd web && pnpm vitest`, `pytest -q`.
const TEST_RE = /(?:^|&&|;|\|\||\()\s*(?:\w+=\S*\s+)*(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:npx|pnpm|yarn|bunx|bun)\s+(?:jest|vitest|mocha|playwright\s+test|cypress\s+run)\b|(?:jest|vitest|mocha|pytest|rspec|phpunit)\b|python3?\s+-m\s+pytest\b|(?:go|cargo)\s+test\b|bundle\s+exec\s+rspec\b|(?:\.\/)?vendor\/bin\/phpunit\b)/

const dash = atom({ plugin: 'agent-dashboard', key: 'dash' } as const, empty())

// ---- state helpers -------------------------------------------------------

type $ = EngineInterface

async function change($: $, fn: (d: Dash, now: number) => Dash): Promise<void> {
  try {
    const now = await $.clock.now()
    await update($, dash, d => fn(normalize(d), now))
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

function laneOf(agentId: string | undefined): Lane {
  return agentId === undefined ? 'main' : 'worker'
}

function whoOf(agent: SubAgent | undefined, agentId: string | undefined): string {
  if (agentId === undefined) return 'main'
  return agent === undefined ? 'worker' : agent.type
}

function base(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

/** `parent/name`, so two `index.ts` files stay apart. */
function shortPath(path: string): string {
  const parts = path.split('/').filter(p => p !== '')
  return parts.slice(-2).join('/') || path
}

function lines(text: unknown): number {
  return typeof text === 'string' && text !== '' ? text.split('\n').length : 0
}

function describeCall(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const name = tool.startsWith('mcp__') ? `mcp ${mcpName(tool)}` : tool
  if (str('file_path') !== '') return `${name} ${base(str('file_path'))}`
  if (str('notebook_path') !== '') return `${name} ${base(str('notebook_path'))}`
  if (str('command') !== '') return `${name} ${oneLine(str('command'), 48)}`
  if (str('pattern') !== '') return `${name} ${oneLine(str('pattern'), 40)}`
  if (str('url') !== '') return `${name} ${oneLine(str('url'), 48)}`
  if (str('query') !== '') return `${name} ${oneLine(str('query'), 40)}`
  if (str('description') !== '') return `${name} ${oneLine(str('description'), 40)}`
  return name
}

function mcpName(tool: string): string {
  const parts = tool.split('__')
  return parts[parts.length - 1] ?? tool
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

/** What an edit tool did to its file, in lines; undefined for other tools. */
function fileChangeOf(tool: string, input: Record<string, unknown>): { path: string; added: number; removed: number; isWritten: boolean } | undefined {
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
  if (path === '') return undefined
  if (tool === 'Write') return { path, added: lines(input.content), removed: 0, isWritten: true }
  if (tool === 'Edit') return { path, added: lines(input.new_string), removed: lines(input.old_string), isWritten: false }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    let added = 0
    let removed = 0
    for (const edit of input.edits as Record<string, unknown>[]) {
      added += lines(edit.new_string)
      removed += lines(edit.old_string)
    }
    return { path, added, removed, isWritten: false }
  }
  if (tool === 'NotebookEdit') return { path, added: lines(input.new_source), removed: 0, isWritten: false }
  return undefined
}

/** Context fill, plan limits and cost: the status line's figures, no API calls. */
async function refreshUsage($: $): Promise<void> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    await update($, dash, raw => {
      const d = normalize(raw)
      const c = usage.context
      return {
        ...d,
        startedAt: d.startedAt === 0 ? usage.startedAt : d.startedAt,
        costUsd: usage.cost?.usd ?? d.costUsd,
        context: {
          tokens: c.tokens ?? null,
          window: c.window,
          percent: c.percent ?? null,
          compactAt: c.breakdown?.isAutoCompactEnabled === true ? (c.breakdown.autoCompactThreshold ?? null) : null,
        },
        limits: usage.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt ?? null })),
      }
    })
  } catch {
    // A host without these figures leaves the cards as they were.
  }
}

/** Branch and changed files, once at the start and once per turn: never per tool. */
async function refreshGit($: $): Promise<void> {
  try {
    const repo = await $.session.repo()
    // A repo's own config can name a program for git to run (core.fsmonitor); turn that off,
    // so opening a session in a cloned repo never runs its code. Repo hooks are off already.
    const ran = await $.process.run(['git', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'status', '--porcelain', '-b'], { timeoutMs: 3000 })
    const out = ran.stdout.split('\n').filter(l => l !== '')
    const head = out[0] ?? ''
    const branch = head.startsWith('## No commits yet on ')
      ? head.slice('## No commits yet on '.length)
      : head.replace(/^## /, '').split('...')[0]?.split(' ')[0] ?? ''
    const name = repo?.name ?? base(repo?.root ?? '')
    await change($, d => ({
      ...d,
      git: ran.exitCode === 0
        ? { isRepo: true, repo: name, branch, changed: Math.max(0, out.length - 1) }
        : { isRepo: false, repo: name, branch: '', changed: 0 },
    }))
  } catch {
    // No git on this machine: the header leaves it out.
  }
}

async function readAdvisorModel($: $): Promise<void> {
  try {
    const settings = await $.settings.read()
    const model = typeof settings.advisorModel === 'string' ? settings.advisorModel : ''
    await change($, d => ({ ...d, advisorModel: model }))
  } catch {
    // Unreadable settings: the advisor card shows no model.
  }
}

async function openPane($: $, isAsked: boolean): Promise<string> {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  await change($, d => ({ ...d, isPaneOpen: opened.isPlaced }))
  if (opened.isPlaced) return 'Agent dashboard opened.'
  if (isAsked) $.ui.toast('This surface does not place panes; the band above the prompt shows the summary.')
  return 'This surface does not place panes; the band above the prompt shows the summary.'
}

// ---- hooks ----------------------------------------------------------------

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dashboard', description: 'Open the agent dashboard (main, worker, advisor, context, files, tests, cost)' })
    await refreshUsage($)
    await readAdvisorModel($)
    void refreshGit($)
    if (options.autoOpen !== false) void openPane($, false).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'dashboard' }, async $ => ({ text: await openPane($, true) }))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await change($, d => ({ ...d, isPaneOpen: false }))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const now = await $.clock.now()
      await update($, dash, raw => ({ ...empty(), startedAt: now, isPaneOpen: normalize(raw).isPaneOpen, advisorModel: normalize(raw).advisorModel }))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await change($, (d, now) => {
      const turns = d.main.turns + 1
      return logged({ ...d, isTurnRunning: true, main: { ...d.main, turns } }, now, 'main', 'main', `turn ${turns} started`)
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const calls = (r.serverToolUses ?? []).filter(u => u.name === 'advisor')
    await change($, (d, now) => {
      let out: Dash = d
      if (e.agentId === undefined && e.model !== '' && e.model !== d.mainModel) out = { ...out, mainModel: e.model }
      if (r.usage !== null) out = { ...out, tokens: addTokens(out.tokens, r.usage.model, r.usage), tokensByRole: addTokens(out.tokensByRole, e.agentId === undefined ? 'main' : 'worker', r.usage) }
      for (const call of calls) {
        const at = call.startedAt || now
        out = logged({ ...out, advisor: [...out.advisor, { at, phase: out.phase, turn: out.main.turns }] }, at, 'advisor', 'advisor', `review · during ${out.phase}`, 'reads all')
      }
      return out
    })
    return r
  })

  on('turn.complete', async ($, e, next) => {
    await change($, (d, now) => {
      if (e.agentId !== undefined) {
        const agent = agentOf(d, e.agentId)
        const agents = d.agents.map(a => (a.id === e.agentId ? { ...a, endedAt: now, reportChars: e.answer.length } : a))
        return logged({ ...d, agents }, now, 'worker', whoOf(agent, e.agentId), `done in ${Math.round(e.durationMs / 1000)}s`, e.isAborted ? 'aborted' : 'report')
      }
      return logged({ ...d, isTurnRunning: false, running: null }, now, 'main', 'main', `turn done in ${Math.round(e.durationMs / 1000)}s`, e.reason)
    })
    if (e.agentId === undefined) {
      await refreshUsage($)
      void refreshGit($)
    }
    return next(e)
  })

  // The advisor's three moments, added to the system prompt when asked for.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (options.advisorRule !== true) return r
    return { sections: [...r.sections, { id: 'agent-dashboard:advisor', text: ADVISOR_RULE, scope: 'session' as const }] }
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.trigger !== 'precompute' && r.skip === undefined) {
      await change($, (d, now) => {
        const compaction = { at: now, before: r.tokensBefore ?? null, after: r.tokensAfter ?? null, trigger: e.trigger, isWorker: e.agentId !== undefined }
        const saved = compaction.before !== null && compaction.after !== null ? ` −${Math.round((compaction.before - compaction.after) / 1000)}k` : ''
        return logged({ ...d, compactions: [...d.compactions, compaction].slice(-20) }, now, laneOf(e.agentId), e.agentId === undefined ? 'main' : 'worker', `compacted (${e.trigger})${saved}`, 'context')
      })
    }
    return r
  }).catch(($, e, next) => next(e))

  // Workers: an Explore scout runs on the worker model (unless the call named one)
  // and is asked for a short report.
  on('agent.spawn', async ($, e, next) => {
    let ask = e
    if (e.subagentType === 'Explore') {
      const model = typeof options.workerModel === 'string' ? options.workerModel : 'haiku'
      if (model !== 'inherit' && e.model === undefined) ask = { ...ask, model }
      if (options.conciseWorkers !== false) ask = { ...ask, prompt: `${ask.prompt}\n\n${CONCISE_REPORT}` }
    }
    const r = await next(ask)
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
          promptChars: ask.prompt.length,
          reportChars: null,
        }
        const scouted = e.subagentType === 'Explore' ? withPhase(d, 'scout', now) : d
        const withAgent = { ...scouted, agents: [...scouted.agents, agent].slice(-MAX_AGENTS) }
        return logged(withAgent, now, 'worker', agent.type, oneLine(e.description, 40), 'spawned')
      })
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const isMain = e.agentId === undefined
    const input = e as unknown as Record<string, unknown>
    const what = describeCall(e.tool, e)
    const isBackground = input.run_in_background === true
    const command = e.tool === 'Bash' ? e.command : ''
    const isTest = command !== '' && !isBackground && TEST_RE.test(command)
    const startedAt = await $.clock.now().catch(() => 0)

    await change($, (d, now) => {
      const agent = agentOf(d, e.agentId)
      return { ...d, running: { tool: e.tool, who: whoOf(agent, e.agentId), since: now } }
    })

    const ran = await next(e)

    await change($, (d, now) => {
      const agent = agentOf(d, e.agentId)
      const lane = laneOf(e.agentId)
      const who = whoOf(agent, e.agentId)
      const isDenied = ran.deny !== undefined
      const isError = !isDenied && ran.isError === true
      const isRead = READ_TOOLS.has(e.tool)
      const isEdit = EDIT_TOOLS.has(e.tool)
      const ms = startedAt === 0 ? 0 : now - startedAt

      let out: Dash = { ...d, running: d.running !== null && d.running.tool === e.tool ? null : d.running }

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
          toolMix: { ...out.toolMix, [e.tool.startsWith('mcp__') ? 'mcp' : e.tool]: (out.toolMix[e.tool.startsWith('mcp__') ? 'mcp' : e.tool] ?? 0) + 1 },
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

      if (isEdit && !isError && !isDenied) {
        const fc = fileChangeOf(e.tool, input)
        if (fc !== undefined) {
          const was = out.files.find(f => f.path === fc.path)
          const next1: FileChange = was === undefined
            ? { ...fc, edits: 1, at: now }
            : { ...was, added: was.added + fc.added, removed: was.removed + fc.removed, edits: was.edits + 1, isWritten: was.isWritten || fc.isWritten, at: now }
          out = { ...out, files: [...out.files.filter(f => f.path !== fc.path), next1].slice(-MAX_FILES) }
        }
      }

      if (isTest && !isDenied) {
        out = { ...out, tests: [...out.tests, { at: now, isOk: !isError, ms, cmd: oneLine(command, 40) }].slice(-MAX_TESTS) }
      }

      if (!isDenied && !isBackground && !UNTIMED_TOOLS.has(e.tool) && ms > 0) {
        out = { ...out, toolMs: out.toolMs + ms, toolTimed: out.toolTimed + 1 }
      }

      // Test runs have their own card; the slow list is for everything else.
      if (!isDenied && !isBackground && !isTest && !UNTIMED_TOOLS.has(e.tool) && ms >= SLOW_MS) {
        out = { ...out, slow: [...out.slow, { what: describeCall(e.tool, e).replace(/^Bash /, ''), ms }].sort((a, b) => b.ms - a.ms).slice(0, 10) }
      }

      if (e.tool.startsWith('mcp__')) {
        const name = mcpName(e.tool)
        out = { ...out, mcp: { ...out.mcp, [name]: (out.mcp[name] ?? 0) + 1 } }
      }

      if (isError) {
        const text = oneLine(ran.text ?? '', 120)
        const isRepeat = text !== '' && text === out.lastError
        out = { ...out, lastError: text, repeatedErrors: out.repeatedErrors + (isRepeat ? 1 : 0) }
        out = { ...out, marks: [...out.marks, { at: now, lane: 'error' as Lane }].slice(-MAX_MARKS) }
        return logged(out, now, lane, who, what, isRepeat ? 'same error again' : isTest ? 'test failed' : 'error')
      }

      const tag = isDenied ? 'denied' : isTest ? 'test passed' : isEdit ? 'edit' : isRead ? 'read-only' : ''
      return logged(out, now, lane, who, what, tag)
    })

    return ran
  }).catch(($, e, next) => next(e))

  // ---- drawing ------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const d = normalize(await read($, dash))
    const now = await $.clock.now()
    // Dark retro screen by default; 'theme' keeps the surface's own pane colour.
    // A Box background is not painted on every surface, so the colour goes on each
    // line's text instead: every line is padded to the full width, and blank lines
    // fill the pane's height, so the whole body is covered.
    const bg = options.background !== 'theme' ? SCREEN_BG : undefined
    const ink = bg === undefined ? undefined : SCREEN_INK
    const width = Math.max(48, e.props.bodyColumns)
    // One column of margin on the left, two kept spare on the right.
    const rows = drawPane(d, now, width - 3).map(line => fit([seg(' '), ...line], width))
    while (bg !== undefined && rows.length < e.props.scroll.bodyRows) rows.push(fit([], width))

    return (
      <Box flexDirection="column" backgroundColor={bg}>
        {rows.map(line => (
          <Text wrap="truncate-end" color={ink} backgroundColor={bg}>
            {line.map(s => (
              <Text color={s.c ?? ink} backgroundColor={bg} bold={s.b} dimColor={s.d} inverse={s.inv}>{s.t}</Text>
            ))}
          </Text>
        ))}
      </Box>
    )
  })

  // The band is the summary for when the pane is closed; while it is open it would only repeat it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (options.band === false || e.props.hasSurvey) return next(e)
    const d = normalize(await read($, dash))
    if (d.isPaneOpen || (d.main.turns === 0 && d.agents.length === 0)) return next(e)

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
