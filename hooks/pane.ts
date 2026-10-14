import type { Dash, Lane } from '../types'

import { bar, beside, center, dim, fit, frame, len, runs, seg } from './frame'
import type { Line, Seg } from './frame'

const STAGES = ['scout', 'plan', 'edit', 'test', 'fix', 'verify']

// Mid-tone hex colours so each reads on both dark and light backgrounds:
// main blue, worker yellow, advisor red, errors magenta, passing green.
const C = {
  main: '#4f8cff',
  worker: '#d4a72c',
  advisor: '#e5534b',
  error: '#c678dd',
  ok: '#5fb86b',
  head: 'claude',
  now: 'claude',
  frame: 'subtle',
} as const

const laneColor: Record<Lane, string> = {
  main: C.main,
  worker: C.worker,
  advisor: C.advisor,
  error: C.error,
}

export function short(model: string): string {
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model)
  if (m === null) return model.replace(/^claude-/, '')
  return m[3] === undefined ? `${m[1]} ${m[2]}` : `${m[1]} ${m[2]}.${m[3]}`
}

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const pad = (text: string, n: number) => (text.length >= n ? text.slice(0, n) : text + ' '.repeat(n - text.length))

const stat = (name: string, value: number | string, color?: string): Line => [seg(pad(name, 12)), seg(String(value), color, { b: true })]

const secs = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}` : `${Math.round(ms / 1000)}s`)

const EMPTY_ROW: Line = [dim('·')]

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function resetTime(iso: string | null, now: number): string {
  if (iso === null) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return at.getTime() - now < 20 * 3600_000 ? hm : `${WEEKDAYS[at.getDay()] ?? ''} ${hm}`
}

const LIMIT_NAMES: Record<string, string> = { five_hour: '5h window', seven_day: '7d window', spend_limit: 'spend' }

/** The summary drawn as the band above the prompt while the pane is closed. */
export function statusLine(d: Dash): Line {
  const running = d.agents.filter(a => a.endedAt === null)
  const out: Line = [dim('stage '), seg(`[${d.phase}]`, C.head, { b: true })]
  out.push(seg('  main '), seg(`[${d.isTurnRunning ? 'driving' : 'idle'}]`, C.main, { b: true }))
  out.push(seg('  worker '), seg(`[${running.length > 0 ? `${running.length} running` : 'idle'}]`, C.worker, { b: true }))
  out.push(seg('  advisor '), seg(`[${d.advisor.length}]`, C.advisor, { b: true }))
  if (d.costUsd !== null) out.push(seg('  cost '), seg(`[$${d.costUsd.toFixed(2)}]`, undefined, { b: true }))
  return out
}

// ---- cards ----------------------------------------------------------------

type Card = {
  title: Line
  color: string
  isDouble?: boolean
  about?: [string, string]
  doing: string
  doingColor?: string
  rows: Line[]
  rowCount: number
  meter: number
  meterLabel: string
  meterColor?: string
  light: string
  lightColor?: string
  isLit: boolean
}

/** Every card has the same slots on the same rows, so a row of cards lines up. */
function drawCard(card: Card, width: number): Line[] {
  const inner = Math.max(8, width - 4)
  const rows = card.rows.slice(0, card.rowCount)
  while (rows.length < card.rowCount) rows.push(EMPTY_ROW)
  const labelWidth = 11
  const meterWidth = Math.max(4, inner - 3 - labelWidth)
  const body: Line[] = [
    ...(card.about === undefined ? [] : [[dim(card.about[0])], [dim(card.about[1])], []]),
    [seg('$ ', card.color === C.frame ? C.head : card.color, { b: true }), seg(card.doing, card.doingColor, { b: card.doingColor !== undefined }), seg(' _', card.color === C.frame ? C.head : card.color, { b: true })],
    [],
    ...rows,
    [],
    [seg(`[${bar(card.meter, meterWidth)}]`, card.meterColor ?? (card.color === C.frame ? undefined : card.color)), dim(` ${card.meterLabel}`)],
    [seg(card.light, card.isLit ? (card.lightColor ?? card.color) : undefined, { b: card.isLit, d: !card.isLit })],
  ]
  return frame({ title: card.title, color: card.color, width, body, isDouble: card.isDouble })
}

function titled(name: string, model: string, color: string): Line {
  return model === ''
    ? [seg(name, color, { b: true })]
    : [seg(name, color, { b: true }), seg(` · ${short(model).toUpperCase()}`, color)]
}

/** Cards laid out on the grid: three across, two across, or stacked. */
function grid(cards: Card[], cols: number, layout: 'row' | 'split' | 'stack'): Line[] {
  if (layout === 'row') {
    const w = Math.floor((cols - 2) / 3)
    return beside(cards.map(c => drawCard(c, w)), 1)
  }
  if (layout === 'split') {
    // The middle card (main, in the first row) takes the full width; the other two share a row.
    const w = Math.floor((cols - 1) / 2)
    const [left, middle, right] = cards as [Card, Card, Card]
    return [...drawCard(middle, cols), ...beside([drawCard(left, w), drawCard(right, w)], 1)]
  }
  return cards.flatMap(c => drawCard(c, cols))
}

// ---- the pane -------------------------------------------------------------

export function drawPane(d: Dash, now: number, paneCols: number): Line[] {
  // Snap the width to the card grid so every frame's right edge lines up.
  const cols = paneCols >= 78 ? 3 * Math.floor((paneCols - 2) / 3) + 2 : paneCols >= 56 ? 2 * Math.floor((paneCols - 1) / 2) + 1 : paneCols
  const layout = cols >= 78 ? 'row' : cols >= 56 ? 'split' : 'stack'
  const startedAt = d.startedAt === 0 ? now : d.startedAt
  const clock = (at: number) => {
    const s = Math.max(0, Math.round((at - startedAt) / 1000))
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }
  const out: Line[] = []

  // ---- masthead: the roles, the repo, the stages ----
  out.push(center([
    seg('MAIN ', C.main, { b: true }), seg('DRIVES', undefined, { b: true }), dim(' · '),
    seg('WORKER ', C.worker, { b: true }), seg('SCOUTS', undefined, { b: true }), dim(' · '),
    seg('ADVISOR ', C.advisor, { b: true }), seg('SIGNS OFF', undefined, { b: true }),
  ], cols))
  out.push([])
  const git = d.git
  const where: Line = git === null
    ? [seg('session')]
    : git.isRepo
      ? [seg(git.repo, undefined, { b: true }), dim(' on '), seg(git.branch, undefined, { b: true }), dim(' · '), seg(`${git.changed} changed`, git.changed > 0 ? C.worker : undefined)]
      : [seg(git.repo || 'session'), dim(' · no git repo')]
  out.push(center([seg('$ ', C.head, { b: true }), ...where, dim(' · '), seg(clock(now))], cols))
  out.push([])

  const seen = new Set(d.phases.map(p => p.phase))
  const stages: Line = []
  STAGES.forEach((name, i) => {
    if (i > 0) stages.push(seg('  '))
    if (name === d.phase) stages.push(seg(` ▶ ${name} `, C.main, { inv: true, b: true }))
    else if (seen.has(name)) stages.push(seg(`✓ ${name}`, C.ok))
    else stages.push(dim(`${i + 1} ${name}`))
  })
  stages.push(seg('  '), seg(`${STAGES.length + 1} done`, undefined, { d: d.phase !== 'idle' || d.main.turns === 0, b: d.phase === 'idle' && d.main.turns > 0 }))
  out.push(center(stages, cols))
  out.push([])

  // ---- row 1: who is working ----
  const running = d.agents.filter(a => a.endedAt === null)
  const latest = running[running.length - 1] ?? d.agents[d.agents.length - 1]
  const workerModel = latest?.model ?? ''
  const agentTools = d.agents.reduce((n, a) => n + a.tools, 0)
  const agentReads = d.agents.reduce((n, a) => n + a.reads, 0)
  const allTools = d.main.tools + agentTools
  const share = (n: number) => (allTools === 0 ? 0 : n / allTools)
  const lastCall = d.advisor[d.advisor.length - 1]
  const lastRepeatAt = d.log.filter(l => l.tag === 'same error again').pop()?.at ?? 0
  const askNow = d.repeatedErrors > 0 && (lastCall === undefined || lastCall.at < lastRepeatAt)

  const mix = Object.entries(d.toolMix).sort((a, b) => b[1] - a[1]).slice(0, 3)
  const mainCard: Card = {
    title: titled('MAIN', d.mainModel, C.main),
    color: C.main,
    isDouble: true,
    about: ['runs the session', 'edits the code'],
    doing: d.running !== null && d.running.who === 'main'
      ? `running ${d.running.tool}`
      : d.isTurnRunning ? 'thinking' : 'waiting for you',
    rows: [
      stat('edits', d.main.edits),
      stat('reads', d.main.reads),
      stat('errors', d.main.errors, d.main.errors > 0 ? C.error : undefined),
      stat('turns', d.main.turns),
      [],
      ...mix.map(([tool, n]): Line => [seg(pad(tool, 12), C.main), dim(`×${n}`)]),
    ],
    rowCount: 8,
    meter: share(d.main.tools),
    meterLabel: `${Math.round(share(d.main.tools) * 100)}% tools`,
    light: d.isTurnRunning ? '[/] driving' : '[ ] idle',
    isLit: d.isTurnRunning,
  }

  const workerRunning = d.running !== null && d.running.who !== 'main' ? d.running : null
  const workerCard: Card = {
    title: titled('WORKER', workerModel, C.worker),
    color: C.worker,
    about: ['scouts and helps', 'in its own context'],
    doing: workerRunning !== null
      ? `${workerRunning.who} → ${workerRunning.tool}`
      : running.length > 0 ? `${running[running.length - 1]?.type ?? 'worker'} working` : 'waiting for main',
    rows: [
      stat('files read', agentReads),
      stat('tools', agentTools),
      stat('running', running.length, running.length > 0 ? C.worker : undefined),
      stat('done', d.agents.length - running.length),
      [],
      ...d.agents.slice(-3).reverse().map((a): Line => {
        const took = (a.endedAt ?? now) - a.startedAt
        const other = a.model !== workerModel ? ` ${short(a.model).split(' ')[0] ?? ''}` : ''
        return a.endedAt === null
          ? [seg('▶ ', C.worker, { b: true }), seg(pad(a.type, 10), C.worker), dim(`${a.tools}t ${secs(took)}${other}`)]
          : [dim('✓ '), dim(pad(a.type, 10)), dim(`${a.tools}t ${secs(took)}${other}`)]
      }),
    ],
    rowCount: 8,
    meter: share(agentTools),
    meterLabel: `${Math.round(share(agentTools) * 100)}% tools`,
    light: running.length > 0 ? '[/] working' : '[ ] idle',
    isLit: running.length > 0,
  }

  const advisorCard: Card = {
    title: titled('ADVISOR', d.advisorModel, C.advisor),
    color: C.advisor,
    about: ['on call · reads the', 'whole session + tools'],
    doing: askNow ? 'same error again: ask' : lastCall !== undefined ? 'signed off' : 'waits',
    doingColor: askNow ? C.advisor : undefined,
    rows: [
      stat('calls', d.advisor.length, d.advisor.length > 0 ? C.advisor : undefined),
      stat('since call', lastCall === undefined ? '—' : secs(now - lastCall.at)),
      stat('turns since', lastCall === undefined ? '—' : Math.max(0, d.main.turns - lastCall.turn)),
      stat('same error', d.repeatedErrors, d.repeatedErrors > 0 ? C.advisor : undefined),
      [],
      ...d.advisor.slice(-3).reverse().map((a): Line => [seg('◆ ', C.advisor), seg(`turn ${a.turn}`, C.advisor, { b: true }), dim(` · ${a.phase}`)]),
    ],
    rowCount: 8,
    meter: Math.min(1, d.advisor.length / 3),
    meterLabel: `${d.advisor.length}/3 points`,
    light: d.advisor.length > 0 ? `[◆] advised ×${d.advisor.length}` : '[ ] waits',
    isLit: d.advisor.length > 0,
  }

  out.push(...grid([workerCard, mainCard, advisorCard], cols, layout))
  out.push([])

  // ---- row 2: what the work did ----
  const ctx = d.context
  const nearCompact = ctx !== null && ctx.tokens !== null && ctx.compactAt !== null && ctx.tokens >= ctx.compactAt * 0.9
  const lastCompact = d.compactions[d.compactions.length - 1]
  const contextCard: Card = {
    title: [seg('CONTEXT', undefined, { b: true })],
    color: C.frame,
    doing: ctx === null || ctx.tokens === null ? 'not measured yet' : `${k(ctx.tokens)} of ${k(ctx.window)}`,
    rows: ctx === null ? [] : [
      stat('used', ctx.tokens === null ? '—' : k(ctx.tokens)),
      stat('window', k(ctx.window)),
      stat('compacts at', ctx.compactAt === null ? 'off' : k(ctx.compactAt)),
      stat('compactions', d.compactions.length),
      stat('last', lastCompact === undefined ? '—' : `${clock(lastCompact.at)}${lastCompact.before !== null && lastCompact.after !== null ? ` −${k(lastCompact.before - lastCompact.after)}` : ''}`),
    ],
    rowCount: 5,
    meter: (ctx?.percent ?? 0) / 100,
    meterLabel: `${Math.round(ctx?.percent ?? 0)}% full`,
    meterColor: nearCompact ? C.error : undefined,
    light: nearCompact ? '[!] compact soon' : '[ ] room left',
    lightColor: C.error,
    isLit: nearCompact,
  }

  const added = d.files.reduce((n, f) => n + f.added, 0)
  const removed = d.files.reduce((n, f) => n + f.removed, 0)
  const lastFile = d.files[d.files.length - 1]
  const filesCard: Card = {
    title: [seg('FILES', undefined, { b: true })],
    color: C.frame,
    doing: lastFile === undefined ? 'no edits yet' : `edited ${lastFile.path.split('/').pop() ?? ''}`,
    rows: d.files.slice(-5).reverse().map((f): Line => [
      seg(pad(`+${f.added}`, 5), C.ok),
      seg(pad(f.isWritten ? 'new' : `−${f.removed}`, 5), f.isWritten ? undefined : C.error, { d: f.isWritten }),
      seg(f.path.split('/').slice(-2).join('/')),
    ]),
    rowCount: 5,
    meter: added + removed === 0 ? 0 : added / (added + removed),
    meterLabel: `+${added} −${removed}`,
    meterColor: C.ok,
    light: d.files.length > 0 ? `[/] ${d.files.length} file${d.files.length === 1 ? '' : 's'}` : '[ ] no edits',
    lightColor: C.ok,
    isLit: d.files.length > 0,
  }

  const passed = d.tests.filter(t => t.isOk).length
  const failed = d.tests.length - passed
  const lastTest = d.tests[d.tests.length - 1]
  const lastGreen = [...d.tests].reverse().find(t => t.isOk)
  const slowestTest = d.tests.reduce((m, t) => Math.max(m, t.ms), 0)
  const testsCard: Card = {
    title: [seg('TESTS', undefined, { b: true })],
    color: C.frame,
    doing: lastTest === undefined ? 'not run yet' : lastTest.cmd,
    rows: [
      stat('passed', passed, passed > 0 ? C.ok : undefined),
      stat('failed', failed, failed > 0 ? C.error : undefined),
      [seg(pad('streak', 12)), ...(d.tests.length === 0 ? [dim('—')] : d.tests.slice(-8).map(t => seg(t.isOk ? '✓' : '✗', t.isOk ? C.ok : C.error, { b: true })))],
      stat('last green', lastGreen === undefined ? '—' : clock(lastGreen.at)),
      stat('slowest', slowestTest === 0 ? '—' : secs(slowestTest)),
    ],
    rowCount: 5,
    meter: d.tests.length === 0 ? 0 : passed / d.tests.length,
    meterLabel: `${d.tests.length === 0 ? 0 : Math.round((passed / d.tests.length) * 100)}% pass`,
    meterColor: C.ok,
    light: lastTest === undefined ? '[ ] not run' : lastTest.isOk ? '[✓] green' : '[✗] red',
    lightColor: lastTest?.isOk === false ? C.error : C.ok,
    isLit: lastTest !== undefined,
  }

  out.push(...grid([contextCard, filesCard, testsCard], cols, layout))
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
    { lane: 'worker', name: 'worker' },
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
  tlBody.push([seg('◆', C.advisor), dim(' advisor call   '), seg('✕', C.error), dim(' error   '), seg('│', C.now), dim(' now   '), dim(`axis ${Math.round(horizon / 60_000)}m`)])
  out.push(...frame({ title: [seg('session timeline', undefined, { b: true })], color: C.frame, width: cols, body: tlBody }))
  out.push([])

  // ---- row 3: what it cost and where time went ----
  const models = Object.entries(d.tokens)
    .map(([model, t]) => ({ model, total: t.input + t.output + t.cacheRead + t.cacheWrite }))
    .sort((a, b) => b.total - a.total)
  const tok = Object.values(d.tokens).reduce((s, t) => ({ input: s.input + t.input, cacheRead: s.cacheRead + t.cacheRead, cacheWrite: s.cacheWrite + t.cacheWrite }), { input: 0, cacheRead: 0, cacheWrite: 0 })
  const promptTokens = tok.input + tok.cacheRead + tok.cacheWrite
  const cacheHit = promptTokens === 0 ? 0 : tok.cacheRead / promptTokens
  const workerModels = new Set(d.agents.map(a => a.model))
  const costCard: Card = {
    title: [seg('COST', undefined, { b: true })],
    color: C.frame,
    doing: d.costUsd === null ? 'no ledger' : `$${d.costUsd.toFixed(2)} so far`,
    rows: [
      ...models.slice(0, 3).map(({ model, total }): Line => [seg(pad(short(model), 12), model === d.mainModel ? C.main : workerModels.has(model) ? C.worker : undefined), seg(`${k(total)} tok`, undefined, { b: true })]),
      ...new Array<Line>(Math.max(0, 3 - Math.min(3, models.length))).fill(EMPTY_ROW),
      stat('cache read', k(tok.cacheRead)),
      stat('cache write', k(tok.cacheWrite)),
    ],
    rowCount: 5,
    meter: cacheHit,
    meterLabel: `${Math.round(cacheHit * 100)}% cached`,
    meterColor: C.ok,
    light: promptTokens === 0 ? '[ ] no calls yet' : cacheHit >= 0.5 ? '[/] cache warm' : '[ ] cache cold',
    lightColor: C.ok,
    isLit: promptTokens > 0 && cacheHit >= 0.5,
  }

  const maxUsed = d.limits.reduce((m, l) => Math.max(m, l.percentUsed), 0)
  const soonest = d.limits.filter(l => l.resetsAt !== null).sort((a, b) => b.percentUsed - a.percentUsed)[0]
  const limitsCard: Card = {
    title: [seg('LIMITS', undefined, { b: true })],
    color: C.frame,
    doing: d.limits.length === 0 ? 'none reported' : soonest === undefined ? 'plan windows' : `resets ${resetTime(soonest.resetsAt, now)}`,
    rows: d.limits.slice(0, 5).map((l): Line => [
      seg(pad(LIMIT_NAMES[l.kind] ?? l.kind, 12)),
      seg(pad(`${Math.round(l.percentUsed)}%`, 5), l.percentUsed >= 80 ? C.error : undefined, { b: true }),
      dim(resetTime(l.resetsAt, now)),
    ]),
    rowCount: 5,
    meter: Math.min(1, maxUsed / 100),
    meterLabel: `${Math.round(maxUsed)}% used`,
    meterColor: maxUsed >= 80 ? C.error : undefined,
    light: d.limits.length === 0 ? '[ ] no data' : maxUsed >= 80 ? '[!] near limit' : '[ ] ok',
    lightColor: C.error,
    isLit: maxUsed >= 80,
  }

  const mcp = Object.entries(d.mcp).sort((a, b) => b[1] - a[1])
  const mcpCalls = mcp.reduce((n, [, c]) => n + c, 0)
  const toolsCard: Card = {
    title: [seg('TOOLS', undefined, { b: true })],
    color: C.frame,
    doing: `${allTools} calls`,
    rows: [
      ...d.slow.slice(0, 3).map((s): Line => [seg(pad(secs(s.ms), 6), C.error, { b: true }), seg(s.what)]),
      ...new Array<Line>(Math.max(0, 3 - Math.min(3, d.slow.length))).fill(EMPTY_ROW),
      ...mcp.slice(0, 2).map(([name, n]): Line => [dim('mcp '), seg(pad(name, 12)), dim(`×${n}`)]),
    ],
    rowCount: 5,
    meter: allTools === 0 ? 0 : mcpCalls / allTools,
    meterLabel: `${allTools === 0 ? 0 : Math.round((mcpCalls / allTools) * 100)}% mcp`,
    light: d.slow.length > 0 ? `[!] ${d.slow.length} slow >10s` : '[ ] nothing slow',
    lightColor: C.error,
    isLit: d.slow.length > 0,
  }

  out.push(...grid([costCard, limitsCard, toolsCard], cols, layout))
  out.push([])

  // ---- tail -f ----
  const tagW = 14
  const whoW = 12
  const whatW = Math.max(8, cols - 4 - 6 - whoW - tagW - 1)
  const tailBody: Line[] = d.log.length === 0
    ? [[dim('waiting for the first event…')]]
    : d.log.slice(-8).map(line => {
      const isBad = line.tag === 'error' || line.tag === 'same error again' || line.tag === 'test failed'
      return [
        dim(`${clock(line.at)} `),
        seg(pad(line.who, whoW), laneColor[line.lane], { b: true }),
        seg(pad(line.what, whatW)),
        seg(' '),
        seg(pad(line.tag, tagW), isBad ? C.error : line.tag === 'test passed' ? C.ok : line.lane === 'advisor' ? C.advisor : undefined, { d: !isBad && line.tag !== 'test passed' && line.lane !== 'advisor' }),
      ]
    })
  out.push(...frame({ title: [seg('tail -f session.log', undefined, { b: true })], color: C.frame, width: cols, body: tailBody }))
  out.push(fit([dim('  phase is inferred from tool calls · /dashboard reopens this pane')], cols))

  return out.map(line => (len(line) > cols ? fit(line, cols) : line))
}
