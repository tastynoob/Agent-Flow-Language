import type {
  AgentAdapter,
  CapabilityAdapter,
  CapabilityRequest,
  PromptArgument,
  ScriptAdapter,
  ScriptRequest,
  VmBindings,
} from "./adapters.js";
import type { AgentExecutorBackend } from "./agent-executor.js";
import { frag, isComputeValue, isFrag, type ComputeValue, type Frag, type SymbolRef } from "./ir.js";
import {
  PiAgentExecutorBackend,
  createPiCodingAgentBinding,
  type PiAgentBinding,
  type PiAgentExecutorOptions,
  type PiBubblewrapSandboxOptions,
  type PiCodingAgentBindingOptions,
} from "./pi-agent-executor.js";

type PiModelSelection = PiCodingAgentBindingOptions["model"];
type PiThinkingLevel = NonNullable<PiCodingAgentBindingOptions["thinkingLevel"]>;

export interface PiRuntimeProfile {
  readonly model?: string | PiModelSelection;
  readonly systemPrompt?: string;
  readonly thinking?: PiThinkingLevel;
  readonly replayThinking?: boolean;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly maxRetryDelayMs?: number;
  readonly cacheRetention?: NonNullable<PiCodingAgentBindingOptions["streamOptions"]>["cacheRetention"];
  readonly bashTimeoutSeconds?: number;
  readonly elevation?: boolean;
  readonly sandbox?: false | "bubblewrap" | PiBubblewrapSandboxOptions;
}

export interface PiRuntimeOptions extends PiRuntimeProfile {
  readonly model: string | PiModelSelection;
  readonly agents?: Readonly<Record<`@${string}`, PiRuntimeProfile>>;
  readonly models?: PiAgentExecutorOptions["models"];
}

export interface CapabilityHandlerContext {
  readonly capability: `@${string}`;
  readonly runId: string;
  readonly node: string;
  readonly block: string;
  readonly executionRoot: string;
  readonly signal: AbortSignal;
}

export type CapabilityHandlerResult = ComputeValue | Frag;
export type CapabilityHandler = (
  context: CapabilityHandlerContext,
  ...args: ComputeValue[]
) => CapabilityHandlerResult | Promise<CapabilityHandlerResult>;
export type CapabilityDefinitions = Readonly<Record<`@${string}`, CapabilityHandler>>;

export type FriendlyVmBindings = Omit<VmBindings, "agents" | "agentExecutor" | "capabilities" | "scripts"> & {
  readonly agents?: AgentAdapter | AgentExecutorBackend;
  readonly agentExecutor?: AgentExecutorBackend;
  readonly capabilities?: CapabilityAdapter | CapabilityDefinitions;
  readonly scripts?: ScriptAdapter | "typescript";
};

export function defineBindings(options: FriendlyVmBindings): VmBindings {
  const runtime = options.agents !== undefined && isAgentExecutorBackend(options.agents)
    ? options.agents
    : undefined;
  if (runtime !== undefined && options.agentExecutor !== undefined) {
    throw new TypeError("defineBindings cannot receive both an Agent executor in 'agents' and 'agentExecutor'");
  }
  const capabilities = options.capabilities === undefined
    ? undefined
    : isCapabilityAdapter(options.capabilities)
      ? options.capabilities
      : defineCapabilities(options.capabilities);
  const scripts = options.scripts === "typescript" ? trustedTypescript() : options.scripts;
  const {
    agents: _agents,
    agentExecutor: _agentExecutor,
    capabilities: _capabilities,
    scripts: _scripts,
    ...rest
  } = options;
  return {
    ...rest,
    ...(runtime === undefined
      ? options.agents === undefined ? {} : { agents: options.agents as AgentAdapter }
      : { agentExecutor: runtime }),
    ...(runtime === undefined && options.agentExecutor !== undefined
      ? { agentExecutor: options.agentExecutor }
      : {}),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(scripts === undefined ? {} : { scripts }),
  };
}

export function pi(options: PiRuntimeOptions): AgentExecutorBackend {
  const defaultBinding = piBinding(options, options.model);
  const agents = options.agents === undefined
    ? undefined
    : Object.fromEntries(Object.entries(options.agents).map(([name, profile]) => [
        name,
        piBinding({ ...options, ...profile }, profile.model ?? options.model),
    ])) as Readonly<Record<string, PiAgentBinding<any>>>;
  return new PiAgentExecutorBackend({
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(agents === undefined ? {} : { agents }),
    defaultBinding,
  });
}

export function defineCapabilities(definitions: CapabilityDefinitions): CapabilityAdapter {
  const handlers = new Map(Object.entries(definitions));
  return {
    async invoke(request: CapabilityRequest): Promise<string | Frag> {
      const handler = handlers.get(request.capability.name);
      if (handler === undefined) {
        throw new Error(`No capability handler is configured for '${request.capability.name}'`);
      }
      const context: CapabilityHandlerContext = Object.freeze({
        capability: request.capability.name,
        runId: request.runId,
        node: request.node,
        block: request.block,
        executionRoot: request.executionRoot,
        signal: request.signal,
      });
      const result = await handler(context, ...request.args.map(capabilityArgumentValue));
      if (isFrag(result)) return result;
      if (!isComputeValue(result)) {
        throw new TypeError(`Capability '${request.capability.name}' returned a non-portable value`);
      }
      return typeof result === "string" ? result : frag(JSON.stringify(result), "formatted");
    },
  };
}

export function trustedTypescript(): ScriptAdapter {
  return Object.freeze({
    execute(request: ScriptRequest) {
      if (request.language !== "typescript") {
        throw new Error(`trustedTypescript does not execute '${request.language}' scripts`);
      }
      return Function("args", `"use strict";\n${request.source}`)(request.args) as ComputeValue;
    },
  });
}

function piBinding(profile: PiRuntimeProfile, fallbackModel: string | PiModelSelection): PiAgentBinding<any> {
  const model = parsePiModel(profile.model ?? fallbackModel);
  const sandbox = profile.sandbox === "bubblewrap"
    ? { backend: "bubblewrap" as const, network: "none" as const }
    : profile.sandbox;
  const streamOptions = profile.timeoutMs === undefined && profile.maxRetries === undefined &&
      profile.maxRetryDelayMs === undefined && profile.cacheRetention === undefined
    ? undefined
    : {
        ...(profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs }),
        ...(profile.maxRetries === undefined ? {} : { maxRetries: profile.maxRetries }),
        ...(profile.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: profile.maxRetryDelayMs }),
        ...(profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention }),
      };
  return createPiCodingAgentBinding({
    model,
    ...(profile.systemPrompt === undefined ? {} : { systemPrompt: profile.systemPrompt }),
    ...(profile.thinking === undefined ? {} : { thinkingLevel: profile.thinking }),
    ...(profile.replayThinking === undefined
      ? {}
      : { thinkingReplay: profile.replayThinking ? "include" : "exclude" }),
    ...(streamOptions === undefined ? {} : { streamOptions }),
    ...(profile.bashTimeoutSeconds === undefined ? {} : { bashTimeoutSeconds: profile.bashTimeoutSeconds }),
    ...(profile.elevation === undefined ? {} : { elevation: profile.elevation }),
    ...(sandbox === undefined ? {} : { sandbox }),
  });
}

function parsePiModel(model: string | PiModelSelection): PiModelSelection {
  if (typeof model !== "string") return model;
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new TypeError("Pi model strings must use 'provider/model' format");
  }
  return { provider: model.slice(0, separator), id: model.slice(separator + 1) };
}

function capabilityArgumentValue(value: PromptArgument): ComputeValue {
  if (isFrag(value)) return value.content;
  if (isSymbol(value)) return value.name;
  return structuredClone(value);
}

function isSymbol(value: PromptArgument): value is SymbolRef {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    "kind" in value && value.kind === "symbol";
}

function isAgentExecutorBackend(value: AgentAdapter | AgentExecutorBackend): value is AgentExecutorBackend {
  return "execute" in value && typeof value.execute === "function";
}

function isCapabilityAdapter(value: CapabilityAdapter | CapabilityDefinitions): value is CapabilityAdapter {
  return "invoke" in value && typeof value.invoke === "function";
}
