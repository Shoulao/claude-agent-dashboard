export type Lane = 'main' | 'scout' | 'agent' | 'advisor' | 'error'

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

export type AdvisorCall = { at: number; phase: string }

export type LogLine = { at: number; lane: Lane; who: string; what: string; tag: string }

export type Mark = { at: number; lane: Lane }

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Running = { tool: string; who: string; since: number }

export type Dash = {
  startedAt: number
  mainModel: string
  isTurnRunning: boolean
  running: Running | null
  main: Counters
  agents: SubAgent[]
  advisor: AdvisorCall[]
  lastError: string
  repeatedErrors: number
  tokens: Record<string, Tokens>
  costUsd: number | null
  phase: string
  marks: Mark[]
  log: LogLine[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-dashboard': { dash: Dash }
  }
}
