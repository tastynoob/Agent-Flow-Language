import { Type } from "@earendil-works/pi-ai";
import {
  AflVm,
  MemoryTraceSink,
  PiAgentExecutorBackend,
} from "../dist/src/index.js";

if (process.env.DEEPSEEK_API_KEY === undefined) {
  throw new Error("DEEPSEEK_API_KEY is required");
}

const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
let toolCalls = 0;
const echo = {
  name: "echo",
  label: "Echo",
  description: "Return the supplied value with a tool prefix.",
  parameters: Type.Object({ value: Type.String() }),
  async execute(_toolCallId, params) {
    toolCalls += 1;
    return {
      content: [{ type: "text", text: `tool:${params.value}` }],
      details: undefined,
    };
  },
};

const trace = new MemoryTraceSink();
const backend = new PiAgentExecutorBackend({
  defaultBinding: {
    model: { provider: "deepseek", id: model },
    tools: [echo],
    systemPrompt: "Follow the user's test instructions precisely and keep replies short.",
  },
});
const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.live
        first = worker.do "Call the echo tool exactly once with value pi-live. After the tool result, reply with PI_LIVE_OK and the returned value."
        second = worker.do "Do not call a tool. Reply exactly SESSION_OK if the previous task in this conversation used the echo tool; otherwise reply exactly SESSION_MISSING."
        ret second
`, { agentExecutor: backend, trace });

const result = await vm.run("main", [], { runId: "pi-deepseek-live" });
if (toolCalls !== 1) {
  throw new Error(`expected one tool call, received ${toolCalls}`);
}
if (!result.output.content.includes("SESSION_OK")) {
  throw new Error(`Pi session continuation failed: ${result.output.content}`);
}

const agentEvents = trace.events.filter((event) => event.type === "agent.event");
const usageEvents = agentEvents.filter((event) => event.details?.type === "usage.updated");
const completedTools = agentEvents.filter((event) => event.details?.type === "tool.completed");
process.stdout.write(`${JSON.stringify({
  model,
  output: result.output.content,
  toolCalls,
  completedToolEvents: completedTools.length,
  usageEvents: usageEvents.length,
})}\n`);
