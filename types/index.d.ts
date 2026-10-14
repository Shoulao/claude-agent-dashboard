export type Lane = 'main' | 'worker' | 'advisor' | 'error'

export type Counters = {
  turns: number
  tools: number
  reads: number
  edits: number
  bash: number
  tests: number
  errors: number
}

export type SubAgent = {
  id: string
  type: string
  model: string
  description: string
  startedAt: number
  endedAt: number | null
  tools: number
  reads: number
}

export type AdvisorCall = { at: number; phase: string; turn: number }

export type LogLine = { at: number; lane: Lane; who: string; what: string; tag: string }

export type Mark = { at: number; lane: Lane }

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type PhaseMark = { at: number; phase: string }

export type Running = { tool: string; who: string; since: number }

export type FileChange = { path: string; added: number; removed: number; edits: number; isWritten: boolean; at: number }

export type TestRun = { at: number; isOk: boolean; ms: number; cmd: string }

export type SlowCall = { what: string; ms: number }

export type Compaction = { at: number; before: number | null; after: number | null; trigger: string; isWorker: boolean }

export type RateLimit = { kind: string; percentUsed: number; resetsAt: string | null }

export type Context = { tokens: number | null; window: number; percent: number | null; compactAt: number | null }

export type Git = { isRepo: boolean; repo: string; branch: string; changed: number }

export type Dash = {
  startedAt: number
  mainModel: string
  advisorModel: string
  isTurnRunning: boolean
  isPaneOpen: boolean
  running: Running | null
  main: Counters
  toolMix: Record<string, number>
  agents: SubAgent[]
  advisor: AdvisorCall[]
  lastError: string
  repeatedErrors: number
  tokens: Record<string, Tokens>
  costUsd: number | null
  phase: string
  phases: PhaseMark[]
  marks: Mark[]
  log: LogLine[]
  context: Context | null
  limits: RateLimit[]
  files: FileChange[]
  tests: TestRun[]
  slow: SlowCall[]
  mcp: Record<string, number>
  compactions: Compaction[]
  git: Git | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-dashboard': { dash: Dash }
  }
}
