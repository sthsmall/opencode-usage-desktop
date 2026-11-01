import { Rpc } from "@opencode/plugin/rpc"

export type UsageMeter = {
  percent: number
  limited: boolean
  resetsAt: number
}

export type UsageSnapshot = {
  available: boolean
  source: string
  workspace: string
  rolling: UsageMeter
  weekly: UsageMeter
  monthly: UsageMeter
  fetchedAt: number
}

const meter = {
  type: "object",
  properties: {
    percent: { type: "number" },
    limited: { type: "boolean" },
    resetsAt: { type: "number" },
  },
  required: ["percent", "limited", "resetsAt"],
  additionalProperties: false,
} as const

export const UsageRpc = Rpc.define({
  id: "opencode-usage-desktop.usage",
  events: {},
  methods: {
    get: {
      input: { type: "object", additionalProperties: false } as const,
      output: {
        type: "object",
        properties: {
          available: { type: "boolean" },
          source: { type: "string" },
          workspace: { type: "string" },
          rolling: meter,
          weekly: meter,
          monthly: meter,
          fetchedAt: { type: "number" },
        },
        required: ["available", "source", "workspace", "rolling", "weekly", "monthly", "fetchedAt"],
        additionalProperties: false,
      } as const,
    },
  },
})
