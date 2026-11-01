export type MetricsSource = "measured" | "estimate"

export type SparkFrame = {
  values: number[]
  stepMs: number
  at: number
  windowMs: number
}

export type TurnView = {
  active: boolean
  tps: number | null
  liveTps: number
  ttftMs: number | null
  tokens: number
  outputTokens: number
  reasoningTokens: number
  source: MetricsSource
  chars: number
}

export type LastTurn = {
  tps: number
  ttftMs: number | null
  tokens: number
  outputTokens: number
  reasoningTokens: number
  source: MetricsSource
  activeMs: number
  endedAt: number
}

export type MetricsView = {
  turn: TurnView | null
  last: LastTurn | null
  spark: SparkFrame
}

type Sample = { at: number; chars: number }

type TurnState = {
  execAt: number
  stepStart: number | null
  firstCharAt: number | null
  firstTtftMs: number | null
  lastCharAt: number | null
  activeMs: number
  stepChars: number
  stepReasoningChars: number
  settledChars: number
  settledReasoningChars: number
  totalChars: number
  totalReasoningChars: number
  measuredOutput: number
  measuredReasoning: number
  measuredSteps: number
  model: string
}

type SessionState = {
  turn: TurnState | null
  last: LastTurn | null
  samples: Sample[]
  model: string
}

type RawEvent = {
  type: string
  created: number
  data: any
}

const WINDOW_MS = 1_000
const CURVE_MS = 30_000
const MAX_CURVE_MS = 15 * 60_000
const CURVE_BUCKETS = 24
const MAX_STREAM_GAP_MS = 1_000
const CALIBRATION_WEIGHT = 0.3
const MIN_CALIBRATION_FACTOR = 0.25
const MAX_CALIBRATION_FACTOR = 4
const MAX_PLAUSIBLE_TPS = 5_000
const SAMPLE_LIMIT = 120_000

export class Metrics {
  private sessions = new Map<string, SessionState>()
  private calibration = new Map<string, number>()

  onEvent(event: RawEvent): void {
    const data = event.data ?? {}
    const sessionID = String(data.sessionID ?? data.form?.sessionID ?? "")
    if (!sessionID) return
    const state = this.state(sessionID)

    switch (event.type) {
      case "session.execution.started": {
        if (state.turn) this.finalize(state, event.created)
        state.turn = this.newTurn(event.created, state.model)
        return
      }
      case "session.step.started": {
        const turn = this.ensureTurn(state, event.created)
        turn.model = String(data.model?.id ?? turn.model)
        state.model = turn.model
        turn.stepStart = Number(data.started ?? event.created)
        turn.stepChars = 0
        turn.stepReasoningChars = 0
        return
      }
      case "session.text.started":
      case "session.reasoning.started":
      case "session.tool.input.started": {
        this.markFirst(state, event.created)
        return
      }
      case "session.text.delta":
      case "session.reasoning.delta": {
        const delta = String(data.delta ?? "")
        if (!delta) return
        this.recordChars(state, event.created, delta.length, event.type.includes("reasoning"))
        return
      }
      case "session.step.ended":
      case "session.step.failed": {
        const turn = state.turn
        if (!turn) return
        const tokens = data.tokens
        if (tokens) {
          const output = Number(tokens.output ?? 0)
          const reasoning = Number(tokens.reasoning ?? 0)
          turn.measuredOutput += output
          turn.measuredReasoning += reasoning
          turn.measuredSteps += 1
          this.calibrate(turn.model, turn.stepChars, output + reasoning)
          turn.settledChars += turn.stepChars
          turn.settledReasoningChars += turn.stepReasoningChars
          turn.stepChars = 0
          turn.stepReasoningChars = 0
        }
        return
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
      case "session.idle": {
        this.finalize(state, event.created)
        return
      }
      default:
        return
    }
  }

  read(sessionID: string, now = Date.now(), sparkMs = CURVE_MS, sparkBuckets = CURVE_BUCKETS): MetricsView {
    const state = this.state(sessionID)
    const windowMs = Math.max(CURVE_MS, Math.min(MAX_CURVE_MS, sparkMs))
    const buckets = Math.max(1, Math.min(120, Math.floor(sparkBuckets)))
    this.prune(state, now)
    const spark = this.curve(state, now, windowMs, buckets)
    const turn = state.turn
    if (!turn) return { turn: null, last: state.last, spark }

    const openChars = Math.max(0, turn.totalChars - turn.settledChars)
    const openReasoningChars = Math.max(0, turn.totalReasoningChars - turn.settledReasoningChars)
    const estimated = this.estimate(openChars, turn.model)
    const estimatedReasoning = Math.min(estimated, this.estimate(openReasoningChars, turn.model))
    const outputTokens = turn.measuredOutput + Math.max(0, estimated - estimatedReasoning)
    const reasoningTokens = turn.measuredReasoning + estimatedReasoning
    const tokens = outputTokens + reasoningTokens
    const activeMs = this.activeMs(turn, now)
    const tps = rate(tokens, activeMs)

    return {
      turn: {
        active: true,
        tps,
        liveTps: this.live(state, now),
        ttftMs: turn.firstTtftMs ?? (turn.firstCharAt !== null ? turn.firstCharAt - turn.execAt : null),
        tokens,
        outputTokens,
        reasoningTokens,
        source: turn.measuredSteps > 0 ? "measured" : "estimate",
        chars: turn.totalChars,
      },
      last: state.last,
      spark,
    }
  }

  private state(sessionID: string): SessionState {
    let state = this.sessions.get(sessionID)
    if (!state) {
      state = { turn: null, last: null, samples: [], model: "*" }
      this.sessions.set(sessionID, state)
    }
    return state
  }

  private newTurn(execAt: number, model: string): TurnState {
    return {
      execAt,
      stepStart: null,
      firstCharAt: null,
      firstTtftMs: null,
      lastCharAt: null,
      activeMs: 0,
      stepChars: 0,
      stepReasoningChars: 0,
      settledChars: 0,
      settledReasoningChars: 0,
      totalChars: 0,
      totalReasoningChars: 0,
      measuredOutput: 0,
      measuredReasoning: 0,
      measuredSteps: 0,
      model,
    }
  }

  private ensureTurn(state: SessionState, at: number): TurnState {
    if (!state.turn) state.turn = this.newTurn(at, state.model)
    return state.turn
  }

  private markFirst(state: SessionState, at: number) {
    const turn = this.ensureTurn(state, at)
    if (turn.firstCharAt !== null) return
    turn.firstCharAt = at
    turn.firstTtftMs = Math.max(0, at - (turn.stepStart ?? turn.execAt))
  }

  private recordChars(state: SessionState, at: number, chars: number, reasoning: boolean) {
    if (chars <= 0) return
    const turn = this.ensureTurn(state, at)
    this.markFirst(state, at)
    if (turn.lastCharAt !== null) {
      const gap = at - turn.lastCharAt
      if (gap > 0 && gap <= MAX_STREAM_GAP_MS) turn.activeMs += gap
    }
    turn.lastCharAt = at
    turn.stepChars += chars
    turn.totalChars += chars
    if (reasoning) {
      turn.stepReasoningChars += chars
      turn.totalReasoningChars += chars
    }
    state.samples.push({ at, chars })
    if (state.samples.length > SAMPLE_LIMIT) state.samples.splice(0, state.samples.length - SAMPLE_LIMIT)
  }

  private finalize(state: SessionState, at: number) {
    const turn = state.turn
    if (!turn) return
    const openChars = Math.max(0, turn.totalChars - turn.settledChars)
    const openReasoningChars = Math.max(0, turn.totalReasoningChars - turn.settledReasoningChars)
    const estimated = this.estimate(openChars, turn.model)
    const estimatedReasoning = Math.min(estimated, this.estimate(openReasoningChars, turn.model))
    const outputTokens = turn.measuredOutput + Math.max(0, estimated - estimatedReasoning)
    const reasoningTokens = turn.measuredReasoning + estimatedReasoning
    const tokens = outputTokens + reasoningTokens
    if (tokens <= 0 && turn.measuredSteps === 0) {
      state.turn = null
      return
    }
    if (turn.measuredSteps > 0 && turn.stepChars > 0) {
      this.calibrate(turn.model, turn.stepChars, turn.measuredOutput + turn.measuredReasoning)
    }
    const activeMs = this.activeMs(turn, at, true)
    const tps = rate(tokens, activeMs)
    if (tps === null) {
      state.turn = null
      return
    }
    state.last = {
      tps,
      ttftMs: turn.firstTtftMs ?? (turn.firstCharAt !== null ? turn.firstCharAt - turn.execAt : null),
      tokens,
      outputTokens,
      reasoningTokens,
      source: turn.measuredSteps > 0 ? "measured" : "estimate",
      activeMs,
      endedAt: at,
    }
    state.turn = null
  }

  private activeMs(turn: TurnState, now: number, final = false): number {
    let active = turn.activeMs
    if (!final && turn.lastCharAt !== null) {
      const gap = now - turn.lastCharAt
      if (gap > 0 && gap <= MAX_STREAM_GAP_MS) active += gap
    }
    if (active >= 1) return active
    return Math.min(MAX_STREAM_GAP_MS, Math.max(1, now - turn.execAt))
  }

  private estimate(chars: number, model: string): number {
    if (!Number.isFinite(chars) || chars <= 0) return 0
    return Math.max(0, Math.round((chars / 4) * (this.calibration.get(model) ?? 1)))
  }

  private calibrate(model: string, chars: number, tokens: number) {
    if (!Number.isFinite(chars) || chars <= 0) return
    if (!Number.isFinite(tokens) || tokens <= 0) return
    const heuristic = chars / 4
    if (heuristic <= 0) return
    const ratio = tokens / heuristic
    const factor = Math.min(MAX_CALIBRATION_FACTOR, Math.max(MIN_CALIBRATION_FACTOR, ratio))
    const previous = this.calibration.get(model) ?? 1
    this.calibration.set(model, previous + (factor - previous) * CALIBRATION_WEIGHT)
  }

  private live(state: SessionState, now: number): number {
    const from = now - WINDOW_MS
    let chars = 0
    let oldest = now
    for (const sample of state.samples) {
      if (sample.at < from) continue
      chars += sample.chars
      if (sample.at < oldest) oldest = sample.at
    }
    if (chars <= 0) return 0
    const span = Math.max(1, Math.min(WINDOW_MS, now - oldest))
    return rate(this.estimate(chars, state.model), span) ?? 0
  }

  private curve(state: SessionState, now: number, windowMs: number, buckets: number): SparkFrame {
    const start = now - windowMs
    const stepMs = windowMs / buckets
    const values = new Array<number>(buckets).fill(0)
    const counts = new Array<number>(buckets).fill(0)
    for (const sample of state.samples) {
      if (sample.at < start || sample.at > now) continue
      const index = Math.min(buckets - 1, Math.max(0, Math.floor((sample.at - start) / stepMs)))
      counts[index] += sample.chars
    }
    for (let index = 0; index < buckets; index += 1) {
      values[index] = rate(this.estimate(counts[index], state.model), stepMs) ?? 0
    }
    return { values, stepMs, at: now, windowMs }
  }

  private prune(state: SessionState, now: number) {
    const cutoff = now - MAX_CURVE_MS
    let expired = 0
    while (expired < state.samples.length && state.samples[expired].at < cutoff) expired += 1
    if (expired > 0) state.samples.splice(0, expired)
  }
}

function rate(tokens: number, ms: number): number | null {
  if (!Number.isFinite(tokens) || tokens <= 0) return null
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.min(MAX_PLAUSIBLE_TPS, tokens / (ms / 1_000))
}
