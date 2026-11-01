import {
  Command,
  MenuItem,
  Panel,
  Plugin,
  SettingsPage,
  Store,
  createKeyed,
  type Context,
  type MountedSession,
  type PanelTab,
} from "@opencode/plugin/gui"
import { Schema } from "effect"
import type {
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionStatsInfo,
  UsageLimitsBudget,
  UsageLimitsInfo,
  UsageLimitsMeter,
} from "@opencode/client/promise"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { UsageRpc, type UsageMeter, type UsageSnapshot } from "./rpc"
import { Metrics, type MetricsView } from "./metrics"

const POLL_MS = 60_000

const LIVE_CHART_MS = 15 * 60_000
const LIVE_CHART_BUCKETS = 15

type Prefs = {
  display: "used" | "remaining"
  warn: number
  danger: number
  live: boolean
  notify: boolean
}

const DEFAULT_PREFS: Prefs = {
  display: "used",
  warn: 50,
  danger: 80,
  live: true,
  notify: true,
}

const Preferences = Schema.Struct({
  display: Schema.Literals(["used", "remaining"]),
  warn: Schema.Number,
  danger: Schema.Number,
  live: Schema.Boolean,
  notify: Schema.Boolean,
})

type Tone = "warning" | "danger"

function tokenTotal(tokens: SessionInfo["tokens"] | undefined) {
  if (!tokens) return 0
  return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0)
}

function fmtTokens(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  return `${(value / 1_000_000_000).toFixed(2)}B`
}

function fmtCost(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "$0"
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

function fmtPercent(value: number) {
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`
}

function fmtReset(at: number, now: number) {
  const ms = at - now
  if (!Number.isFinite(ms)) return ""
  if (ms <= 0) return "now"
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 48) return `in ${hours}h${restMinutes ? ` ${restMinutes}m` : ""}`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return `in ${days}d${restHours ? ` ${restHours}h` : ""}`
}

function fmtAgo(at: number, now: number) {
  const seconds = Math.max(0, Math.round((now - at) / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

function fmtDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.round(ms / 1_000)}s`
}

function fmtTps(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "—"
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} tok/s`
}

function toneFor(percent: number, limited?: boolean, warn = 50, danger = 80): Tone | undefined {
  if (limited || percent >= danger) return "danger"
  if (percent >= warn) return "warning"
  return undefined
}

function limitsFor(session: MountedSession): UsageLimitsInfo | null {
  try {
    return session.server.data.location.usage.limits(session.location) ?? null
  } catch {
    return null
  }
}

function infoFor(session: MountedSession): SessionInfo | undefined {
  try {
    return session.server.data.session.get(session.id)
  } catch {
    return undefined
  }
}

function contextTokens(tokens: SessionInfo["tokens"] | undefined) {
  if (!tokens) return 0
  const reported = (tokens as { total?: number }).total
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) return reported
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read ?? 0) +
    (tokens.cache?.write ?? 0)
  )
}

function contextFillFor(session: MountedSession): { percent: number; total: number; limit: number } | null {
  let messages: SessionMessageInfo[] = []
  try {
    messages = session.server.data.session.message.list(session.id)
  } catch {
    return null
  }
  let latest: SessionMessageAssistant | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.type === "compaction") {
      if (message.status === "completed") return null
      continue
    }
    if (message.type !== "assistant" || !message.tokens) continue
    if (contextTokens(message.tokens) > 0) {
      latest = message
      break
    }
  }
  if (!latest?.tokens) return null
  const total = contextTokens(latest.tokens)
  const model = latest.model
  const models = session.server.data.location.model.list(session.location)
  const match = models?.find((item) => item.id === model.id && item.providerID === model.providerID)
  const limit = match?.limit.context ?? 200_000
  return { total, limit, percent: limit > 0 ? (total / limit) * 100 : 0 }
}

function fmtRatio(value: number | null) {
  return value === null || !Number.isFinite(value) ? "—" : `${Math.round(value * 100)}%`
}

type PerfPoint = { id: string; ttft: number | undefined; generation: number; output: number; tps: number }

type PerfTurn = {
  ttft?: number
  tps?: number
  output?: number
  generation?: number
  streaming?: boolean
}

type Perf = {
  current?: PerfTurn
  avg?: { ttft?: number; tps: number; count: number }
  waiting?: boolean
}

function fallbackTtft(message: SessionMessageAssistant) {
  const start = message.time?.created
  if (!start) return undefined
  for (const part of message.content) {
    // Text parts carry no start timestamp. If text came first, the first token
    // time is unknown; using a later tool/reasoning time would overstate TTFT.
    if (part.type === "text") return undefined
    if (part.type === "reasoning" && part.time?.created) return part.time.created - start
    if (part.type === "tool" && part.time?.created) return part.time.created - start
  }
  return undefined
}

function pointFor(message: SessionMessageAssistant): PerfPoint | undefined {
  const created = message.time?.created
  const streamed = message.time?.streamed
  const tokens = message.tokens
  const output = (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)
  if (!created || !streamed || output <= 0) return undefined
  const ttft = fallbackTtft(message)
  const start = ttft !== undefined ? created + Math.max(0, ttft) : created
  const generation = streamed - start
  if (generation <= 0) return undefined
  return {
    id: message.id,
    ttft,
    generation,
    output,
    tps: output / (generation / 1_000),
  }
}

function performanceFor(session: MountedSession): Perf {
  let all: SessionMessageInfo[] = []
  try {
    all = session.server.data.session.message.list(session.id)
  } catch {
    return {}
  }

  let start = 0
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const message = all[index]
    if (message.type === "compaction" && message.status === "completed") {
      start = index + 1
      break
    }
  }
  const recent = all.slice(start)

  const points: PerfPoint[] = []
  for (let index = recent.length - 1; index >= 0 && points.length < 20; index -= 1) {
    const message = recent[index]
    if (message.type !== "assistant") continue
    const point = pointFor(message)
    if (point) points.push(point)
  }
  points.reverse()

  let lastUser = -1
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    if (recent[index].type === "user") {
      lastUser = index
      break
    }
  }

  const turnPoints: PerfPoint[] = []
  if (lastUser >= 0) {
    for (let index = lastUser + 1; index < recent.length; index += 1) {
      const message = recent[index]
      if (message.type !== "assistant") continue
      const point = pointFor(message)
      if (point) turnPoints.push(point)
    }
  }

  let current: PerfTurn | undefined
  if (turnPoints.length > 0) {
    const output = turnPoints.reduce((sum, point) => sum + point.output, 0)
    const generation = turnPoints.reduce((sum, point) => sum + point.generation, 0)
    current = {
      ttft: turnPoints.find((point) => point.ttft !== undefined)?.ttft,
      tps: generation > 0 ? output / (generation / 1_000) : undefined,
      output,
      generation,
    }
  }
  if (!current && lastUser < 0 && points.length > 0) {
    const last = points[points.length - 1]
    current = {
      ttft: last.ttft,
      tps: last.tps,
      output: last.output,
      generation: last.generation,
    }
  }
  const waiting = !current && lastUser >= 0

  const avg =
    points.length > 0
      ? (() => {
          const totalOutput = points.reduce((sum, point) => sum + point.output, 0)
          const totalGeneration = points.reduce((sum, point) => sum + point.generation, 0)
          const ttftPoints = points.filter((point) => point.ttft !== undefined)
          const totalTtft = ttftPoints.reduce((sum, point) => sum + (point.ttft ?? 0), 0)
          return {
            ttft: ttftPoints.length > 0 ? totalTtft / ttftPoints.length : undefined,
            tps: totalOutput / (totalGeneration / 1_000),
            count: points.length,
          }
        })()
      : undefined

  return { current, avg, waiting }
}

type GoMeters = { rolling: UsageMeter; weekly: UsageMeter; monthly: UsageMeter }

type GoPlan = { go: GoMeters; label: string; workspace: string }

function goMeters(remote: UsageSnapshot | null, limits: UsageLimitsInfo | null): GoPlan | undefined {
  if (remote?.available) {
    return {
      go: { rolling: remote.rolling, weekly: remote.weekly, monthly: remote.monthly },
      label: remote.source === "opencode-go" ? "Go plan" : remote.source === "opencode" ? "Zen plan" : "Plan",
      workspace: remote.workspace,
    }
  }
  const go = limits?.go
  if (!go) return undefined
  return {
    go: { rolling: go.rolling, weekly: go.weekly, monthly: go.monthly },
    label: "Go plan",
    workspace: limits?.workspace?.name ?? "",
  }
}

function SectionLabel(props: { children: string }) {
  return (
    <div
      style={{
        "font-size": "10px",
        "font-weight": 600,
        "letter-spacing": ".05em",
        "text-transform": "uppercase",
        opacity: 0.45,
      }}
    >
      {props.children}
    </div>
  )
}

function MeterBar(props: { percent: number; tone?: Tone; marker?: number }) {
  const color = () =>
    props.tone === "danger" ? "#e5484d" : props.tone === "warning" ? "#f5a623" : "currentColor"
  return (
    <div
      style={{
        position: "relative",
        height: "4px",
        width: "100%",
        background: "color-mix(in srgb, currentColor 10%, transparent)",
        "border-radius": "999px",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${Math.max(0, Math.min(100, props.percent))}%`,
          background: color(),
          "border-radius": "999px",
        }}
      />
      <Show when={props.marker !== undefined}>
        <div
          title={`${Math.round(props.marker ?? 0)}% of the quota window has elapsed`}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `${Math.max(0, Math.min(100, props.marker ?? 0))}%`,
            width: "1px",
            background: "currentColor",
            opacity: 0.55,
          }}
        />
      </Show>
    </div>
  )
}

function MeterRow(props: {
  label: string
  meter: UsageLimitsMeter
  now: number
  windowMs?: number
  remaining?: boolean
  warn?: number
  danger?: number
}) {
  const tone = () => toneFor(props.meter.percent, props.meter.limited, props.warn, props.danger)
  const shown = () => (props.remaining ? 100 - props.meter.percent : props.meter.percent)
  const elapsed = () => {
    if (!props.windowMs || !props.meter.resetsAt) return null
    const start = props.meter.resetsAt - props.windowMs
    const ratio = (props.now - start) / props.windowMs
    return Math.max(0, Math.min(1, ratio))
  }
  const pace = () => {
    const ratio = elapsed()
    if (ratio === null) return ""
    const delta = props.meter.percent - ratio * 100
    if (Math.abs(delta) < 5) return "on pace"
    return delta > 0 ? `${Math.round(delta)}% over pace` : `${Math.round(-delta)}% under pace`
  }
  return (
    <div style={{ display: "grid", gap: "3px" }}>
      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "baseline", gap: "8px" }}>
        <span
          style={{
            "font-size": "12px",
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
          }}
        >
          {props.label}
          <span style={{ opacity: 0.45 }}> · {fmtReset(props.meter.resetsAt, props.now)}</span>
        </span>
        <span
          style={{
            "font-size": "12px",
            "font-variant-numeric": "tabular-nums",
            opacity: 0.75,
            "white-space": "nowrap",
          }}
        >
          {fmtPercent(shown())} {props.remaining ? "left" : "used"}
          {props.meter.limited ? " · limited" : ""}
        </span>
      </div>
      <MeterBar percent={shown()} tone={tone()} marker={elapsed() !== null ? elapsed()! * 100 : undefined} />
      <Show when={elapsed() !== null}>
        <div
          style={{
            display: "flex",
            "justify-content": "space-between",
            gap: "8px",
            "font-size": "9px",
            opacity: 0.35,
          }}
        >
          <span>time {Math.round(elapsed()! * 100)}%</span>
          <span>{pace()}</span>
        </div>
      </Show>
    </div>
  )
}

function BudgetRow(props: {
  budget: UsageLimitsBudget
  now: number
  remaining?: boolean
  warn?: number
  danger?: number
}) {
  const percent = () =>
    props.budget.limit > 0 ? Math.max(0, Math.min(100, (props.budget.spent / props.budget.limit) * 100)) : 0
  const left = () => Math.max(0, props.budget.limit - props.budget.spent)
  const shown = () => (props.remaining ? 100 - percent() : percent())
  const label = () => {
    if (props.budget.models.length === 0) return "Budget"
    return props.budget.models.map((model) => model.name || model.modelID).join(", ")
  }
  return (
    <div style={{ display: "grid", gap: "3px" }}>
      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "baseline", gap: "8px" }}>
        <span
          style={{
            "font-size": "12px",
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
          }}
        >
          {label()}
          {props.budget.picked ? " · active" : ""}
          <span style={{ opacity: 0.45 }}> · {fmtReset(props.budget.resetsAt, props.now)}</span>
        </span>
        <span
          style={{
            "font-size": "12px",
            "font-variant-numeric": "tabular-nums",
            opacity: 0.75,
            "white-space": "nowrap",
          }}
        >
          {props.remaining ? `${fmtCost(left())} left` : `${fmtCost(props.budget.spent)} / ${fmtCost(props.budget.limit)}`}
        </span>
      </div>
      <MeterBar percent={shown()} tone={toneFor(percent(), false, props.warn, props.danger)} />
    </div>
  )
}

function PlanSection(props: {
  plan: GoPlan
  now: number
  remaining: boolean
  toggle: () => void
  warn: number
  danger: number
}) {
  return (
    <div style={{ display: "grid", gap: "6px" }}>
      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "baseline" }}>
        <SectionLabel>Quota</SectionLabel>
        <button
          onClick={() => props.toggle()}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            color: "inherit",
            cursor: "pointer",
            "font-size": "10px",
            opacity: 0.45,
          }}
        >
          {props.remaining ? "left" : "used"}
        </button>
      </div>
      <MeterRow
        label="5 hours"
        meter={props.plan.go.rolling}
        now={props.now}
        windowMs={5 * 60 * 60_000}
        remaining={props.remaining}
        warn={props.warn}
        danger={props.danger}
      />
      <MeterRow
        label="1 week"
        meter={props.plan.go.weekly}
        now={props.now}
        windowMs={7 * 24 * 60 * 60_000}
        remaining={props.remaining}
        warn={props.warn}
        danger={props.danger}
      />
      <MeterRow
        label="1 month"
        meter={props.plan.go.monthly}
        now={props.now}
        windowMs={30 * 24 * 60 * 60_000}
        remaining={props.remaining}
        warn={props.warn}
        danger={props.danger}
      />
    </div>
  )
}

function BudgetsSection(props: {
  budgets: UsageLimitsBudget[]
  now: number
  remaining: boolean
  warn: number
  danger: number
}) {
  return (
    <div style={{ display: "grid", gap: "6px" }}>
      <SectionLabel>Budgets</SectionLabel>
      <For each={props.budgets}>
        {(budget) => (
          <BudgetRow
            budget={budget}
            now={props.now}
            remaining={props.remaining}
            warn={props.warn}
            danger={props.danger}
          />
        )}
      </For>
    </div>
  )
}

function Stat(props: { label: string; value: string; hint?: string }) {
  return (
    <div
      title={props.hint}
      style={{
        display: "grid",
        gap: "2px",
        padding: "6px 8px",
        "border-radius": "6px",
        background: "color-mix(in srgb, currentColor 5%, transparent)",
      }}
    >
      <span
        style={{
          "font-size": "10px",
          "letter-spacing": ".05em",
          "text-transform": "uppercase",
          opacity: 0.5,
        }}
      >
        {props.label}
      </span>
      <span style={{ "font-size": "15px", "font-weight": 600, "font-variant-numeric": "tabular-nums" }}>
        {props.value}
      </span>
    </div>
  )
}

function Sparkline(props: {
  values: number[]
  height?: number
  emptyLabel?: string
  startLabel?: string
  endLabel?: string
}) {
  const height = () => props.height ?? 34
  const max = () => Math.max(0, ...props.values)
  const active = () => max() > 0
  const width = 100
  const step = width / Math.max(1, props.values.length)
  return (
    <Show
      when={active()}
      fallback={
        <div
          style={{
            height: `${height()}px`,
            display: "grid",
            "place-items": "center",
            "border-radius": "5px",
            background: "color-mix(in srgb, currentColor 4%, transparent)",
            "font-size": "10px",
            opacity: 0.45,
          }}
        >
          {props.emptyLabel ?? "No samples in this range"}
        </div>
      }
    >
      <div style={{ display: "grid", gap: "2px" }}>
        <svg
          width="100%"
          height={height()}
          viewBox={`0 0 ${width} ${height()}`}
          preserveAspectRatio="none"
          style={{ display: "block" }}
          aria-hidden="true"
        >
          {props.values.map((value, index) => {
            if (!(value > 0)) return null
            const h = Math.max(1.5, (value / max()) * (height() - 2))
            return (
              <rect
                x={index * step + 0.5}
                y={height() - h - 1}
                width={Math.max(0.6, step - 1)}
                height={h}
                rx={0.8}
                fill="currentColor"
                opacity={0.35 + 0.55 * (value / max())}
              />
            )
          })}
        </svg>
        <Show when={props.startLabel && props.endLabel}>
          <div style={{ display: "flex", "justify-content": "space-between", "font-size": "10px", opacity: 0.35 }}>
            <span>{props.startLabel}</span>
            <span>{props.endLabel}</span>
          </div>
        </Show>
      </div>
    </Show>
  )
}

function MinuteCardBody(props: { snapshot: MetricsView | undefined }) {
  const turn = () => props.snapshot?.turn
  const last = () => props.snapshot?.last
  const active = () => !!turn()
  const values = () => props.snapshot?.spark.values ?? []
  const peak = () => Math.max(0, ...values())
  const avg = () => turn()?.tps ?? null
  const source = () => (active() ? turn()!.source : (last()?.source ?? null))
  const ttft = () => (active() ? turn()!.ttftMs : (last()?.ttftMs ?? null))
  const sourceLabel = () => (source() === "measured" ? "measured" : source() === "estimate" ? "estimated" : "")
  return (
    <div style={{ display: "grid", gap: "5px" }}>
      <Show
        when={active() || last()}
        fallback={
          <div style={{ "font-size": "10px", opacity: 0.45, "line-height": 1.5 }}>
            No turns yet. Send a prompt to see live TPS and TTFT.
          </div>
        }
      >
        <Show when={active() || peak() > 0}>
          <div style={{ display: "flex", "justify-content": "space-between", gap: "8px", "font-size": "10px", opacity: 0.45 }}>
            <span title="Each bar is one minute of generation speed. Gaps mean no tokens were generated.">
              Generation speed · last 15 min
            </span>
            <span>{peak() > 0 ? `peak ${fmtTps(peak())}` : ""}</span>
          </div>
          <Sparkline
            values={values()}
            emptyLabel={active() ? "Waiting for the first token…" : "No generation in the last 15 min"}
            startLabel="15 min ago"
            endLabel="now"
          />
        </Show>
        <div style={{ display: "flex", "justify-content": "space-between", gap: "8px", "font-size": "10px", opacity: 0.55 }}>
          <span>
            {active()
              ? avg() !== null
                ? `avg ${fmtTps(avg()!)}`
                : ""
              : last()
                ? `${fmtTokens(last()!.tokens)} tok · ${fmtDuration(last()!.activeMs)}`
                : ""}
          </span>
          <span>
            {ttft() !== null && ttft() !== undefined ? `ttft ${fmtDuration(ttft()!)}` : "ttft —"}
            {sourceLabel() ? ` · ${sourceLabel()}` : ""}
          </span>
        </div>
      </Show>
    </div>
  )
}

function PerformanceCard(props: {
  ui: Context["ui"]
  session: MountedSession
  snapshot: MetricsView | undefined
  historyFrom: number
  historyTo: number
  live: boolean
}) {
  const [mode, setMode] = createSignal<"minute" | "24h" | "30d">("minute")
  const activeMode = () => (props.live ? mode() : mode() === "minute" ? "24h" : mode())
  const turn = () => props.snapshot?.turn
  const last = () => props.snapshot?.last
  const liveTps = () => (turn() ? turn()!.liveTps : (last()?.tps ?? null))
  const tpsLabel = () => (turn() ? "LIVE" : last() ? "LAST" : "TPS")
  const chip = (active: boolean, label: string, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        background: active ? "color-mix(in srgb, currentColor 14%, transparent)" : "transparent",
        border: `1px solid color-mix(in srgb, currentColor ${active ? 24 : 10}%, transparent)`,
        "border-radius": "4px",
        padding: "1px 6px",
        "font-size": "9px",
        color: "inherit",
        cursor: "pointer",
        opacity: active ? 0.85 : 0.45,
      }}
    >
      {label}
    </button>
  )
  return (
    <div
      style={{
        display: "grid",
        gap: "5px",
        padding: "8px 10px",
        "border-radius": "6px",
        background: "color-mix(in srgb, currentColor 5%, transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          "justify-content": "space-between",
          "align-items": "baseline",
          gap: "8px",
          "flex-wrap": "wrap",
        }}
      >
        <div
          style={{ display: "flex", "align-items": "baseline", gap: "6px", "min-width": 0 }}
          title={
            turn()
              ? "Instantaneous generation speed over the last second."
              : last()
                ? "Average TPS of the last completed turn."
                : "TPS"
          }
        >
          <Show when={props.live}>
            <span
              style={{
                "font-size": "9px",
                "letter-spacing": ".05em",
                "text-transform": "uppercase",
                opacity: 0.45,
              }}
            >
              {tpsLabel()}
            </span>
            <span
              style={{
                "font-size": "18px",
                "font-weight": 600,
                "font-variant-numeric": "tabular-nums",
              }}
            >
              {liveTps() !== null ? fmtTps(liveTps()!) : "—"}
            </span>
          </Show>
        </div>
        <div style={{ display: "flex", gap: "4px", "margin-left": "auto" }}>
          <Show when={props.live}>
            {chip(mode() === "minute", "15m", () => setMode("minute"))}
          </Show>
          {chip(activeMode() === "24h", "24h", () => setMode("24h"))}
          {chip(activeMode() === "30d", "30d", () => setMode("30d"))}
        </div>
      </div>
      <Show
        when={activeMode() === "minute"}
        fallback={
          <ResponsePerformance
            ui={props.ui}
            session={props.session}
            from={activeMode() === "24h" ? props.historyTo - 24 * 60 * 60_000 : props.historyFrom}
            to={props.historyTo}
            rangeLabel={activeMode() === "24h" ? "24h" : "30d"}
            defaultMode={activeMode() === "24h" ? "day" : "range"}
            compact
            loadOlder={false}
          />
        }
      >
        <MinuteCardBody snapshot={props.snapshot} />
      </Show>
    </div>
  )
}

function PerformanceStats(props: {
  perf: Perf
  snapshot: MetricsView | undefined
  live: boolean
  ui: Context["ui"]
  session: MountedSession
  historyFrom: number
  historyTo: number
}) {
  const current = () => props.snapshot?.turn ?? null
  const last = () => props.snapshot?.last ?? null
  const fallback = () => props.perf.current
  const avg = () => props.perf.avg
  const waiting = () => props.perf.waiting && !current() && !last()
  const turnTtft = () => (current() ? current()!.ttftMs : (last()?.ttftMs ?? fallback()?.ttft))
  const turnTps = () => (current() ? current()!.tps : (last()?.tps ?? fallback()?.tps))
  const turnStreaming = () => !!current() && current()!.tps === null
  return (
    <div style={{ display: "grid", gap: "6px" }}>
      <SectionLabel>Performance</SectionLabel>
      <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "6px" }}>
        <Stat
          label="TTFT · turn"
          hint="Current turn: step start to first text, reasoning, or tool token."
          value={turnTtft() !== null && turnTtft() !== undefined ? fmtDuration(turnTtft()!) : "—"}
        />
        <Stat
          label="TPS · turn"
          hint="Current turn: output plus reasoning tokens per net generation second."
          value={turnTps() !== null && turnTps() !== undefined ? fmtTps(turnTps()!) : turnStreaming() || waiting() ? "…" : "—"}
        />
        <Stat
          label="TTFT · global"
          hint={`Average over ${avg()?.count ?? 0} responses since the last compaction.`}
          value={avg()?.ttft !== undefined ? fmtDuration(avg()!.ttft!) : "—"}
        />
        <Stat
          label="TPS · global"
          hint={`Weighted average over ${avg()?.count ?? 0} responses since the last compaction.`}
          value={avg()?.tps !== undefined ? fmtTps(avg()!.tps!) : "—"}
        />
      </div>
      <PerformanceCard
        ui={props.ui}
        session={props.session}
        snapshot={props.snapshot}
        historyFrom={props.historyFrom}
        historyTo={props.historyTo}
        live={props.live}
      />
    </div>
  )
}

function SessionStats(props: { session: MountedSession; info: SessionInfo | undefined }) {
  const tokens = () => props.info?.tokens
  const cacheRead = () => tokens()?.cache?.read ?? 0
  const cacheWrite = () => tokens()?.cache?.write ?? 0
  const cache = () => cacheRead() + cacheWrite()
  const input = () => tokens()?.input ?? 0
  const context = createMemo(() => contextFillFor(props.session))
  const cacheHit = () => {
    const total = input() + cacheRead() + cacheWrite()
    return total > 0 ? cacheRead() / total : null
  }
  const costPerMillion = () => {
    const total = input() + (tokens()?.output ?? 0) + (tokens()?.reasoning ?? 0) + cache()
    return total > 0 ? ((props.info?.cost ?? 0) / total) * 1_000_000 : null
  }
  const reasoningShare = () => {
    const produced = (tokens()?.output ?? 0) + (tokens()?.reasoning ?? 0)
    return produced > 0 ? (tokens()?.reasoning ?? 0) / produced : null
  }
  return (
    <div style={{ display: "grid", gap: "6px" }}>
      <SectionLabel>This session</SectionLabel>
      <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "6px" }}>
        <Stat label="Cost" value={fmtCost(props.info?.cost ?? 0)} />
        <Stat label="Tokens" value={fmtTokens(tokenTotal(tokens()))} />
        <Stat
          label="Cache hit"
          hint="cache.read / (input + cache.read + cache.write)"
          value={fmtRatio(cacheHit())}
        />
        <Stat
          label="Context"
          hint={
            context()
              ? `${fmtTokens(context()!.total)} / ${fmtTokens(context()!.limit)} tokens`
              : "compacted or not measured yet"
          }
          value={context() ? fmtPercent(context()!.percent) : "—"}
        />
      </div>
      <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "6px" }}>
        <Stat
          label="Input"
          hint="Fresh prompt tokens for this session, not served from cache."
          value={fmtTokens(input())}
        />
        <Stat
          label="Output"
          hint="Visible output tokens for this session. Reasoning is counted separately."
          value={fmtTokens(tokens()?.output ?? 0)}
        />
        <Stat
          label="Cache read"
          hint="Prompt tokens served from the cache. Cheaper and faster than fresh input."
          value={fmtTokens(cacheRead())}
        />
        <Stat
          label="Cache write"
          hint="Tokens written into the cache for later reads."
          value={fmtTokens(cacheWrite())}
        />
        <Stat
          label="Reasoning share"
          hint="Reasoning tokens divided by output + reasoning tokens."
          value={fmtRatio(reasoningShare())}
        />
        <Stat
          label="Cost / 1M"
          hint="Session cost per million tokens. Go plan usage is included, so it can be $0."
          value={
            costPerMillion() !== null && (props.info?.cost ?? 0) > 0
              ? fmtCost(costPerMillion()!)
              : "$0"
          }
        />
      </div>
    </div>
  )
}

function UsagePanel(props: {
  ctx: Context
  session: MountedSession
  snapshot: MetricsView | undefined
  prefs: Prefs
  setPrefs: (patch: Partial<Prefs>) => void
  remote: UsageSnapshot | null
  remoteError: boolean
  limits: UsageLimitsInfo | null
  info: SessionInfo | undefined
  now: number
  refresh: () => void
}) {
  const ui = props.ctx.ui
  const remaining = () => props.prefs.display === "remaining"
  const plan = () => goMeters(props.remote, props.limits)
  const budgets = () => props.limits?.budgets ?? []
  const perf = () => performanceFor(props.session)
  const historyFrom = () => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - 29)
    return start.getTime()
  }
  const workspace = () => props.remote?.workspace || props.limits?.workspace?.name || ""
  const usageURL = () => props.limits?.workspace?.usageURL
  const updated = () => (props.remote?.fetchedAt ? fmtAgo(props.remote.fetchedAt, props.now) : "")
  const empty = () => !plan() && budgets().length === 0
  const title = () =>
    workspace() ||
    (props.remote?.source === "opencode-go"
      ? "OpenCode Go"
      : props.remote?.source === "opencode"
        ? "OpenCode Zen"
        : "Usage")
  const subtitle = () => [plan()?.label, updated() ? `updated ${updated()}` : ""].filter(Boolean).join(" · ")

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        "min-height": 0,
        "font-size": "12px",
      }}
    >
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          gap: "8px",
          padding: "6px 10px",
          "border-bottom": "1px solid color-mix(in srgb, currentColor 10%, transparent)",
          "flex-shrink": 0,
        }}
      >
        <div style={{ display: "grid", gap: "1px", "min-width": 0 }}>
          <div style={{ "font-size": "13px", "font-weight": 600 }}>{title()}</div>
          <div
            style={{
              "font-size": "10px",
              opacity: 0.5,
              "white-space": "nowrap",
              overflow: "hidden",
              "text-overflow": "ellipsis",
            }}
          >
            {subtitle() || "Plan quota"}
          </div>
        </div>
        <div style={{ display: "flex", "align-items": "center", gap: "2px" }}>
          <ui.Tooltip value="Stats">
            <ui.IconButton
              icon="window-analytics"
              label="Stats"
              size="small"
              onClick={() =>
                props.ctx.dialogs.open((dialog) => (
                  <StatsDialog ui={ui} session={props.session} close={dialog.close} />
                ))
              }
            />
          </ui.Tooltip>
          <ui.Tooltip value="Settings">
            <ui.IconButton
              icon="settings-gear"
              label="Settings"
              size="small"
              onClick={() => props.ctx.layout.settings("usage")}
            />
          </ui.Tooltip>
          <ui.Tooltip value="Refresh">
            <ui.IconButton icon="refresh" label="Refresh" size="small" onClick={() => props.refresh()} />
          </ui.Tooltip>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gap: "10px",
          padding: "8px 10px",
          "overflow-y": "auto",
          "min-height": 0,
        }}
      >
        <Show when={plan()}>
          {(plan) => (
            <PlanSection
              plan={plan()}
              now={props.now}
              remaining={remaining()}
              warn={props.prefs.warn}
              danger={props.prefs.danger}
              toggle={() =>
                props.setPrefs({ display: remaining() ? "used" : "remaining" })
              }
            />
          )}
        </Show>

        <Show when={budgets().length > 0}>
          <BudgetsSection
            budgets={budgets()}
            now={props.now}
            remaining={remaining()}
            warn={props.prefs.warn}
            danger={props.prefs.danger}
          />
        </Show>

        <Show when={empty()}>
          <div style={{ "font-size": "12px", opacity: 0.55, "line-height": 1.5 }}>
            {props.remoteError
              ? "Could not reach the usage service. Press Refresh to retry."
              : props.remote === null
                ? "Loading quota…"
                : "No plan quota reported. Sign in to OpenCode Go or Zen, then press Refresh."}
          </div>
        </Show>

        <PerformanceStats
          perf={perf()}
          snapshot={props.snapshot}
          live={props.prefs.live}
          ui={ui}
          session={props.session}
          historyFrom={historyFrom()}
          historyTo={props.now}
        />

        <SessionStats session={props.session} info={props.info} />

        <Show when={usageURL()}>
          {(url) => (
            <ui.Button
              variant="neutral"
              size="small"
              icon="square-arrow-top-right"
              onClick={() => props.ctx.system.openExternal(url())}
            >
              Open dashboard
            </ui.Button>
          )}
        </Show>
      </div>
    </div>
  )
}

function BigStat(props: { label: string; value: string; hint?: string }) {
  return (
    <div
      title={props.hint}
      style={{
        display: "grid",
        gap: "2px",
        padding: "8px 10px",
        "border-radius": "8px",
        background: "color-mix(in srgb, currentColor 5%, transparent)",
      }}
    >
      <span
        style={{
          "font-size": "10px",
          "letter-spacing": ".05em",
          "text-transform": "uppercase",
          opacity: 0.5,
        }}
      >
        {props.label}
      </span>
      <span style={{ "font-size": "18px", "font-weight": 600, "font-variant-numeric": "tabular-nums" }}>
        {props.value}
      </span>
    </div>
  )
}

type StatsRange = "7d" | "30d" | "90d" | "all"
type StatsScope = "all" | "project"
type StatsToolDetail = Extract<SessionStatsInfo["tools"], { mode: "detail" }>

const STATS_RANGES: { id: StatsRange; label: string; days?: number }[] = [
  { id: "7d", label: "7d", days: 7 },
  { id: "30d", label: "30d", days: 30 },
  { id: "90d", label: "90d", days: 90 },
  { id: "all", label: "All" },
]

const TOKEN_COLORS = {
  input: "#5b8def",
  output: "#3dbb6e",
  cacheRead: "#f5a623",
  cacheWrite: "#a78bfa",
} as const

const STATS_CACHE = new Map<string, { at: number; value: SessionStatsInfo }>()
const STATS_CACHE_TTL = 60_000

type ActivityBar = { start: string; end: string; value: number }
type ActivitySeries = { unit: "day" | "week"; bars: ActivityBar[]; max: number }

const TOKEN_ACTIVITY_CACHE = new Map<string, { at: number; value: ActivitySeries }>()
const TOKEN_ACTIVITY_TTL = 60_000

function dateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

function parseDay(key: string): Date {
  const [year, month, day] = key.split("-").map(Number)
  return new Date(year, month - 1, day)
}

function activityLabel(bar: ActivityBar): string {
  const format = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
  if (bar.start === bar.end) return format.format(parseDay(bar.start))
  return `${format.format(parseDay(bar.start))} – ${format.format(parseDay(bar.end))}`
}

function ActivityChart(props: { series: ActivitySeries }) {
  const [active, setActive] = createSignal<number | null>(null)
  const bars = () => props.series.bars
  const max = () => props.series.max
  const total = () => bars().reduce((sum, bar) => sum + bar.value, 0)
  const current = () => {
    const index = active()
    return index === null ? null : (bars()[index] ?? null)
  }
  return (
    <div style={{ display: "grid", gap: "4px" }}>
      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "baseline", gap: "8px" }}>
        <SectionLabel>Token activity</SectionLabel>
        <span style={{ "font-size": "10px", opacity: 0.4 }}>
          {bars().length} {props.series.unit === "week" ? "weeks" : "days"} · {fmtTokens(total())}
        </span>
      </div>
      <div
        style={{ display: "flex", "align-items": "flex-end", gap: "2px", height: "42px" }}
        onMouseLeave={() => setActive(null)}
      >
        <For each={bars()}>
          {(bar, index) => {
            const height = () =>
              max() > 0 ? Math.max(bar.value > 0 ? 3 : 0, (bar.value / max()) * 100) : 0
            return (
              <div
                title={`${activityLabel(bar)} · ${fmtTokens(bar.value)} tokens`}
                onMouseEnter={() => setActive(index())}
                style={{
                  flex: 1,
                  "min-width": "1px",
                  height: bar.value > 0 ? `${height()}%` : "1px",
                  "border-radius": "2px 2px 0 0",
                  background:
                    bar.value > 0
                      ? "currentColor"
                      : "color-mix(in srgb, currentColor 14%, transparent)",
                  opacity:
                    active() === index()
                      ? 0.9
                      : bar.value > 0
                        ? 0.35 + 0.55 * (bar.value / Math.max(1, max()))
                        : 0.3,
                }}
              />
            )
          }}
        </For>
      </div>
      <div style={{ display: "flex", "justify-content": "space-between", "font-size": "10px", opacity: 0.35 }}>
        <span>{bars()[0] ? activityLabel(bars()[0]) : "—"}</span>
        <span>{bars()[bars().length - 1] ? activityLabel(bars()[bars().length - 1]) : "—"}</span>
      </div>
      <div style={{ "font-size": "10px", opacity: 0.45, "min-height": "13px" }}>
        {current() ? `${activityLabel(current()!)} · ${fmtTokens(current()!.value)} tokens` : ""}
      </div>
    </div>
  )
}

type ResponsePoint = {
  at: number
  tps: number | null
  ttft: number | null
}

type ResponseBucket = {
  start: number
  end: number
  count: number
  tps: number | null
  ttft: number | null
}

function responsePoints(session: MountedSession, from: number, to: number): ResponsePoint[] {
  let messages: SessionMessageInfo[] = []
  try {
    messages = session.server.data.session.message.list(session.id)
  } catch {
    return []
  }
  const points: ResponsePoint[] = []
  for (const message of messages) {
    if (message.type !== "assistant") continue
    const created = message.time?.created
    if (!created || created < from || created >= to) continue
    const tokens = message.tokens
    const output = (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)
    if (output <= 0) continue
    const ttft = fallbackTtft(message) ?? null
    const streamed = message.time?.streamed ?? message.time?.completed
    const generation = streamed ? streamed - (created + (ttft ?? 0)) : 0
    const tps = generation > 0 ? output / (generation / 1_000) : null
    if (tps === null && ttft === null) continue
    points.push({ at: created, tps, ttft })
  }
  points.sort((a, b) => a.at - b.at)
  return points
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1))
  return sorted[index]
}

type PerformanceSeries = {
  unit: "hour" | "day" | "week"
  spans: { start: number; end: number }[]
}

function hourlySeries(now: number): PerformanceSeries {
  const currentHour = new Date(now)
  currentHour.setMinutes(0, 0, 0)
  const end = currentHour.getTime() + 60 * 60_000
  const start = end - 24 * 60 * 60_000
  return {
    unit: "hour",
    spans: Array.from({ length: 24 }, (_, index) => ({
      start: start + index * 60 * 60_000,
      end: start + (index + 1) * 60 * 60_000,
    })),
  }
}

function dailySeries(from: number, to: number): PerformanceSeries {
  const first = new Date(from)
  const cursor = new Date(first.getFullYear(), first.getMonth(), first.getDate())
  const last = new Date(to - 1)
  const lastKey = dateKey(last)
  const days: { start: number; end: number }[] = []
  for (let guard = 0; guard < 5_000; guard += 1) {
    const key = dateKey(cursor)
    const next = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
    days.push({ start: cursor.getTime(), end: next.getTime() })
    if (key >= lastKey) break
    cursor.setDate(cursor.getDate() + 1)
  }
  if (days.length <= 92) return { unit: "day", spans: days }
  const weeks: { start: number; end: number }[] = []
  for (let index = 0; index < days.length; index += 7) {
    const chunk = days.slice(index, index + 7)
    weeks.push({ start: chunk[0].start, end: chunk[chunk.length - 1].end })
  }
  return { unit: "week", spans: weeks }
}

function responseBuckets(
  points: ResponsePoint[],
  spans: { start: number; end: number }[],
): ResponseBucket[] {
  return spans.map((span) => {
    const chunk = points.filter((point) => point.at >= span.start && point.at < span.end)
    return {
      start: span.start,
      end: span.end,
      count: chunk.length,
      tps: average(chunk.map((point) => point.tps).filter((value): value is number => value !== null)),
      ttft: average(chunk.map((point) => point.ttft).filter((value): value is number => value !== null)),
    }
  })
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

async function loadTokenActivity(
  session: MountedSession,
  from: number,
  to: number,
  range: StatsRange,
  scope: StatsScope,
  refresh = false,
): Promise<ActivitySeries> {
  const project = scope === "project" ? session.project?.id : undefined
  const key = `${session.server.id}:${session.directory}:${range}:${scope}:${project ?? ""}`
  if (!refresh) {
    const hit = TOKEN_ACTIVITY_CACHE.get(key)
    if (hit && Date.now() - hit.at < TOKEN_ACTIVITY_TTL) return hit.value
  }
  const series = dailySeries(from, to)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const values = await mapLimit(series.spans, 6, async (span) => {
    const stats = await session.server.client.experimental.session.stats({
      from: span.start,
      to: span.end,
      project,
      timezone,
      tools: "none",
    })
    return (
      stats.tokens.input +
      stats.tokens.output +
      stats.tokens.reasoning +
      stats.tokens.cache.read +
      stats.tokens.cache.write
    )
  })
  const bars = series.spans.map((span, index) => ({
    start: dateKey(new Date(span.start)),
    end: dateKey(new Date(span.end - 1)),
    value: values[index],
  }))
  const value: ActivitySeries = {
    unit: series.unit === "week" ? "week" : "day",
    bars,
    max: Math.max(0, ...bars.map((bar) => bar.value)),
  }
  TOKEN_ACTIVITY_CACHE.set(key, { at: Date.now(), value })
  if (TOKEN_ACTIVITY_CACHE.size > 20) {
    const oldest = TOKEN_ACTIVITY_CACHE.keys().next().value
    if (oldest) TOKEN_ACTIVITY_CACHE.delete(oldest)
  }
  return value
}

function fmtHour(at: number) {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

function fmtDay(at: number) {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function MetricBars(props: {
  title: string
  buckets: ResponseBucket[]
  metric: "tps" | "ttft"
  format: (value: number) => string
  color: string
  summary: string
  empty: string
  labelFor: (bucket: ResponseBucket) => string
  axisFormat: (at: number) => string
  hint?: string
}) {
  const [active, setActive] = createSignal<number | null>(null)
  const values = () => props.buckets.map((bucket) => bucket[props.metric])
  const max = () => Math.max(0, ...values().filter((value): value is number => value !== null))
  const has = () => values().some((value) => value !== null)
  const current = () => {
    const index = active()
    return index === null ? null : (props.buckets[index] ?? null)
  }
  return (
    <div style={{ display: "grid", gap: "3px" }}>
      <div
        style={{
          display: "flex",
          "justify-content": "space-between",
          "align-items": "baseline",
          gap: "8px",
          "flex-wrap": "wrap",
        }}
      >
        <span style={{ "font-size": "11px", "font-weight": 600 }} title={props.hint}>
          {props.title}
        </span>
        <span style={{ "font-size": "10px", opacity: 0.55, "text-align": "right" }}>{props.summary}</span>
      </div>
      <Show
        when={has()}
        fallback={
          <div
            style={{
              height: "38px",
              display: "grid",
              "place-items": "center",
              "border-radius": "5px",
              background: "color-mix(in srgb, currentColor 4%, transparent)",
              "font-size": "10px",
              opacity: 0.45,
            }}
          >
            {props.empty}
          </div>
        }
      >
        <div style={{ display: "grid", gap: "2px" }}>
          <div
            style={{ display: "flex", "align-items": "flex-end", gap: "2px", height: "38px" }}
            onMouseLeave={() => setActive(null)}
          >
            <For each={props.buckets}>
              {(bucket, index) => {
                const value = () => bucket[props.metric]
                const height = () =>
                  value() !== null && max() > 0 ? Math.max(3, (value()! / max()) * 100) : 0
                return (
                  <div
                    title={`${props.labelFor(bucket)} · ${bucket.count} responses${
                      value() !== null ? ` · ${props.format(value()!)}` : ""
                    }`}
                    onMouseEnter={() => setActive(index())}
                    style={{
                      flex: 1,
                      "min-width": "1px",
                      height: value() !== null ? `${height()}%` : "1px",
                      "border-radius": "2px 2px 0 0",
                      background:
                        value() !== null
                          ? props.color
                          : "color-mix(in srgb, currentColor 14%, transparent)",
                      opacity:
                        active() === index()
                          ? 0.95
                          : value() !== null
                            ? 0.55 + 0.35 * (value()! / Math.max(1, max()))
                            : 0.3,
                    }}
                  />
                )
              }}
            </For>
          </div>
          <div style={{ display: "flex", "justify-content": "space-between", "font-size": "9px", opacity: 0.35 }}>
            <span>{props.buckets[0] ? props.axisFormat(props.buckets[0].start) : "—"}</span>
            <span>
              {props.buckets[props.buckets.length - 1]
                ? props.axisFormat(props.buckets[props.buckets.length - 1].end - 1)
                : "—"}
            </span>
          </div>
          <div style={{ "font-size": "9px", opacity: 0.45, "min-height": "12px" }}>
            {current()
              ? `${props.labelFor(current()!)} · ${current()!.count} responses${
                  current()![props.metric] !== null ? ` · ${props.format(current()![props.metric]!)}` : ""
                }`
              : ""}
          </div>
        </div>
      </Show>
    </div>
  )
}

function ResponsePerformance(props: {
  ui: Context["ui"]
  session: MountedSession
  from: number
  to: number
  rangeLabel: string
  defaultMode?: "day" | "range"
  compact?: boolean
  loadOlder?: boolean
}) {
  const ui = props.ui
  const compact = () => props.compact ?? false
  const allowLoad = () => props.loadOlder ?? true
  const [version, setVersion] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const [mode, setMode] = createSignal<"day" | "range">(props.defaultMode ?? "range")
  const effectiveMode = () => (compact() && props.defaultMode ? props.defaultMode : mode())
  const series = createMemo(() =>
    effectiveMode() === "day" ? hourlySeries(props.to) : dailySeries(props.from, props.to),
  )
  const viewFrom = () => series().spans[0]?.start ?? props.from
  const viewTo = () => series().spans[series().spans.length - 1]?.end ?? props.to
  const points = createMemo(() => {
    version()
    return responsePoints(props.session, viewFrom(), viewTo())
  })
  const buckets = createMemo(() => responseBuckets(points(), series().spans))
  const tpsValues = () => points().map((point) => point.tps).filter((value): value is number => value !== null)
  const ttftValues = () => points().map((point) => point.ttft).filter((value): value is number => value !== null)
  const tpsSummary = () => {
    const values = tpsValues()
    if (values.length === 0) return "no data"
    return `n=${values.length} · avg ${fmtTps(average(values)!)} · p50 ${fmtTps(percentile(values, 0.5)!)} · p95 ${fmtTps(percentile(values, 0.95)!)}`
  }
  const ttftSummary = () => {
    const values = ttftValues()
    if (values.length === 0) return "no data"
    return `n=${values.length} · avg ${fmtDuration(average(values)!)} · p50 ${fmtDuration(percentile(values, 0.5)!)} · p95 ${fmtDuration(percentile(values, 0.95)!)}`
  }
  const selectMode = (next: "day" | "range") => setMode(next)
  const labelFor = (bucket: ResponseBucket) => {
    if (effectiveMode() === "day") return `${fmtHour(bucket.start)}–${fmtHour(bucket.end)}`
    if (series().unit === "week") return `${fmtDay(bucket.start)} – ${fmtDay(bucket.end - 1)}`
    return fmtDay(bucket.start)
  }
  const axisFormat = (at: number) => (effectiveMode() === "day" ? fmtHour(at) : fmtDay(at))
  const caption = () => {
    if (effectiveMode() === "day") return "Last 24 hours · hourly buckets"
    return `${props.rangeLabel} · ${series().unit === "week" ? "weekly" : "daily"} buckets`
  }
  const more = () => {
    version()
    try {
      return props.session.server.data.session.message.more(props.session.id)
    } catch {
      return false
    }
  }
  const loadOlder = async () => {
    if (loading()) return
    setLoading(true)
    setFailed(false)
    try {
      await props.session.server.data.session.message.loadMore(props.session.id)
      setVersion((value) => value + 1)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }
  return (
    <div style={{ display: "grid", gap: "5px" }}>
      <Show when={!compact()}>
        <div
          style={{
            display: "flex",
            "justify-content": "space-between",
            "align-items": "center",
            gap: "8px",
            "flex-wrap": "wrap",
          }}
        >
          <SectionLabel>Response performance</SectionLabel>
          <div style={{ display: "flex", gap: "4px" }}>
            <ui.Button
              size="small"
              variant={effectiveMode() === "day" ? "contrast" : "neutral"}
              onClick={() => selectMode("day")}
            >
              24h
            </ui.Button>
            <ui.Button
              size="small"
              variant={effectiveMode() === "range" ? "contrast" : "neutral"}
              onClick={() => selectMode("range")}
            >
              {props.rangeLabel}
            </ui.Button>
          </div>
        </div>
      </Show>
      <div
        style={{
          display: "flex",
          "justify-content": "space-between",
          gap: "8px",
          "font-size": "10px",
          opacity: 0.45,
          "flex-wrap": "wrap",
        }}
      >
        <span>{caption()}</span>
        <span>{points().length} responses · this session</span>
      </div>
      <MetricBars
        title="TPS"
        buckets={buckets()}
        metric="tps"
        format={fmtTps}
        color="#3dbb6e"
        summary={tpsSummary()}
        empty={effectiveMode() === "day" ? "No TPS data in the last 24h" : "No TPS data in this range"}
        labelFor={labelFor}
        axisFormat={axisFormat}
        hint="TPS = (output + reasoning tokens) / (streamed − first output). Historical responses without a first-output timestamp may be understated."
      />
      <MetricBars
        title="TTFT"
        buckets={buckets()}
        metric="ttft"
        format={fmtDuration}
        color="#f5a623"
        summary={ttftSummary()}
        empty={effectiveMode() === "day" ? "No TTFT data in the last 24h" : "No TTFT timestamp for these responses"}
        labelFor={labelFor}
        axisFormat={axisFormat}
        hint="TTFT is measured from the response start to the first reasoning/tool part. Text-only history has no timestamp."
      />
      <Show when={!compact() && allowLoad() && more()}>
        <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", gap: "8px" }}>
          <span style={{ "font-size": "10px", opacity: 0.45 }}>
            {failed() ? "Could not load older messages." : "This session has older messages not loaded."}
          </span>
          <ui.Button size="small" variant="ghost" onClick={() => void loadOlder()} disabled={loading()}>
            {loading() ? "Loading…" : "Load older"}
          </ui.Button>
        </div>
      </Show>
    </div>
  )
}

function TokenActivity(props: {
  session: MountedSession
  stats: SessionStatsInfo
  range: StatsRange
  scope: StatsScope
  refreshNonce: number
}) {
  const [series, setSeries] = createSignal<ActivitySeries | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [failed, setFailed] = createSignal(false)
  let seenNonce = 0

  createEffect(() => {
    const stats = props.stats
    const currentRange = props.range
    const currentScope = props.scope
    const refresh = props.refreshNonce !== seenNonce
    seenNonce = props.refreshNonce
    let cancelled = false
    setLoading(true)
    setFailed(false)
    void loadTokenActivity(
      props.session,
      stats.range.from,
      stats.range.to,
      currentRange,
      currentScope,
      refresh,
    )
      .then((value) => {
        if (cancelled) return
        setSeries(value)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setSeries(null)
        setFailed(true)
        setLoading(false)
      })
    onCleanup(() => {
      cancelled = true
    })
  })

  return (
    <Show
      when={!loading()}
      fallback={<div style={{ "font-size": "10px", opacity: 0.45 }}>Loading token activity…</div>}
    >
      <Show
        when={series()}
        fallback={
          <div style={{ "font-size": "10px", opacity: 0.55 }}>
            {failed() ? "Could not load token activity. Press Refresh to retry." : "No token activity in this range."}
          </div>
        }
      >
        {(data) => <ActivityChart series={data()} />}
      </Show>
    </Show>
  )
}

async function loadStats(
  session: MountedSession,
  range: StatsRange,
  scope: StatsScope,
  refresh = false,
) {
  const project = scope === "project" ? session.project?.id : undefined
  const key = `${session.server.id}:${session.directory}:${range}:${scope}:${project ?? ""}`
  if (!refresh) {
    const hit = STATS_CACHE.get(key)
    if (hit && Date.now() - hit.at < STATS_CACHE_TTL) return hit.value
  }
  const item = STATS_RANGES.find((entry) => entry.id === range)
  const input: {
    from?: number
    to?: number
    project?: string
    timezone: string
    tools: "summary"
  } = {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tools: "summary",
  }
  if (project) input.project = project
  if (item?.days) {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - (item.days - 1))
    input.from = start.getTime()
    input.to = Date.now()
  }
  const value = await session.server.client.experimental.session.stats(input)
  STATS_CACHE.set(key, { at: Date.now(), value })
  if (STATS_CACHE.size > 20) {
    const oldest = STATS_CACHE.keys().next().value
    if (oldest) STATS_CACHE.delete(oldest)
  }
  return value
}

function StatsDialog(props: { ui: Context["ui"]; session: MountedSession; close: () => void }) {
  const ui = props.ui
  const [range, setRange] = createSignal<StatsRange>("7d")
  const [scope, setScope] = createSignal<StatsScope>("all")
  const [nonce, setNonce] = createSignal(0)
  const [stats, setStats] = createSignal<SessionStatsInfo | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [failed, setFailed] = createSignal(false)
  const [toolReport, setToolReport] = createSignal<StatsToolDetail | null>(null)
  const [toolsLoading, setToolsLoading] = createSignal(false)
  const [toolsFailed, setToolsFailed] = createSignal(false)
  let seenNonce = 0

  createEffect(() => {
    const current = range()
    const currentScope = scope()
    const refresh = nonce() !== seenNonce
    seenNonce = nonce()
    let cancelled = false
    setLoading(true)
    setFailed(false)
    setToolReport(null)
    setToolsFailed(false)
    void loadStats(props.session, current, currentScope, refresh)
      .then((value) => {
        if (cancelled) return
        setStats(value)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setStats(null)
        setFailed(true)
        setLoading(false)
      })
    onCleanup(() => {
      cancelled = true
    })
  })

  const tokens = () => stats()?.tokens
  const totalTokens = () => contextTokens(tokens())
  const cacheHit = () => {
    const current = tokens()
    const total = (current?.input ?? 0) + (current?.cache?.read ?? 0) + (current?.cache?.write ?? 0)
    return total > 0 ? (current?.cache?.read ?? 0) / total : null
  }
  const costPerMillion = () =>
    totalTokens() > 0 ? ((stats()?.cost ?? 0) / totalTokens()) * 1_000_000 : null
  const reasoningShare = () => {
    const current = tokens()
    const produced = (current?.output ?? 0) + (current?.reasoning ?? 0)
    return produced > 0 ? (current?.reasoning ?? 0) / produced : null
  }
  const toolSuccess = () => {
    const tools = stats()?.tools
    if (!tools || tools.mode !== "summary") return null
    const total = tools.totals.succeeded + tools.totals.failed
    return total > 0 ? tools.totals.succeeded / total : null
  }
  const topModels = () =>
    (stats()?.models ?? [])
      .slice()
      .sort((a, b) => contextTokens(b.tokens) - contextTokens(a.tokens))
      .slice(0, 5)
  const tokenParts = () => {
    const current = tokens()
    const parts = [
      { key: "input", label: "Input", color: TOKEN_COLORS.input, value: current?.input ?? 0 },
      {
        key: "output",
        label: "Output",
        color: TOKEN_COLORS.output,
        value: (current?.output ?? 0) + (current?.reasoning ?? 0),
      },
      { key: "cacheRead", label: "Cache read", color: TOKEN_COLORS.cacheRead, value: current?.cache?.read ?? 0 },
      { key: "cacheWrite", label: "Cache write", color: TOKEN_COLORS.cacheWrite, value: current?.cache?.write ?? 0 },
    ]
    const total = parts.reduce((sum, part) => sum + part.value, 0)
    return parts.map((part) => ({ ...part, share: total > 0 ? part.value / total : 0 }))
  }
  const perSession = (value: number | undefined) => {
    const sessions = stats()?.sessions ?? 0
    return sessions > 0 && value !== undefined ? value / sessions : null
  }
  const loadToolDetail = async () => {
    const current = stats()
    if (!current || toolsLoading()) return
    setToolsLoading(true)
    setToolsFailed(false)
    try {
      const project = scope() === "project" ? props.session.project?.id : undefined
      const value = await props.session.server.client.experimental.session.stats({
        from: current.range.from,
        to: current.range.to,
        project,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tools: "detail",
      })
      setToolReport(value.tools.mode === "detail" ? value.tools : null)
    } catch {
      setToolsFailed(true)
    } finally {
      setToolsLoading(false)
    }
  }

  return (
    <ui.Dialog
      title="Usage stats"
      size="large"
      footer={
        <ui.Button variant="contrast" onClick={props.close}>
          Close
        </ui.Button>
      }
    >
      <div style={{ display: "grid", gap: "12px" }}>
        <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap", "align-items": "center" }}>
          {STATS_RANGES.map((item) => (
            <ui.Button
              variant={range() === item.id ? "contrast" : "neutral"}
              size="small"
              onClick={() => setRange(item.id)}
            >
              {item.label}
            </ui.Button>
          ))}
          <Show when={props.session.project}>
            <div style={{ display: "flex", gap: "4px" }}>
              <ui.Button
                variant={scope() === "all" ? "contrast" : "neutral"}
                size="small"
                onClick={() => setScope("all")}
              >
                All projects
              </ui.Button>
              <ui.Button
                variant={scope() === "project" ? "contrast" : "neutral"}
                size="small"
                onClick={() => setScope("project")}
              >
                {props.session.project?.name || "This project"}
              </ui.Button>
            </div>
          </Show>
          <ui.Button variant="ghost" size="small" icon="refresh" onClick={() => setNonce((value) => value + 1)}>
            Refresh
          </ui.Button>
        </div>

        <Show when={!loading()} fallback={<ui.Loader size="normal" />}>
          <Show
            when={stats()}
            fallback={
              <div style={{ "font-size": "12px", opacity: 0.55 }}>
                {failed() ? "Could not load usage stats." : "No usage in this range."}
              </div>
            }
          >
            {(data) => (
              <div style={{ display: "grid", gap: "12px" }}>
                <div style={{ "font-size": "11px", opacity: 0.5 }}>
                  {new Date(data().range.from).toLocaleDateString()} –{" "}
                  {new Date(data().range.to).toLocaleDateString()}
                </div>

                <div style={{ display: "grid", "grid-template-columns": "repeat(4, minmax(0, 1fr))", gap: "6px" }}>
                  <BigStat label="Prompts" value={String(data().prompts)} />
                  <BigStat label="Steps" value={String(data().steps)} />
                  <BigStat label="Sessions" value={String(data().sessions)} />
                  <BigStat label="Active days" value={String(data().activeDays)} />
                  <BigStat label="Tokens" value={fmtTokens(totalTokens())} />
                  <BigStat label="Cost" value={fmtCost(data().cost)} />
                  <BigStat label="Cache hit" value={fmtRatio(cacheHit())} />
                  <BigStat label="$ / 1M" value={costPerMillion() !== null ? fmtCost(costPerMillion()!) : "—"} />
                  <BigStat label="Reasoning" value={fmtRatio(reasoningShare())} />
                  <BigStat label="Tool success" value={fmtRatio(toolSuccess())} />
                  <BigStat label="Subagents" value={String(data().subagents)} />
                  <BigStat label="Streak" value={`${data().streak}d`} />
                </div>

                <Show when={totalTokens() > 0}>
                  <div style={{ display: "grid", gap: "5px" }}>
                    <SectionLabel>Token mix</SectionLabel>
                    <div
                      style={{
                        display: "flex",
                        height: "8px",
                        width: "100%",
                        overflow: "hidden",
                        "border-radius": "999px",
                        background: "color-mix(in srgb, currentColor 8%, transparent)",
                      }}
                    >
                      <For each={tokenParts().filter((part) => part.value > 0)}>
                        {(part) => (
                          <div
                            style={{ width: `${part.share * 100}%`, background: part.color }}
                            title={`${part.label}: ${fmtTokens(part.value)} (${Math.round(part.share * 100)}%)`}
                          />
                        )}
                      </For>
                    </div>
                    <div
                      style={{
                        display: "grid",
                        "grid-template-columns": "1fr 1fr",
                        gap: "3px 16px",
                        "font-size": "10px",
                      }}
                    >
                      <For each={tokenParts()}>
                        {(part) => (
                          <div style={{ display: "flex", "justify-content": "space-between", gap: "8px" }}>
                            <span style={{ display: "flex", "align-items": "center", gap: "5px", opacity: 0.65 }}>
                              <span
                                style={{
                                  width: "7px",
                                  height: "7px",
                                  "border-radius": "2px",
                                  background: part.color,
                                  "flex-shrink": 0,
                                }}
                              />
                              {part.label}
                            </span>
                            <span style={{ opacity: 0.5, "white-space": "nowrap" }}>
                              {fmtTokens(part.value)} · {Math.round(part.share * 100)}%
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                <div style={{ display: "grid", gap: "5px" }}>
                  <SectionLabel>Efficiency</SectionLabel>
                  <div
                    style={{
                      display: "grid",
                      "grid-template-columns": "repeat(3, minmax(0, 1fr))",
                      gap: "6px",
                    }}
                  >
                    <BigStat
                      label="Cost / session"
                      value={
                        perSession(data().cost) !== null ? fmtCost(perSession(data().cost)!) : "—"
                      }
                    />
                    <BigStat
                      label="Tokens / session"
                      value={
                        perSession(totalTokens()) !== null ? fmtTokens(perSession(totalTokens())!) : "—"
                      }
                    />
                    <BigStat
                      label="Steps / session"
                      value={
                        perSession(data().steps) !== null
                          ? perSession(data().steps)!.toFixed(1)
                          : "—"
                      }
                    />
                  </div>
                </div>

                <ResponsePerformance
                  ui={ui}
                  session={props.session}
                  from={data().range.from}
                  to={data().range.to}
                  rangeLabel={range()}
                />

                <div style={{ display: "grid", gap: "4px" }}>
                  <SectionLabel>Top models</SectionLabel>
                  {topModels().map((model) => (
                    <div
                      style={{
                        display: "flex",
                        "justify-content": "space-between",
                        gap: "8px",
                        "font-size": "11px",
                      }}
                    >
                      <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                        {model.model.providerID}/{model.model.id}
                      </span>
                      <span style={{ opacity: 0.6, "white-space": "nowrap" }}>
                        {fmtTokens(contextTokens(model.tokens))} · {fmtCost(model.cost)}
                      </span>
                    </div>
                  ))}
                </div>

                <TokenActivity
                  session={props.session}
                  stats={data()}
                  range={range()}
                  scope={scope()}
                  refreshNonce={nonce()}
                />

                <div style={{ display: "grid", gap: "5px" }}>
                  <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", gap: "8px" }}>
                    <SectionLabel>Tool detail</SectionLabel>
                    <Show when={!toolReport()}>
                      <ui.Button
                        size="small"
                        variant="ghost"
                        onClick={() => void loadToolDetail()}
                        disabled={toolsLoading()}
                      >
                        {toolsLoading() ? "Loading…" : toolsFailed() ? "Retry" : "Load"}
                      </ui.Button>
                    </Show>
                  </div>
                  <Show when={toolReport()}>
                    {(report) => {
                      const completed = () => report().totals.succeeded + report().totals.failed
                      return (
                        <div style={{ display: "grid", gap: "4px" }}>
                          <div style={{ "font-size": "10px", opacity: 0.55 }}>
                            {report().totals.calls} calls ·{" "}
                            {completed() > 0 ? fmtRatio(report().totals.succeeded / completed()) : "—"} success ·{" "}
                            {report().totals.failed} failed · {report().totals.unfinished} unfinished
                          </div>
                          <For each={report().usage.filter((tool) => tool.calls > 0).slice(0, 8)}>
                            {(tool) => (
                              <div
                                style={{
                                  display: "flex",
                                  "justify-content": "space-between",
                                  gap: "8px",
                                  "font-size": "10px",
                                }}
                              >
                                <span
                                  style={{
                                    overflow: "hidden",
                                    "text-overflow": "ellipsis",
                                    "white-space": "nowrap",
                                  }}
                                >
                                  {tool.name}
                                </span>
                                <span style={{ opacity: 0.5, "white-space": "nowrap" }}>
                                  {tool.calls} · p50{" "}
                                  {tool.durationP50 !== undefined ? fmtDuration(tool.durationP50) : "—"}
                                </span>
                              </div>
                            )}
                          </For>
                        </div>
                      )
                    }}
                  </Show>
                  <Show when={toolsFailed() && !toolReport()}>
                    <div style={{ "font-size": "10px", opacity: 0.55 }}>Could not load tool detail.</div>
                  </Show>
                </div>
              </div>
            )}
          </Show>
        </Show>
      </div>
    </ui.Dialog>
  )
}

function SettingsCard(props: { title: string; description?: string; children: JSX.Element }) {
  return (
    <div
      style={{
        display: "grid",
        gap: "10px",
        padding: "14px 16px",
        "border-radius": "10px",
        background: "color-mix(in srgb, currentColor 4%, transparent)",
        border: "1px solid color-mix(in srgb, currentColor 8%, transparent)",
        "box-sizing": "border-box",
      }}
    >
      <div style={{ display: "grid", gap: "3px" }}>
        <div style={{ "font-size": "15px", "font-weight": 600 }}>{props.title}</div>
        {props.description ? (
          <div style={{ "font-size": "12px", opacity: 0.5, "line-height": 1.5 }}>{props.description}</div>
        ) : null}
      </div>
      {props.children}
    </div>
  )
}

function UsageSettings(props: {
  ui: Context["ui"]
  prefs: () => Prefs
  set: (patch: Partial<Prefs>) => void
}) {
  const ui = props.ui
  const prefs = props.prefs
  const set = props.set
  const option = (label: string, active: boolean, onClick: () => void) => (
    <ui.Button variant={active ? "contrast" : "neutral"} size="small" onClick={onClick}>
      {label}
    </ui.Button>
  )
  return (
    <div
      style={{
        display: "grid",
        gap: "12px",
        padding: "24px 24px 48px",
        "max-width": "760px",
        width: "100%",
        margin: "0 auto",
        "box-sizing": "border-box",
      }}
    >
      <div style={{ display: "grid", gap: "3px" }}>
        <div style={{ "font-size": "20px", "font-weight": 600 }}>Usage</div>
        <div style={{ "font-size": "12px", opacity: 0.5 }}>Preferences for the sidebar usage panel.</div>
      </div>

      <SettingsCard title="Quota display" description="Show used or remaining quota in the panel.">
        <div style={{ display: "flex", "justify-content": "flex-end", gap: "6px" }}>
          {option("Used", prefs().display === "used", () => set({ display: "used" }))}
          {option("Remaining", prefs().display === "remaining", () => set({ display: "remaining" }))}
        </div>
      </SettingsCard>

      <SettingsCard title="Thresholds" description="Colors change at these used percentages.">
        <div style={{ display: "grid", gap: "8px" }}>
          <div
            style={{
              display: "grid",
              "grid-template-columns": "minmax(0, 1fr) auto",
              "align-items": "center",
              gap: "12px",
            }}
          >
            <span style={{ "font-size": "13px" }}>Warning</span>
            <div style={{ display: "flex", gap: "6px" }}>
              {[50, 60, 75].map((value) =>
                option(`${value}%`, prefs().warn === value, () => set({ warn: value })),
              )}
            </div>
          </div>
          <div
            style={{
              display: "grid",
              "grid-template-columns": "minmax(0, 1fr) auto",
              "align-items": "center",
              gap: "12px",
            }}
          >
            <span style={{ "font-size": "13px" }}>Danger</span>
            <div style={{ display: "flex", gap: "6px" }}>
              {[80, 90, 95].map((value) =>
                option(`${value}%`, prefs().danger === value, () => set({ danger: value })),
              )}
            </div>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="Live metrics" description="Sparkline and quota notifications.">
        <div style={{ display: "grid", gap: "10px" }}>
          <div
            style={{
              display: "grid",
              "grid-template-columns": "minmax(0, 1fr) auto",
              "align-items": "center",
              gap: "12px",
            }}
          >
            <div style={{ display: "grid", gap: "2px" }}>
              <span style={{ "font-size": "13px" }}>Live TPS sparkline</span>
              <span style={{ "font-size": "11px", opacity: 0.5 }}>
                Bars show generation speed over the selected window (30 s to 15 min). Gaps mean no tokens were produced.
              </span>
            </div>
            <ui.Switch
              checked={prefs().live}
              onChange={(value) => set({ live: value })}
              label="Live TPS sparkline"
              hideLabel
            />
          </div>
          <div
            style={{
              display: "grid",
              "grid-template-columns": "minmax(0, 1fr) auto",
              "align-items": "center",
              gap: "12px",
            }}
          >
            <div style={{ display: "grid", gap: "2px" }}>
              <span style={{ "font-size": "13px" }}>Quota notifications</span>
              <span style={{ "font-size": "11px", opacity: 0.5 }}>
                Notify when a quota reaches the danger threshold.
              </span>
            </div>
            <ui.Switch
              checked={prefs().notify}
              onChange={(value) => set({ notify: value })}
              label="Quota notifications"
              hideLabel
            />
          </div>
        </div>
      </SettingsCard>
    </div>
  )
}

const usageTab: PanelTab = {
  id: "usage",
  get title() {
    return "Usage"
  },
  pinned: true,
  fallback: true,
}

export default Plugin.define({
  stores: {
    prefs: Store.global(Preferences, DEFAULT_PREFS),
  },
  setup(ctx) {
    const [now, setNow] = createSignal(Date.now())
    const [remote, setRemote] = createSignal<UsageSnapshot | null>(null)
    const metrics = new Metrics()
    const [liveNow, setLiveNow] = createSignal(Date.now())
    let lastSync = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    let refreshing = false

    const sync = () => {
      const session = ctx.sessions.current()
      if (!session) return
      lastSync = Date.now()
      void session.server.data.location.usage.sync(session.location).catch(() => {})
    }

    const [remoteError, setRemoteError] = createSignal(false)

    const refreshRemote = async () => {
      if (refreshing) return
      refreshing = true
      try {
        const session = ctx.sessions.current()
        let raw: UsageSnapshot | undefined
        if (session) {
          try {
            raw = (await session.server.client
              .rpc(UsageRpc)
              .get({}, session.location ? { location: session.location } : undefined)) as UsageSnapshot
          } catch {
            raw = undefined
          }
        }
        if (!raw) raw = (await ctx.client.rpc(UsageRpc).get({})) as UsageSnapshot
        if (raw && typeof raw.available === "boolean") {
          setRemote(raw)
          setRemoteError(false)
          if (retry) {
            clearTimeout(retry)
            retry = undefined
          }
        }
      } catch {
        setRemoteError(true)
        if (!retry) {
          retry = setTimeout(() => {
            retry = undefined
            void refreshRemote()
          }, 2_000)
        }
      } finally {
        refreshing = false
      }
    }

    const refreshAll = () => {
      sync()
      void refreshRemote()
    }

    void refreshRemote()
    const remoteTimer = setInterval(() => void refreshRemote(), POLL_MS)
    onCleanup(() => {
      clearInterval(remoteTimer)
      if (retry) clearTimeout(retry)
    })

    const timer = setInterval(() => {
      setNow(Date.now())
      if (Date.now() - lastSync >= POLL_MS - 5_000) sync()
    }, 15_000)
    onCleanup(() => clearInterval(timer))

    const liveTimer = setInterval(() => setLiveNow(Date.now()), 500)
    onCleanup(() => clearInterval(liveTimer))

    const snapshot = () => {
      const session = ctx.sessions.current()
      return session
        ? metrics.read(session.id, liveNow(), LIVE_CHART_MS, LIVE_CHART_BUCKETS)
        : undefined
    }

    createEffect(() => {
      const session = ctx.sessions.current()
      if (!session) return
      void session.server.data.location.usage.sync(session.location).catch(() => {})
      void refreshRemote()
    })

    createKeyed(
      () => ctx.sessions.current()?.server.data,
      (data) => {
        const handle = (event: { type: string; created: number; data: any }) => {
          metrics.onEvent(event)
        }
        const types = [
          "session.execution.started",
          "session.execution.succeeded",
          "session.execution.failed",
          "session.execution.interrupted",
          "session.step.started",
          "session.step.ended",
          "session.step.failed",
          "session.text.started",
          "session.text.delta",
          "session.reasoning.started",
          "session.reasoning.delta",
          "session.tool.input.started",
          "session.idle",
        ] as const
        for (const type of types) {
          onCleanup(data.on(type as any, handle as any))
        }
      },
    )

    const notified = new Set<string>()
    createEffect(() => {
      const prefs = ctx.stores.prefs.value
      if (!prefs.notify) return
      const session = ctx.sessions.current()
      if (!session) return
      const plan = goMeters(remote(), limitsFor(session))
      if (!plan) return
      const meters = [
        ["5h", plan.go.rolling],
        ["1w", plan.go.weekly],
        ["1mo", plan.go.monthly],
      ] as const
      for (const [label, meter] of meters) {
        if (!meter.limited && meter.percent < prefs.danger) continue
        const key = `${session.id}:${label}:${meter.limited ? "limited" : Math.floor(meter.percent / 10)}`
        if (notified.has(key)) continue
        notified.add(key)
        if (notified.size > 200) {
          const first = notified.values().next().value
          if (first) notified.delete(first)
        }
        void ctx.attention.notify({
          title: meter.limited ? "OpenCode quota limited" : "OpenCode quota warning",
          message: `${plan.label}: ${label} at ${Math.round(meter.percent)}%`,
          variant: "error",
          session: { server: session.server.id, id: session.id },
          id: key,
        })
      }
    })

    const openPanel = (session: MountedSession) => {
      ctx.layout.open(`${ctx.id}:usage`, session, { background: true })
    }

    ctx.add(Command, () => ({
      id: "open",
      title: "Usage: open details",
      keywords: "quota usage tokens cost limits performance ttft tps",
      run: () => {
        const session = ctx.sessions.current()
        if (session) openPanel(session)
      },
    }))

    ctx.add(Command, () => ({
      id: "refresh",
      title: "Usage: refresh",
      keywords: "quota usage tokens cost limits refresh",
      run: () => refreshAll(),
    }))

    ctx.add(Command, () => ({
      id: "copy",
      title: "Usage: copy performance metrics",
      keywords: "ttft tps performance metrics copy json",
      run: () => {
        const session = ctx.sessions.current()
        if (!session) return
        const perf = performanceFor(session)
        const snapshot = metrics.read(session.id, Date.now(), LIVE_CHART_MS, LIVE_CHART_BUCKETS)
        void ctx.system.copy(
          JSON.stringify(
            {
              session: session.id,
              sparkWindowMs: LIVE_CHART_MS,
              sparkBuckets: LIVE_CHART_BUCKETS,
              metrics: snapshot,
              ...perf,
            },
            null,
            2,
          ),
        )
        ctx.toast.show({ variant: "success", title: "Usage metrics copied" })
      },
    }))

    ctx.add(Command, () => ({
      id: "stats",
      title: "Usage: open stats",
      keywords: "usage stats 7d 30d 90d all tokens cost cache tools ttft tps performance",
      run: () => {
        const session = ctx.sessions.current()
        if (!session) return
        ctx.dialogs.open((dialog) => (
          <StatsDialog ui={ctx.ui} session={session} close={dialog.close} />
        ))
      },
    }))

    ctx.add(MenuItem, {
      menu: "session.panel",
      id: "usage",
      title: "Usage",
      icon: "window-analytics",
      order: 10,
      run: () => {
        const session = ctx.sessions.current()
        if (session) openPanel(session)
      },
    })

    ctx.add(SettingsPage, {
      id: "usage",
      title: "Usage",
      icon: "window-analytics",
      entries: [
        { id: "display", title: "Quota display", keywords: "used remaining" },
        { id: "thresholds", title: "Thresholds", keywords: "warning danger" },
        { id: "live", title: "Live TPS", keywords: "sparkline performance" },
      ],
      render: () => (
        <UsageSettings
          ui={ctx.ui}
          prefs={() => ctx.stores.prefs.value}
          set={(patch) => {
            ctx.stores.prefs.update((draft) => {
              Object.assign(draft, patch)
            })
          }}
        />
      ),
    })

    ctx.add(Panel, {
      id: "usage",
      region: "side",
      list: () => [usageTab],
      render: (props) => (
        <UsagePanel
          ctx={ctx}
          session={props.session}
          snapshot={snapshot()}
          prefs={ctx.stores.prefs.value}
          setPrefs={(patch) => {
            ctx.stores.prefs.update((draft) => {
              Object.assign(draft, patch)
            })
          }}
          remote={remote()}
          remoteError={remoteError()}
          limits={limitsFor(props.session)}
          info={infoFor(props.session)}
          now={now()}
          refresh={refreshAll}
        />
      ),
    })
  },
})
