import { Plugin } from "@opencode/plugin"
import { UsageRpc } from "./rpc.js"

type RawMeter = {
  percent?: number
  status?: string
  resetsAt?: string
}

type RawUsage = {
  usage?: {
    rolling?: RawMeter
    weekly?: RawMeter
    monthly?: RawMeter
  }
}

const ZERO = { percent: 0, limited: false, resetsAt: 0 }

function toMeter(raw: RawMeter | undefined) {
  const percent = Number(raw?.percent)
  const resetsAt = raw?.resetsAt ? Date.parse(String(raw.resetsAt)) : 0
  return {
    percent: Number.isFinite(percent) ? percent : 0,
    limited: raw?.status === "rate-limited",
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : 0,
  }
}

async function readUsage(ctx: Parameters<NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>>[0], id: string) {
  const connection = await ctx.integration.connection.active(id)
  if (!connection) return undefined
  const credential = await ctx.integration.connection.resolve(connection)
  if (!credential || credential.type === "external") return undefined

  const key = credential.type === "oauth" ? credential.access : credential.key
  if (!key) return undefined

  const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
  const orgID = credential.metadata?.orgID
  if (typeof orgID === "string" && orgID) headers["x-opencode-org-id"] = orgID

  const response = await fetch("https://opencode.ai/zen/go/v1/usage", {
    headers,
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) return undefined

  const body = (await response.json()) as RawUsage
  const usage = body?.usage
  if (!usage) return undefined

  return {
    available: true,
    source: id,
    workspace: typeof credential.metadata?.orgName === "string" ? credential.metadata.orgName : "",
    rolling: toMeter(usage.rolling),
    weekly: toMeter(usage.weekly),
    monthly: toMeter(usage.monthly),
    fetchedAt: Date.now(),
  }
}

export default Plugin.define({
  id: "opencode-usage-desktop",
  async setup(ctx) {
    await ctx.rpc.register(UsageRpc, {
      get: async () => {
        let failed = false
        for (const id of ["opencode-go", "opencode"]) {
          try {
            const usage = await readUsage(ctx, id)
            if (usage) return usage
          } catch {
            // A network or parsing failure is retryable; try the next integration, then surface it.
            failed = true
          }
        }
        if (failed) throw new Error("usage request failed")
        return {
          available: false,
          source: "",
          workspace: "",
          rolling: ZERO,
          weekly: ZERO,
          monthly: ZERO,
          fetchedAt: Date.now(),
        }
      },
    })
  },
})
