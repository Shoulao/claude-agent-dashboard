import type { Dash, Lane } from '../types'

import { bar, beside, center, dim, fit, frame, len, runs, seg, spread } from './frame'
import type { Line, Seg } from './frame'

const STAGES = ['scout', 'plan', 'edit', 'test', 'fix', 'verify']

// Mid-tone hex colours so each reads on both dark and light backgrounds:
// main blue, subagents yellow, advisor red, errors magenta.
const C = {
  main: '#4f8cff',
  scout: '#d4a72c',
  agent: '#d4a72c',
  advisor: '#e5534b',
  error: '#c678dd',
  head: 'claude',
  now: 'claude',
} as const

const laneColor: Record<Lane, string> = {
  main: C.main,
  scout: C.scout,
  agent: C.agent,
  advisor: C.advisor,
  error: C.error,
}

export function short(model: string): string {
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model)
  if (m === null) return model.replace(/^claude-/, '')
  return m[3] === undefined ? `${m[1]} ${m[2]}` : `${m[1]} ${m[2]}.${m[3]}`
}

const family = (model: string) => (short(model).split(' ')[0] ?? '').toUpperCase()

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const pad = (text: string, n: number) => (text.length >= n ? text.slice(0, n) : text + ' '.repeat(n - text.length))

const stat = (name: string, value: number | string, color?: string): Line => [seg(pad(name, 12)), seg(String(value), color, { b: true })]

/** The bottom status line, also drawn as the band above the prompt. */
export function statusLine(d: Dash): Line {
  const running = d.agents.filter(a => a.endedAt === null)
  const scout = d.agents[d.agents.length - 1]
  const out: Line = [dim('stage '), seg(`[${d.phase}]`, C.head, { b: true })]
  out.push(seg(`  ${short(d.mainModel) || 'main'} `), seg(`[${d.isTurnRunning ? 'driving' : 'idle'}]`, C.main, { b: true }))
  out.push(seg(`  ${scout === undefined ? 'subagents' : scout.type} `), seg(`[${running.length > 0 ? `${running.length} running` : 'idle'}]`, C.scout, { b: true }))
  out.push(seg('  advisor '), seg(`[${d.advisor.length}]`, C.advisor, { b: true }))
  if (d.costUsd !== null) out.push(seg('  cost '), seg(`[$${d.costUsd.toFixed(2)}]`, undefined, { b: true }))
  return out
}

export function drawPane(d: Dash, now: number, paneCols: number): Line[] {
  // Snap the width to the card grid so every frame's right edge lines up.
  const cols = paneCols >= 78 ? 3 * Math.floor((paneCols - 2) / 3) + 2 : paneCols >= 56 ? 2 * Math.floor((paneCols - 1) / 2) + 1 : paneCols
  const startedAt = d.startedAt === 0 ? now : d.startedAt
  const clock = (at: number) => {
    const s = Math.max(0, Math.round((at - startedAt) / 1000))
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }
  const running = d.agents.filter(a => a.endedAt === null)
  const latest = d.agents[d.agents.length - 1]
  const mainName = short(d.mainModel) || 'main'
  const scoutModel = latest === undefined ? '' : short(latest.model)
  const cost = d.costUsd === null ? '$—' : `$${d.costUsd.toFixed(2)}`
  const active = d.running !== null
    ? `${d.running.who} → ${d.running.tool}`
    : running.length > 0
      ? `${running[running.length - 1]?.type ?? 'subagent'}`
      : d.isTurnRunning
        ? `${mainName} thinking`
        : 'idle'

  const out: Line[] = []

  // ---- masthead ----
  out.push(center([
    seg(`${family(d.mainModel) || 'MAIN'} `, C.main, { b: true }), seg('DRIVES', undefined, { b: true }), dim(' · '),
    seg(`${family(latest?.model ?? '') || 'SUBAGENTS'} `, C.scout, { b: true }), seg('SCOUT', undefined, { b: true }), seg(latest === undefined ? '' : 'S', undefined, { b: true }), dim(' · '),
    seg('ADVISOR ', C.advisor, { b: true }), seg('SIGNS OFF', undefined, { b: true }),
  ], cols))
  out.push([])
  out.push(center([
    seg('■', C.main), dim(d.mainModel === '' ? ' main session   ' : ` ${mainName} · main   `),
    seg('■', C.scout), dim(latest === undefined ? ' subagents   ' : ` ${scoutModel} · ${latest.type}   `),
    seg('■', C.advisor), dim(' advisor   '),
    seg('■', C.error), dim(' errors'),
  ], cols))
  out.push(center([seg('$ ', C.head, { b: true }), seg(`session ${clock(now)} · ${cost} · active: `), seg(active, active === 'idle' ? undefined : C.scout, { b: true, d: active === 'idle' })], cols))
  out.push([])

  // ---- stages ----
  const seen = new Set(d.phases.map(p => p.phase))
  const stages: Line = []
  STAGES.forEach((name, i) => {
    if (i > 0) stages.push(seg('  '))
    if (name === d.phase) stages.push(seg(` ▶ ${name} `, C.main, { inv: true, b: true }))
    else if (seen.has(name)) stages.push(seg(`✓ ${name}`, C.scout))
    else stages.push(dim(`${i + 1} ${name}`))
  })
  stages.push(seg('  '), seg(`${STAGES.length + 1} done`, undefined, { d: d.phase !== 'idle' || d.main.turns === 0, b: d.phase === 'idle' && d.main.turns > 0 }))
  out.push(center(stages, cols))
  out.push([])

  // ---- three cards ----
  // Every card has the same slots on the same rows: about (2), doing (1),
  // stats (4), recent (3), meter (1) and light (1), so they line up across.
  const layout = cols >= 78 ? 'row' : cols >= 56 ? 'split' : 'stack'
  const allTools = d.main.tools + d.agents.reduce((n, a) => n + a.tools, 0)
  const agentTools = d.agents.reduce((n, a) => n + a.tools, 0)
  const agentReads = d.agents.reduce((n, a) => n + a.reads, 0)
  const isScout = latest === undefined || latest.type === 'Explore'
  const agentColor = isScout ? C.scout : C.agent
  const lastCall = d.advisor[d.advisor.length - 1]
  const agentRunning = d.running !== null && d.running.who !== mainName ? d.running : null
  const pct = (n: number) => (allTools === 0 ? 0 : n / allTools)

  const mainCard: Card = {
    title: d.mainModel === ''
      ? [seg('MAIN SESSION', C.main, { b: true })]
      : [seg(mainName.toUpperCase(), C.main, { b: true }), seg(' · main', C.main)],
    color: C.main,
    isDouble: true,
    about: ['runs the session', 'edits the code'],
    doing: d.running !== null && d.running.who === mainName
      ? `running ${d.running.tool}`
      : d.isTurnRunning ? 'thinking' : 'waiting for you',
    stats: [
      ['edits', d.main.edits],
      ['tests', d.main.tests],
      ['errors', d.main.errors, d.main.errors > 0 ? C.error : undefined],
      ['turns', d.main.turns],
    ],
    recent: d.log.filter(l => l.lane === 'main').slice(-3).reverse().map((l, i): Line => [seg('› ', C.main), seg(l.what, undefined, { d: i > 0 })]),
    meter: pct(d.main.tools),
    meterLabel: `${Math.round(pct(d.main.tools) * 100)}% tools`,
    light: d.isTurnRunning ? '[/] driving' : '[ ] idle',
    isLit: d.isTurnRunning,
  }

  const agentCard: Card = {
    title: latest === undefined
      ? [seg('SUBAGENTS', agentColor, { b: true })]
      : [seg(scoutModel.toUpperCase(), agentColor, { b: true }), seg(` · ${latest.type}`, agentColor)],
    color: agentColor,
    about: isScout ? ['scouts repo + docs', 'read-only'] : ['own context window', latest?.type ?? ''],
    doing: agentRunning !== null
      ? `${agentRunning.who} → ${agentRunning.tool}`
      : running.length > 0 ? `${running[running.length - 1]?.type ?? 'subagent'} working` : 'waiting for main',
    stats: [
      ['files read', agentReads],
      ['tools', agentTools],
      ['running', running.length, running.length > 0 ? agentColor : undefined],
      ['done', d.agents.length - running.length],
    ],
    recent: d.agents.slice(-3).reverse().map((a): Line => a.endedAt === null
      ? [seg('▶ ', agentColor, { b: true }), seg(pad(a.type, 12), agentColor), dim(short(a.model))]
      : [dim('✓ '), dim(pad(a.type, 12)), dim(short(a.model))]),
    meter: pct(agentTools),
    meterLabel: `${Math.round(pct(agentTools) * 100)}% tools`,
    light: running.length > 0 ? (isScout ? '[/] scouting' : '[/] working') : '[ ] idle',
    isLit: running.length > 0,
  }

  const askNow = d.repeatedErrors > 0 && (lastCall === undefined || lastCall.at < (d.log.filter(l => l.tag === 'same error again').pop()?.at ?? 0))
  const advisorCard: Card = {
    title: [seg('ADVISOR', C.advisor, { b: true })],
    color: C.advisor,
    about: ['on call · reads the', 'whole session + tools'],
    doing: askNow ? 'same error again: ask' : lastCall !== undefined ? `advised at ${clock(lastCall.at)}` : 'waits',
    doingColor: askNow ? C.advisor : undefined,
    stats: [
      ['calls', d.advisor.length, d.advisor.length > 0 ? C.advisor : undefined],
      ['last call', lastCall === undefined ? '—' : clock(lastCall.at)],
      ['during', lastCall === undefined ? '—' : lastCall.phase],
      ['same error', d.repeatedErrors, d.repeatedErrors > 0 ? C.advisor : undefined],
    ],
    recent: d.advisor.slice(-3).reverse().map((a): Line => [seg('◆ ', C.advisor), seg(clock(a.at), C.advisor, { b: true }), dim(` ${a.phase}`)]),
    meter: Math.min(1, d.advisor.length / 3),
    meterLabel: `${d.advisor.length}/3 points`,
    light: d.advisor.length > 0 ? `[◆] advised ×${d.advisor.length}` : '[ ] waits',
    isLit: d.advisor.length > 0,
  }

  if (layout === 'row') {
    const w = Math.floor((cols - 2) / 3)
    out.push(...beside([
      drawCard(agentCard, w),
      drawCard(mainCard, w),
      drawCard(advisorCard, w),
    ], 1))
  } else if (layout === 'split') {
    const w = Math.floor((cols - 1) / 2)
    out.push(...drawCard(mainCard, cols))
    out.push(...beside([drawCard(agentCard, w), drawCard(advisorCard, w)], 1))
  } else {
    for (const card of [mainCard, agentCard, advisorCard]) out.push(...drawCard(card, cols))
  }
  out.push([])

  // ---- timeline ----
  const label = 9
  const tw = Math.max(10, cols - 4 - label)
  const elapsed = Math.max(1, now - startedAt)
  const horizon = Math.max(10 * 60_000, elapsed * 1.25)
  const colOf = (at: number) => Math.min(tw - 1, Math.max(0, Math.floor(((at - startedAt) / horizon) * tw)))
  const nowCol = colOf(now)
  const lanes: { lane: Lane; name: string }[] = [
    { lane: 'main', name: 'main' },
    { lane: 'scout', name: 'scouts' },
    { lane: 'agent', name: 'agents' },
    { lane: 'advisor', name: 'advisor' },
    { lane: 'error', name: 'errors' },
  ]
  const counts = new Map<Lane, number[]>(lanes.map(l => [l.lane, new Array<number>(tw).fill(0)]))
  for (const m of d.marks) {
    const row = counts.get(m.lane)
    if (row !== undefined) row[colOf(m.at)] = (row[colOf(m.at)] ?? 0) + 1
  }
  const glyph = (lane: Lane, n: number) => (lane === 'advisor' ? '◆' : lane === 'error' ? '✕' : n === 1 ? '▃' : n <= 3 ? '▅' : '▇')
  const tlBody: Line[] = lanes.map(l => {
    const row = counts.get(l.lane) ?? []
    const cells: Seg[] = row.map((n, col) => col === nowCol
      ? { t: n > 0 ? glyph(l.lane, n) : '│', c: n > 0 ? laneColor[l.lane] : C.now, b: true }
      : n === 0
        ? { t: '·', d: true }
        : { t: glyph(l.lane, n), c: laneColor[l.lane] })
    return [seg(pad(l.name, label), laneColor[l.lane]), ...runs(cells)]
  })
  // phase names under the lanes, where each phase began
  const phaseRow = new Array<string>(tw).fill(' ')
  const placed: { col: number; name: string }[] = []
  for (const p of d.phases) {
    const col = colOf(p.at)
    const end = col + p.phase.length
    if (end > tw || placed.some(q => col <= q.col + q.name.length && q.col <= end)) continue
    placed.push({ col, name: p.phase })
    for (let i = 0; i < p.phase.length; i++) phaseRow[col + i] = p.phase[i] ?? ' '
  }
  const current = placed.filter(q => q.name === d.phase).pop()
  const phaseCells: Seg[] = phaseRow.map((ch, col) => current !== undefined && col >= current.col && col < current.col + current.name.length
    ? { t: ch, c: C.main, b: true }
    : { t: ch, d: true })
  tlBody.push([seg(' '.repeat(label)), ...runs(phaseCells)])
  tlBody.push([seg('◆', C.advisor), dim(' advisor call   '), seg('✕', C.error), dim(' error   '), seg('│', C.now), dim(` now ${clock(now)}   `), dim(`axis ${Math.round(horizon / 60_000)}m`)])
  out.push(...frame({ title: [seg('session timeline', undefined, { b: true })], color: 'subtle', width: cols, body: tlBody }))
  out.push([])

  // ---- cost & tokens + recent advisor-ready summary ----
  const models = Object.entries(d.tokens)
    .map(([model, t]) => ({ model, total: t.input + t.output + t.cacheRead + t.cacheWrite, t }))
    .sort((a, b) => b.total - a.total)
  const maxTotal = Math.max(1, ...models.map(m => m.total))
  const agentModels = new Set(d.agents.map(a => a.model))
  const meter = Math.max(6, cols - 4 - 12 - 2 - 26)
  const costBody: Line[] = models.length === 0
    ? [[dim('no model calls yet')]]
    : models.map(({ model, total, t }) => {
      const color = model === d.mainModel ? C.main : agentModels.has(model) ? C.scout : C.agent
      return [
        seg(pad(short(model), 12), color, { b: true }),
        seg(`[${bar(total / maxTotal, meter)}]`, color),
        dim(` ${pad(k(total), 6)} in ${pad(k(t.input), 5)} out ${k(t.output)}`),
      ]
    })
  costBody.push([])
  costBody.push(spread([seg('session total '), seg(cost, undefined, { b: true })], [dim('as /cost totals it · cache counted in tok')], cols - 4))
  out.push(...frame({ title: [seg('cost · tokens', undefined, { b: true })], color: 'subtle', width: cols, body: costBody }))
  out.push([])

  // ---- tail -f ----
  const tagW = 16
  const whoW = 14
  const whatW = Math.max(8, cols - 4 - 6 - whoW - tagW - 1)
  const tailBody: Line[] = d.log.length === 0
    ? [[dim('waiting for the first event…')]]
    : d.log.slice(-10).map(line => [
      dim(`${clock(line.at)} `),
      seg(pad(line.who, whoW), laneColor[line.lane], { b: true }),
      seg(pad(line.what, whatW)),
      seg(' '),
      seg(pad(line.tag, tagW), line.tag === 'error' || line.tag === 'same error again' ? C.error : line.lane === 'advisor' ? C.advisor : undefined, { d: line.tag !== 'error' && line.tag !== 'same error again' && line.lane !== 'advisor' }),
    ])
  out.push(...frame({ title: [seg('tail -f session.log', undefined, { b: true })], color: 'subtle', width: cols, body: tailBody }))
  out.push([])

  // ---- prompt-style status ----
  out.push(fit([seg('  '), ...statusLine(d)], cols))
  out.push(fit([dim('  phase is inferred from tool calls · /dashboard reopens this pane')], cols))

  return out.map(line => (len(line) > cols ? fit(line, cols) : line))
}

type Card = {
  title: Line
  color: string
  isDouble?: boolean
  about: [string, string]
  doing: string
  doingColor?: string
  stats: [string, number | string, string?][]
  recent: Line[]
  meter: number
  meterLabel: string
  light: string
  isLit: boolean
}

const RECENT_ROWS = 3

function drawCard(card: Card, width: number): Line[] {
  const inner = Math.max(8, width - 4)
  const recent = card.recent.slice(0, RECENT_ROWS)
  while (recent.length < RECENT_ROWS) recent.push([dim('·')])
  const labelWidth = 11
  const meterWidth = Math.max(4, inner - 3 - labelWidth)
  const body: Line[] = [
    [dim(card.about[0])],
    [dim(card.about[1])],
    [],
    [seg('$ ', card.color, { b: true }), seg(card.doing, card.doingColor, { b: card.doingColor !== undefined }), seg(' _', card.color, { b: true })],
    [],
    ...card.stats.map(([name, value, color]) => stat(name, value, color)),
    [],
    ...recent,
    [],
    [seg(`[${bar(card.meter, meterWidth)}]`, card.color), dim(` ${card.meterLabel}`)],
    [seg(card.light, card.isLit ? card.color : undefined, { b: card.isLit, d: !card.isLit })],
  ]
  return frame({ title: card.title, color: card.color, width, body, isDouble: card.isDouble })
}
