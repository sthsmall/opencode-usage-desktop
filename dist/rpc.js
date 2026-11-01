import { Rpc } from "@opencode/plugin/rpc";
const meter = {
    type: "object",
    properties: {
        percent: { type: "number" },
        limited: { type: "boolean" },
        resetsAt: { type: "number" },
    },
    required: ["percent", "limited", "resetsAt"],
    additionalProperties: false,
};
export const UsageRpc = Rpc.define({
    id: "opencode-usage-desktop.usage",
    events: {},
    methods: {
        get: {
            input: { type: "object", additionalProperties: false },
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
            },
        },
    },
});
