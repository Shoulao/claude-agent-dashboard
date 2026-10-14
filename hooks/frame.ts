// Text-drawn frames in the style of an old terminal: every border is a
// character, so the title sits inside the top rule (┌─┤ TITLE ├──┐).

export type Seg = { t: string; c?: string; b?: boolean; d?: boolean; inv?: boolean }
export type Line = Seg[]

export const seg = (t: string, c?: string, more: Omit<Seg, 't' | 'c'> = {}): Seg => ({ t, c, ...more })
export const dim = (t: string): Seg => ({ t, d: true })

export function len(line: Line): number {
  return line.reduce((n, s) => n + s.t.length, 0)
}

/** Cut the line to `width` columns, or pad it with spaces up to them. */
export function fit(line: Line, width: number): Line {
  const out: Line = []
  let room = width
  for (const s of line) {
    if (room <= 0) break
    const t = s.t.length > room ? s.t.slice(0, room) : s.t
    out.push({ ...s, t })
    room -= t.length
  }
  if (room > 0) out.push({ t: ' '.repeat(room) })
  return out
}

export function center(line: Line, width: number): Line {
  const left = Math.max(0, Math.floor((width - len(line)) / 2))
  return fit([{ t: ' '.repeat(left) }, ...line], width)
}

/** `left` then `right` pushed to the far end of `width`. */
export function spread(left: Line, right: Line, width: number): Line {
  const gap = width - len(left) - len(right)
  if (gap < 1) return fit([...left, { t: ' ' }, ...right], width)
  return [...left, { t: ' '.repeat(gap) }, ...right]
}

const SINGLE = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', open: '┤', close: '├' }
const DOUBLE = { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║', open: '╡', close: '╞' }

export type FrameArgs = {
  title: Line
  color: string
  width: number
  body: Line[]
  height?: number
  isDouble?: boolean
}

export function frame({ title, color, width, body, height, isDouble }: FrameArgs): Line[] {
  const k = isDouble === true ? DOUBLE : SINGLE
  const inner = Math.max(1, width - 4)
  const titleRoom = Math.max(0, width - 8)
  const shown = fit(title, Math.min(len(title), titleRoom))
  const fill = Math.max(0, width - 7 - len(shown))
  const rows = [...body]
  while (rows.length < (height ?? 0)) rows.push([])

  return [
    [seg(`${k.tl}${k.h}${k.open} `, color), ...shown, seg(` ${k.close}${k.h.repeat(fill)}${k.tr}`, color)],
    ...rows.map(row => [seg(`${k.v} `, color), ...fit(row, inner), seg(` ${k.v}`, color)]),
    [seg(`${k.bl}${k.h.repeat(Math.max(0, width - 2))}${k.br}`, color)],
  ]
}

/** Blocks of equal row width laid side by side, the shorter padded below. */
export function beside(blocks: Line[][], gap = 1): Line[] {
  const height = Math.max(...blocks.map(b => b.length))
  const out: Line[] = []
  for (let row = 0; row < height; row++) {
    const line: Line = []
    blocks.forEach((block, i) => {
      if (i > 0) line.push({ t: ' '.repeat(gap) })
      const width = len(block[0] ?? [])
      line.push(...fit(block[row] ?? [], width))
    })
    out.push(line)
  }
  return out
}

/** A meter: `share` (0..1) of `width` cells filled with ■, the rest ·. */
export function bar(share: number, width: number): string {
  const n = Math.max(0, Math.min(width, Math.round(share * width)))
  return '■'.repeat(n) + '·'.repeat(Math.max(0, width - n))
}

/** Runs of single-character cells, merged into segments of one style. */
export function runs(cells: Seg[]): Line {
  const out: Line = []
  for (const cell of cells) {
    const last = out[out.length - 1]
    if (last !== undefined && last.c === cell.c && last.d === cell.d && last.b === cell.b && last.inv === cell.inv) {
      out[out.length - 1] = { ...last, t: last.t + cell.t }
    } else {
      out.push({ ...cell })
    }
  }
  return out
}
