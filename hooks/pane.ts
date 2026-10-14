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

const stat = (name: string, value: number | string, color?: string): Line => [seg(pad(name, 14)), seg(String(value), color, { b: true })]

const light = (isOn: boolean, on: string, off: string, color: string): Line => (isOn ? [seg(`[/] ${on}`, color, { b: true })] : [dim(`[ ] ${off}`)])

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

export function drawPane(d: Dash, now: number, cols: number): Line[] {
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
    seg('■', C.main), dim(` ${mainName} · main   `),
    seg('■', C.scout), dim(` ${scoutModel || 'subagents'} · ${latest?.type ?? 'Explore'}   `),
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
  // three across when there is room; else main on top and two beside it
  const layout = cols >= 78 ? 'row' : cols >= 56 ? 'split' : 'stack'
  const w = layout === 'row' ? Math.floor((cols - 2) / 3) : layout === 'split' ? Math.floor((cols - 1) / 2) : cols
  const inner = w - 4
  const mainInner = layout === 'split' ? w * 2 - 3 : inner
  const allTools = d.main.tools + d.agents.reduce((n, a) => n + a.tools, 0)
  const mainShare = allTools === 0 ? 0 : d.main.tools / allTools

  const doing = d.running !== null && d.running.who === mainName
    ? `running ${d.running.tool}`
    : d.isTurnRunning ? 'thinking' : 'waiting for you'
  const mainBody: Line[] = [
    dim2('runs the session'),
    dim2('edits the code'),
    [],
    [seg('$ ', C.main, { b: true }), seg(doing), seg(' _', C.main, { b: true })],
    [],
    stat('edits', d.main.edits),
    stat('errors', d.main.errors, d.main.errors > 0 ? C.error : undefined),
    stat('tests', d.main.tests),
    stat('reads', d.main.reads),
    stat('turns', d.main.turns),
    [],
    [seg(`[${bar(mainShare, Math.max(4, mainInner - 2))}]`, C.main)],
    center(light(d.isTurnRunning, 'driving', 'idle', C.main), mainInner),
  ]

  const agentReads = d.agents.reduce((n, a) => n + a.reads, 0)
  const agentTools = d.agents.reduce((n, a) => n + a.tools, 0)
  const isScout = latest === undefined || latest.type === 'Explore'
  const agentColor = isScout ? C.scout : C.agent
  const agentBody: Line[] = [
    dim2(isScout ? 'scouts repo + docs' : 'own context window'),
    dim2(isScout ? 'read-only' : `${latest?.type ?? ''}`),
    [],
    stat('files read', agentReads),
    stat('tools', agentTools),
    stat('running', running.length, running.length > 0 ? agentColor : undefined),
    stat('total', d.agents.length),
    [],
    ...(d.agents.length === 0
      ? [[dim('[ ] none yet')]]
      : d.agents.slice(-3).reverse().map((a): Line => a.endedAt === null
        ? [seg('▶ ', agentColor, { b: true }), seg(pad(a.type, 12), agentColor), dim(short(a.model))]
        : [dim('✓ '), dim(pad(a.type, 12)), dim(short(a.model))])),
    [],
    center(light(running.length > 0, isScout ? 'scouting' : 'working', 'idle', agentColor), inner),
  ]

  const advisorBody: Line[] = [
    dim2('on call · reads the'),
    dim2('whole session + tools'),
    [],
    ...(d.advisor.length === 0
      ? [[dim('◇ no calls yet')]]
      : d.advisor.slice(-3).reverse().map((a): Line => [seg('◆ ', C.advisor), seg(clock(a.at), C.advisor, { b: true }), dim(` during ${a.phase}`)])),
    [],
    d.repeatedErrors > 0
      ? [seg('◆ ', C.error), seg(`same error again ×${d.repeatedErrors}`, C.error, { b: true })]
      : [dim('◇ same error again')],
    d.repeatedErrors > 0 ? [seg('  → time to ask', C.advisor)] : [],
    [],
    stat('advisor calls', d.advisor.length, C.advisor),
    [dim(pad('otherwise', 14)), dim('waits')],
  ]

  const mainTitle: Line = [seg(`${mainName.toUpperCase()}`, C.main, { b: true }), seg(' · main', C.main)]
  const agentTitle: Line = latest === undefined
    ? [seg('SUBAGENTS', agentColor, { b: true })]
    : [seg(scoutModel.toUpperCase(), agentColor, { b: true }), seg(` · ${latest.type}`, agentColor)]
  const advisorTitle: Line = [seg('ADVISOR', C.advisor, { b: true }), seg(d.advisor.length > 0 ? ' · on call' : '', C.advisor)]

  if (layout === 'row') {
    const height = Math.max(mainBody.length, agentBody.length, advisorBody.length)
    out.push(...beside([
      frame({ title: agentTitle, color: agentColor, width: w, body: agentBody, height }),
      frame({ title: mainTitle, color: C.main, width: w, body: mainBody, height, isDouble: true }),
      frame({ title: advisorTitle, color: C.advisor, width: w, body: advisorBody, height }),
    ], 1))
  } else {
    const height = layout === 'split' ? Math.max(agentBody.length, advisorBody.length) : undefined
    out.push(...frame({ title: mainTitle, color: C.main, width: layout === 'split' ? w * 2 + 1 : w, body: mainBody, isDouble: true }))
    const pair = [
      frame({ title: agentTitle, color: agentColor, width: w, body: agentBody, height }),
      frame({ title: advisorTitle, color: C.advisor, width: w, body: advisorBody, height }),
    ]
    if (layout === 'split') out.push(...beside(pair, 1))
    else for (const card of pair) out.push(...card)
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
  out.push(fit(statusLine(d), cols))
  out.push(fit([dim('phase is inferred from tool calls · /dashboard reopens this pane')], cols))

  return out.map(line => (len(line) > cols ? fit(line, cols) : line))
}

function dim2(text: string): Line {
  return [dim(text)]
}
