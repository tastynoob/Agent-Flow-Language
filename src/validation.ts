import {
  FLOW_NODE_KINDS,
  type AflProgram,
  type DataSchema,
  type Expr,
  type FlowDefinition,
  type FlowNode,
  type FreedomConstraints,
  type FreedomPlan,
  type JsonPrimitive,
  type SlotTarget,
} from "./ir.js";
import { isJsonValue, isRecord, validateDataValue } from "./value.js";

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

const UNARY_OPERATORS = new Set(["not", "negate", "isNull"]);
const BINARY_OPERATORS = new Set([
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "and",
  "or",
  "add",
  "subtract",
  "multiply",
  "divide",
  "concat",
  "coalesce",
  "in",
]);
const PARALLEL_MODES = new Set(["all", "allSettled", "race"]);

interface FlowValidationContext {
  program: AflProgram;
  flow: FlowDefinition;
  path: string;
  nodeIds: Set<string>;
  issues: ValidationIssue[];
}

export function validateProgram(input: unknown): ValidationResult<AflProgram> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return failure("$", "PROGRAM_NOT_OBJECT", "program must be an object");
  }

  expectExactString(input.irVersion, "0.1", "$.irVersion", issues);
  expectNonEmptyString(input.name, "$.name", issues);
  expectNonEmptyString(input.entry, "$.entry", issues);
  if (input.metadata !== undefined && !isJsonRecord(input.metadata)) {
    issue(issues, "$.metadata", "PROGRAM_METADATA_INVALID", "metadata must be a JSON object");
  }

  const schemasValue = input.schemas ?? {};
  const schemaRecords: Record<string, unknown> = isRecord(schemasValue) ? schemasValue : {};
  if (!isRecord(schemasValue)) {
    issue(issues, "$.schemas", "SCHEMAS_NOT_OBJECT", "schemas must be an object");
  } else {
    for (const [name, schema] of Object.entries(schemasValue)) {
      expectNonEmptyString(name, `$.schemas.${name}`, issues);
      validateSchemaShape(schema, `$.schemas.${name}`, issues, schemasValue);
    }
    validateSchemaCycles(schemasValue, issues);
  }

  const agentsValue = input.agents ?? {};
  if (!isRecord(agentsValue)) {
    issue(issues, "$.agents", "AGENTS_NOT_OBJECT", "agents must be an object");
  } else {
    for (const [agentId, agent] of Object.entries(agentsValue)) {
      validateAgent(agentId, agent, `$.agents.${agentId}`, issues, schemaRecords);
    }
  }

  if (!isRecord(input.flows)) {
    issue(issues, "$.flows", "FLOWS_NOT_OBJECT", "flows must be a non-empty object");
  } else if (Object.keys(input.flows).length === 0) {
    issue(issues, "$.flows", "FLOWS_EMPTY", "at least one flow is required");
  }

  if (
    typeof input.entry === "string" &&
    isRecord(input.flows) &&
    !(input.entry in input.flows)
  ) {
    issue(
      issues,
      "$.entry",
      "ENTRY_FLOW_UNKNOWN",
      `entry flow '${input.entry}' is not declared`,
    );
  }

  if (issues.length > 0 || !isRecord(input.flows)) {
    return { ok: false, issues };
  }

  const program = input as unknown as AflProgram;
  for (const [flowId, flow] of Object.entries(input.flows)) {
    validateFlow(flowId, flow, `$.flows.${flowId}`, program, issues);
  }

  return issues.length === 0
    ? { ok: true, value: program, issues: [] }
    : { ok: false, issues };
}

export function assertValidProgram(input: unknown): AflProgram {
  const result = validateProgram(input);
  if (!result.ok) {
    throw new ProgramValidationError(result.issues);
  }
  return result.value;
}

export class ProgramValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(`AFL program is invalid (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "ProgramValidationError";
    this.issues = issues;
  }
}

export function validateFlowNode(
  program: AflProgram,
  flowId: string,
  input: unknown,
): ValidationResult<FlowNode> {
  const flow = program.flows[flowId];
  if (flow === undefined) {
    return failure("$", "FLOW_UNKNOWN", `flow '${flowId}' is not declared`);
  }
  const issues: ValidationIssue[] = [];
  const context: FlowValidationContext = {
    program,
    flow,
    path: "$",
    nodeIds: new Set(),
    issues,
  };
  validateNode(input, context, "$", 0);
  return issues.length === 0
    ? { ok: true, value: input as FlowNode, issues: [] }
    : { ok: false, issues };
}

export function validateFreedomPlan(
  program: AflProgram,
  currentFlowId: string,
  input: unknown,
  constraints: FreedomConstraints,
): ValidationResult<FreedomPlan> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return failure("$", "FREEDOM_PLAN_NOT_OBJECT", "freedom plan must be an object");
  }

  if (input.kind === "continuation") {
    const nodeResult = validateFlowNode(program, currentFlowId, input.body);
    if (!nodeResult.ok) {
      issues.push(...nodeResult.issues.map((item) => ({ ...item, path: `$.body${item.path.slice(1)}` })));
    } else {
      validateDynamicConstraints(nodeResult.value, constraints, "$.body", issues);
    }
  } else if (input.kind === "revision") {
    if (constraints.allowRevision !== true) {
      issue(
        issues,
        "$.kind",
        "FREEDOM_REVISION_NOT_ALLOWED",
        "freedom constraints do not allow revisions",
      );
    }
    if (!isJsonValue(input.input)) {
      issue(issues, "$.input", "FREEDOM_INPUT_INVALID", "revision input must be JSON");
    }
    const revisionName = "__freedom_revision__";
    const candidate: AflProgram = {
      ...program,
      entry: revisionName,
      flows: { ...program.flows, [revisionName]: input.flow as FlowDefinition },
    };
    const result = validateProgram(candidate);
    if (!result.ok) {
      issues.push(
        ...result.issues
          .filter((item) => item.path.startsWith(`$.flows.${revisionName}`))
          .map((item) => ({
            ...item,
            path: `$.flow${item.path.slice(`$.flows.${revisionName}`.length)}`,
          })),
      );
    } else {
      const flow = result.value.flows[revisionName];
      if (flow !== undefined) {
        validateDynamicConstraints(flow.body, constraints, "$.flow.body", issues);
        issues.push(
          ...validateDataValue(
            input.input,
            flow.input,
            program.schemas,
            "$.input",
          ),
        );
      }
    }
  } else {
    issue(
      issues,
      "$.kind",
      "FREEDOM_PLAN_KIND_INVALID",
      "freedom plan kind must be 'continuation' or 'revision'",
    );
  }

  return issues.length === 0
    ? { ok: true, value: input as unknown as FreedomPlan, issues: [] }
    : { ok: false, issues };
}

function validateAgent(
  agentId: string,
  input: unknown,
  path: string,
  issues: ValidationIssue[],
  schemas: Record<string, unknown>,
): void {
  expectNonEmptyString(agentId, path, issues);
  if (!isRecord(input)) {
    issue(issues, path, "AGENT_NOT_OBJECT", "agent declaration must be an object");
    return;
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    issue(issues, `${path}.description`, "AGENT_DESCRIPTION_INVALID", "description must be a string");
  }
  if (input.capabilities !== undefined) {
    validateStringArray(input.capabilities, `${path}.capabilities`, issues);
  }
  if (!isRecord(input.operations) || Object.keys(input.operations).length === 0) {
    issue(issues, `${path}.operations`, "AGENT_OPERATIONS_INVALID", "operations must be a non-empty object");
    return;
  }
  for (const [operationId, operation] of Object.entries(input.operations)) {
    const operationPath = `${path}.operations.${operationId}`;
    expectNonEmptyString(operationId, operationPath, issues);
    if (!isRecord(operation)) {
      issue(issues, operationPath, "AGENT_OPERATION_NOT_OBJECT", "operation must be an object");
      continue;
    }
    validateSchemaShape(operation.input, `${operationPath}.input`, issues, schemas);
    validateSchemaShape(operation.output, `${operationPath}.output`, issues, schemas);
  }
}

function validateFlow(
  flowId: string,
  input: unknown,
  path: string,
  program: AflProgram,
  issues: ValidationIssue[],
): void {
  expectNonEmptyString(flowId, path, issues);
  if (!isRecord(input)) {
    issue(issues, path, "FLOW_NOT_OBJECT", "flow definition must be an object");
    return;
  }
  validateSchemaShape(input.input, `${path}.input`, issues, program.schemas ?? {});
  validateSchemaShape(input.output, `${path}.output`, issues, program.schemas ?? {});
  validateSlots(input.state, `${path}.state`, issues, program.schemas ?? {});
  validateSlots(input.locals, `${path}.locals`, issues, program.schemas ?? {});
  if (issues.some((item) => item.path.startsWith(path) && item.code.startsWith("SCHEMA_"))) {
    return;
  }
  const flow = input as unknown as FlowDefinition;
  validateSlotInitials(flow.state, `${path}.state`, program, issues);
  validateSlotInitials(flow.locals, `${path}.locals`, program, issues);
  const context: FlowValidationContext = {
    program,
    flow,
    path,
    nodeIds: new Set(),
    issues,
  };
  validateNode(input.body, context, `${path}.body`, 0);
}

function validateSlots(
  input: unknown,
  path: string,
  issues: ValidationIssue[],
  schemas: Record<string, unknown>,
): void {
  if (input === undefined) {
    return;
  }
  if (!isRecord(input)) {
    issue(issues, path, "SLOTS_NOT_OBJECT", "slots must be an object");
    return;
  }
  for (const [name, slot] of Object.entries(input)) {
    const slotPath = `${path}.${name}`;
    expectNonEmptyString(name, slotPath, issues);
    if (!isRecord(slot)) {
      issue(issues, slotPath, "SLOT_NOT_OBJECT", "slot declaration must be an object");
      continue;
    }
    validateSchemaShape(slot.schema, `${slotPath}.schema`, issues, schemas);
    if (slot.initial !== undefined && !isJsonValue(slot.initial)) {
      issue(issues, `${slotPath}.initial`, "SLOT_INITIAL_NOT_JSON", "initial value must be JSON");
    }
  }
}

function validateSlotInitials(
  slots: Readonly<Record<string, { schema: DataSchema; initial?: unknown }>> | undefined,
  path: string,
  program: AflProgram,
  issues: ValidationIssue[],
): void {
  for (const [name, slot] of Object.entries(slots ?? {})) {
    if (slot.initial !== undefined) {
      issues.push(
        ...validateDataValue(
          slot.initial,
          slot.schema,
          program.schemas,
          `${path}.${name}.initial`,
        ),
      );
    }
  }
}

function validateNode(
  input: unknown,
  context: FlowValidationContext,
  path: string,
  depth: number,
): void {
  if (depth > 256) {
    issue(context.issues, path, "NODE_DEPTH_EXCEEDED", "node nesting exceeds 256");
    return;
  }
  if (!isRecord(input)) {
    issue(context.issues, path, "NODE_NOT_OBJECT", "node must be an object");
    return;
  }
  const id = expectNonEmptyString(input.id, `${path}.id`, context.issues);
  if (id !== undefined) {
    if (context.nodeIds.has(id)) {
      issue(context.issues, `${path}.id`, "NODE_ID_DUPLICATE", `duplicate node id '${id}'`);
    }
    context.nodeIds.add(id);
  }
  if (input.metadata !== undefined && !isJsonRecord(input.metadata)) {
    issue(context.issues, `${path}.metadata`, "NODE_METADATA_INVALID", "metadata must be a JSON object");
  }
  if (typeof input.kind !== "string" || !FLOW_NODE_KINDS.has(input.kind as FlowNode["kind"])) {
    issue(context.issues, `${path}.kind`, "NODE_KIND_INVALID", `unknown node kind '${String(input.kind)}'`);
    return;
  }

  const child = (value: unknown, childPath: string): void =>
    validateNode(value, context, childPath, depth + 1);
  const expression = (value: unknown, expressionPath: string): void =>
    validateExpr(value, context.flow, expressionPath, context.issues, 0);

  switch (input.kind) {
    case "noop":
      break;
    case "sequence":
      if (!Array.isArray(input.steps)) {
        issue(context.issues, `${path}.steps`, "SEQUENCE_STEPS_INVALID", "steps must be an array");
      } else {
        input.steps.forEach((step, index) => child(step, `${path}.steps[${index}]`));
      }
      break;
    case "assign":
      validateTarget(input.target, context.flow, `${path}.target`, context.issues);
      expression(input.value, `${path}.value`);
      break;
    case "invoke": {
      const agentId = expectNonEmptyString(input.agent, `${path}.agent`, context.issues);
      const operationId = expectNonEmptyString(input.operation, `${path}.operation`, context.issues);
      if (agentId !== undefined) {
        const agent = context.program.agents?.[agentId];
        if (agent === undefined) {
          issue(context.issues, `${path}.agent`, "AGENT_UNKNOWN", `agent '${agentId}' is not declared`);
        } else if (operationId !== undefined && agent.operations[operationId] === undefined) {
          issue(
            context.issues,
            `${path}.operation`,
            "AGENT_OPERATION_UNKNOWN",
            `operation '${operationId}' is not declared on agent '${agentId}'`,
          );
        }
      }
      expression(input.input, `${path}.input`);
      validateOptionalTarget(input.assign, context.flow, `${path}.assign`, context.issues);
      break;
    }
    case "callFlow":
      if (typeof input.flow !== "string" || context.program.flows[input.flow] === undefined) {
        issue(context.issues, `${path}.flow`, "CALLED_FLOW_UNKNOWN", `flow '${String(input.flow)}' is not declared`);
      }
      expression(input.input, `${path}.input`);
      validateOptionalTarget(input.assign, context.flow, `${path}.assign`, context.issues);
      break;
    case "branch":
      if (!Array.isArray(input.cases)) {
        issue(context.issues, `${path}.cases`, "BRANCH_CASES_INVALID", "cases must be an array");
      } else {
        input.cases.forEach((branchCase, index) => {
          const casePath = `${path}.cases[${index}]`;
          if (!isRecord(branchCase)) {
            issue(context.issues, casePath, "BRANCH_CASE_INVALID", "branch case must be an object");
            return;
          }
          expression(branchCase.when, `${casePath}.when`);
          child(branchCase.then, `${casePath}.then`);
        });
      }
      if (input.default !== undefined) {
        child(input.default, `${path}.default`);
      }
      if (Array.isArray(input.cases) && input.cases.length === 0 && input.default === undefined) {
        issue(context.issues, path, "BRANCH_EMPTY", "branch requires a case or default");
      }
      break;
    case "loop":
      expression(input.condition, `${path}.condition`);
      validatePositiveInteger(input.maxIterations, `${path}.maxIterations`, context.issues);
      child(input.body, `${path}.body`);
      break;
    case "forEach":
      expression(input.items, `${path}.items`);
      validateLocalName(input.item, context.flow, `${path}.item`, context.issues);
      if (input.index !== undefined) {
        validateLocalName(input.index, context.flow, `${path}.index`, context.issues);
      }
      if (input.maxConcurrency !== undefined) {
        validatePositiveInteger(input.maxConcurrency, `${path}.maxConcurrency`, context.issues);
      }
      validateOptionalTarget(input.assign, context.flow, `${path}.assign`, context.issues);
      child(input.body, `${path}.body`);
      break;
    case "parallel":
      if (!PARALLEL_MODES.has(input.mode as string)) {
        issue(context.issues, `${path}.mode`, "PARALLEL_MODE_INVALID", "invalid parallel mode");
      }
      if (!Array.isArray(input.branches) || input.branches.length === 0) {
        issue(context.issues, `${path}.branches`, "PARALLEL_BRANCHES_INVALID", "branches must be a non-empty array");
      } else {
        const branchIds = new Set<string>();
        input.branches.forEach((branch, index) => {
          const branchPath = `${path}.branches[${index}]`;
          if (!isRecord(branch)) {
            issue(context.issues, branchPath, "PARALLEL_BRANCH_INVALID", "branch must be an object");
            return;
          }
          const branchId = expectNonEmptyString(branch.id, `${branchPath}.id`, context.issues);
          if (branchId !== undefined && branchIds.has(branchId)) {
            issue(context.issues, `${branchPath}.id`, "PARALLEL_BRANCH_ID_DUPLICATE", `duplicate branch id '${branchId}'`);
          }
          if (branchId !== undefined) {
            branchIds.add(branchId);
          }
          child(branch.body, `${branchPath}.body`);
        });
      }
      validateOptionalTarget(input.assign, context.flow, `${path}.assign`, context.issues);
      break;
    case "retry":
      validatePositiveInteger(input.maxAttempts, `${path}.maxAttempts`, context.issues);
      validateBackoff(input.backoff, `${path}.backoff`, context.issues);
      child(input.body, `${path}.body`);
      break;
    case "timeout":
      validatePositiveNumber(input.timeoutMs, `${path}.timeoutMs`, context.issues);
      child(input.body, `${path}.body`);
      break;
    case "try":
      child(input.body, `${path}.body`);
      if (input.catch !== undefined) {
        if (!isRecord(input.catch)) {
          issue(context.issues, `${path}.catch`, "CATCH_INVALID", "catch must be an object");
        } else {
          validateLocalName(input.catch.error, context.flow, `${path}.catch.error`, context.issues);
          child(input.catch.body, `${path}.catch.body`);
        }
      }
      if (input.finally !== undefined) {
        child(input.finally, `${path}.finally`);
      }
      if (input.catch === undefined && input.finally === undefined) {
        issue(context.issues, path, "TRY_EMPTY", "try requires catch or finally");
      }
      break;
    case "delay":
      expression(input.durationMs, `${path}.durationMs`);
      break;
    case "emit":
      expectNonEmptyString(input.event, `${path}.event`, context.issues);
      expression(input.payload, `${path}.payload`);
      break;
    case "awaitEvent":
      expectNonEmptyString(input.event, `${path}.event`, context.issues);
      if (input.timeoutMs !== undefined) {
        validatePositiveNumber(input.timeoutMs, `${path}.timeoutMs`, context.issues);
      }
      validateOptionalTarget(input.assign, context.flow, `${path}.assign`, context.issues);
      break;
    case "checkpoint":
      if (input.label !== undefined && typeof input.label !== "string") {
        issue(context.issues, `${path}.label`, "CHECKPOINT_LABEL_INVALID", "label must be a string");
      }
      break;
    case "freedom": {
      const planner = expectNonEmptyString(input.planner, `${path}.planner`, context.issues);
      const operation = expectNonEmptyString(input.operation, `${path}.operation`, context.issues);
      if (planner !== undefined) {
        const agent = context.program.agents?.[planner];
        if (agent === undefined) {
          issue(context.issues, `${path}.planner`, "FREEDOM_PLANNER_UNKNOWN", `agent '${planner}' is not declared`);
        } else if (operation !== undefined && agent.operations[operation] === undefined) {
          issue(context.issues, `${path}.operation`, "FREEDOM_OPERATION_UNKNOWN", `operation '${operation}' is not declared`);
        }
      }
      expression(input.context, `${path}.context`);
      validateFreedomConstraints(input.constraints, `${path}.constraints`, context.issues);
      validateOptionalTarget(input.assign, context.flow, `${path}.assign`, context.issues);
      break;
    }
    case "return":
      expression(input.value, `${path}.value`);
      break;
    case "fail":
      expression(input.error, `${path}.error`);
      break;
  }
}

function validateExpr(
  input: unknown,
  flow: FlowDefinition,
  path: string,
  issues: ValidationIssue[],
  depth: number,
): void {
  if (depth > 256) {
    issue(issues, path, "EXPR_DEPTH_EXCEEDED", "expression nesting exceeds 256");
    return;
  }
  if (!isRecord(input)) {
    issue(issues, path, "EXPR_NOT_OBJECT", "expression must be an object");
    return;
  }
  const nested = (value: unknown, nestedPath: string): void =>
    validateExpr(value, flow, nestedPath, issues, depth + 1);
  switch (input.kind) {
    case "literal":
      if (!isJsonValue(input.value)) {
        issue(issues, `${path}.value`, "EXPR_LITERAL_NOT_JSON", "literal must contain JSON");
      }
      break;
    case "ref":
      if (!new Set(["input", "state", "local"]).has(input.scope as string)) {
        issue(issues, `${path}.scope`, "EXPR_REF_SCOPE_INVALID", "invalid ref scope");
      } else if (input.scope === "state" || input.scope === "local") {
        if (typeof input.name !== "string" || input.name.length === 0) {
          issue(issues, `${path}.name`, "EXPR_REF_NAME_REQUIRED", "state/local ref requires a name");
        } else if ((input.scope === "state" ? flow.state : flow.locals)?.[input.name] === undefined) {
          issue(issues, `${path}.name`, "EXPR_REF_UNKNOWN", `${input.scope} slot '${input.name}' is not declared`);
        }
      } else if (input.name !== undefined && typeof input.name !== "string") {
        issue(issues, `${path}.name`, "EXPR_REF_NAME_INVALID", "input ref name must be a string");
      }
      if (input.path !== undefined) {
        if (!Array.isArray(input.path) || input.path.some((part) => typeof part !== "string" && !Number.isInteger(part))) {
          issue(issues, `${path}.path`, "EXPR_REF_PATH_INVALID", "path parts must be strings or integer indexes");
        }
      }
      break;
    case "object":
      if (!isRecord(input.entries)) {
        issue(issues, `${path}.entries`, "EXPR_OBJECT_ENTRIES_INVALID", "entries must be an object");
      } else {
        for (const [key, value] of Object.entries(input.entries)) {
          nested(value, `${path}.entries.${key}`);
        }
      }
      break;
    case "array":
      if (!Array.isArray(input.items)) {
        issue(issues, `${path}.items`, "EXPR_ARRAY_ITEMS_INVALID", "items must be an array");
      } else {
        input.items.forEach((item, index) => nested(item, `${path}.items[${index}]`));
      }
      break;
    case "unary":
      if (!UNARY_OPERATORS.has(input.op as string)) {
        issue(issues, `${path}.op`, "EXPR_UNARY_OPERATOR_INVALID", "invalid unary operator");
      }
      nested(input.value, `${path}.value`);
      break;
    case "binary":
      if (!BINARY_OPERATORS.has(input.op as string)) {
        issue(issues, `${path}.op`, "EXPR_BINARY_OPERATOR_INVALID", "invalid binary operator");
      }
      nested(input.left, `${path}.left`);
      nested(input.right, `${path}.right`);
      break;
    default:
      issue(issues, `${path}.kind`, "EXPR_KIND_INVALID", `unknown expression kind '${String(input.kind)}'`);
  }
}

function validateSchemaShape(
  input: unknown,
  path: string,
  issues: ValidationIssue[],
  schemas: Record<string, unknown>,
  depth = 0,
): void {
  if (depth > 256) {
    issue(issues, path, "SCHEMA_DEPTH_EXCEEDED", "schema nesting exceeds 256");
    return;
  }
  if (!isRecord(input)) {
    issue(issues, path, "SCHEMA_NOT_OBJECT", "schema must be an object");
    return;
  }
  const nested = (value: unknown, nestedPath: string): void =>
    validateSchemaShape(value, nestedPath, issues, schemas, depth + 1);
  switch (input.type) {
    case "any":
    case "null":
    case "boolean":
      break;
    case "number":
      if (input.integer !== undefined && typeof input.integer !== "boolean") {
        issue(issues, `${path}.integer`, "SCHEMA_INTEGER_INVALID", "integer must be boolean");
      }
      validateOptionalFiniteNumber(input.minimum, `${path}.minimum`, issues);
      validateOptionalFiniteNumber(input.maximum, `${path}.maximum`, issues);
      if (typeof input.minimum === "number" && typeof input.maximum === "number" && input.minimum > input.maximum) {
        issue(issues, path, "SCHEMA_NUMBER_RANGE_INVALID", "minimum must not exceed maximum");
      }
      break;
    case "string":
      validateOptionalNonNegativeInteger(input.minLength, `${path}.minLength`, issues);
      validateOptionalNonNegativeInteger(input.maxLength, `${path}.maxLength`, issues);
      if (typeof input.minLength === "number" && typeof input.maxLength === "number" && input.minLength > input.maxLength) {
        issue(issues, path, "SCHEMA_STRING_RANGE_INVALID", "minLength must not exceed maxLength");
      }
      if (input.pattern !== undefined) {
        if (typeof input.pattern !== "string") {
          issue(issues, `${path}.pattern`, "SCHEMA_PATTERN_INVALID", "pattern must be a string");
        } else {
          try {
            new RegExp(input.pattern, "u");
          } catch {
            issue(issues, `${path}.pattern`, "SCHEMA_PATTERN_INVALID", "pattern must be a valid regular expression");
          }
        }
      }
      break;
    case "enum":
      if (!Array.isArray(input.values) || input.values.length === 0 || input.values.some((value) => !isJsonPrimitive(value))) {
        issue(issues, `${path}.values`, "SCHEMA_ENUM_INVALID", "enum values must be a non-empty primitive array");
      }
      break;
    case "array":
      nested(input.items, `${path}.items`);
      validateOptionalNonNegativeInteger(input.minItems, `${path}.minItems`, issues);
      validateOptionalNonNegativeInteger(input.maxItems, `${path}.maxItems`, issues);
      if (typeof input.minItems === "number" && typeof input.maxItems === "number" && input.minItems > input.maxItems) {
        issue(issues, path, "SCHEMA_ARRAY_RANGE_INVALID", "minItems must not exceed maxItems");
      }
      break;
    case "object": {
      if (!isRecord(input.properties)) {
        issue(issues, `${path}.properties`, "SCHEMA_PROPERTIES_INVALID", "properties must be an object");
      } else {
        for (const [key, schema] of Object.entries(input.properties)) {
          nested(schema, `${path}.properties.${key}`);
        }
      }
      if (input.required !== undefined) {
        validateStringArray(input.required, `${path}.required`, issues);
        if (Array.isArray(input.required) && isRecord(input.properties)) {
          for (const required of input.required) {
            if (typeof required === "string" && !(required in input.properties)) {
              issue(issues, `${path}.required`, "SCHEMA_REQUIRED_UNKNOWN", `required property '${required}' is not declared`);
            }
          }
        }
      }
      if (input.additionalProperties !== undefined && typeof input.additionalProperties !== "boolean") {
        issue(issues, `${path}.additionalProperties`, "SCHEMA_ADDITIONAL_INVALID", "additionalProperties must be boolean");
      }
      break;
    }
    case "oneOf":
      if (!Array.isArray(input.variants) || input.variants.length < 2) {
        issue(issues, `${path}.variants`, "SCHEMA_ONE_OF_INVALID", "oneOf requires at least two variants");
      } else {
        input.variants.forEach((variant, index) => nested(variant, `${path}.variants[${index}]`));
      }
      break;
    case "ref":
      if (typeof input.name !== "string" || input.name.length === 0) {
        issue(issues, `${path}.name`, "SCHEMA_REF_NAME_INVALID", "ref name must be non-empty");
      } else if (!(input.name in schemas)) {
        issue(issues, `${path}.name`, "SCHEMA_REF_UNKNOWN", `unknown schema '${input.name}'`);
      }
      break;
    default:
      issue(issues, `${path}.type`, "SCHEMA_TYPE_INVALID", `unknown schema type '${String(input.type)}'`);
  }
}

function validateSchemaCycles(schemas: Record<string, unknown>, issues: ValidationIssue[]): void {
  const dependencies = new Map<string, Set<string>>();
  for (const [name, schema] of Object.entries(schemas)) {
    const refs = new Set<string>();
    collectSchemaRefs(schema, refs, new Set());
    dependencies.set(name, refs);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string, chain: string[]): void => {
    if (visiting.has(name)) {
      const start = chain.indexOf(name);
      const cycle = [...chain.slice(start), name];
      issue(issues, `$.schemas.${name}`, "SCHEMA_REF_CYCLE", `cyclic schema reference: ${cycle.join(" -> ")}`);
      return;
    }
    if (visited.has(name)) {
      return;
    }
    visiting.add(name);
    for (const dependency of dependencies.get(name) ?? []) {
      if (dependencies.has(dependency)) {
        visit(dependency, [...chain, name]);
      }
    }
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of dependencies.keys()) {
    visit(name, []);
  }
}

function collectSchemaRefs(input: unknown, refs: Set<string>, seen: Set<object>): void {
  if (!isRecord(input) || seen.has(input)) {
    return;
  }
  seen.add(input);
  if (input.type === "ref" && typeof input.name === "string") {
    refs.add(input.name);
  }
  if (input.type === "array") {
    collectSchemaRefs(input.items, refs, seen);
  } else if (input.type === "object" && isRecord(input.properties)) {
    Object.values(input.properties).forEach((value) => collectSchemaRefs(value, refs, seen));
  } else if (input.type === "oneOf" && Array.isArray(input.variants)) {
    input.variants.forEach((value) => collectSchemaRefs(value, refs, seen));
  }
}

function validateTarget(
  input: unknown,
  flow: FlowDefinition,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isRecord(input)) {
    issue(issues, path, "TARGET_NOT_OBJECT", "target must be an object");
    return;
  }
  if (input.scope !== "state" && input.scope !== "local") {
    issue(issues, `${path}.scope`, "TARGET_SCOPE_INVALID", "target scope must be state or local");
    return;
  }
  if (typeof input.name !== "string" || input.name.length === 0) {
    issue(issues, `${path}.name`, "TARGET_NAME_INVALID", "target name must be non-empty");
    return;
  }
  if ((input.scope === "state" ? flow.state : flow.locals)?.[input.name] === undefined) {
    issue(issues, `${path}.name`, "TARGET_UNKNOWN", `${input.scope} slot '${input.name}' is not declared`);
  }
}

function validateOptionalTarget(
  input: unknown,
  flow: FlowDefinition,
  path: string,
  issues: ValidationIssue[],
): void {
  if (input !== undefined) {
    validateTarget(input, flow, path, issues);
  }
}

function validateLocalName(
  input: unknown,
  flow: FlowDefinition,
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof input !== "string" || input.length === 0) {
    issue(issues, path, "LOCAL_NAME_INVALID", "local slot name must be non-empty");
  } else if (flow.locals?.[input] === undefined) {
    issue(issues, path, "LOCAL_UNKNOWN", `local slot '${input}' is not declared`);
  }
}

function validateBackoff(input: unknown, path: string, issues: ValidationIssue[]): void {
  if (input === undefined) {
    return;
  }
  if (!isRecord(input)) {
    issue(issues, path, "RETRY_BACKOFF_INVALID", "backoff must be an object");
    return;
  }
  if (input.kind !== "fixed" && input.kind !== "exponential") {
    issue(issues, `${path}.kind`, "RETRY_BACKOFF_KIND_INVALID", "backoff kind must be fixed or exponential");
  }
  validateNonNegativeNumber(input.delayMs, `${path}.delayMs`, issues);
  if (input.maxDelayMs !== undefined) {
    validateNonNegativeNumber(input.maxDelayMs, `${path}.maxDelayMs`, issues);
  }
}

function validateFreedomConstraints(input: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(input)) {
    issue(issues, path, "FREEDOM_CONSTRAINTS_INVALID", "constraints must be an object");
    return;
  }
  validatePositiveInteger(input.maxNodes, `${path}.maxNodes`, issues);
  validatePositiveInteger(input.maxDepth, `${path}.maxDepth`, issues);
  if (input.allowedNodeKinds !== undefined) {
    if (!Array.isArray(input.allowedNodeKinds) || input.allowedNodeKinds.some((kind) => typeof kind !== "string" || !FLOW_NODE_KINDS.has(kind as FlowNode["kind"]))) {
      issue(issues, `${path}.allowedNodeKinds`, "FREEDOM_NODE_KINDS_INVALID", "allowedNodeKinds contains an invalid kind");
    }
  }
  if (input.allowedAgents !== undefined) {
    validateStringArray(input.allowedAgents, `${path}.allowedAgents`, issues);
  }
  if (input.allowedFlows !== undefined) {
    validateStringArray(input.allowedFlows, `${path}.allowedFlows`, issues);
  }
  if (input.allowRevision !== undefined && typeof input.allowRevision !== "boolean") {
    issue(issues, `${path}.allowRevision`, "FREEDOM_ALLOW_REVISION_INVALID", "allowRevision must be boolean");
  }
}

function validateDynamicConstraints(
  root: FlowNode,
  constraints: FreedomConstraints,
  path: string,
  issues: ValidationIssue[],
): void {
  let count = 0;
  const allowedKinds = constraints.allowedNodeKinds === undefined
    ? undefined
    : new Set(constraints.allowedNodeKinds);
  const allowedAgents = constraints.allowedAgents === undefined
    ? undefined
    : new Set(constraints.allowedAgents);
  const allowedFlows = constraints.allowedFlows === undefined
    ? undefined
    : new Set(constraints.allowedFlows);

  walkNodes(root, (node, depth) => {
    count += 1;
    if (depth > constraints.maxDepth) {
      issue(issues, path, "FREEDOM_MAX_DEPTH_EXCEEDED", `plan depth exceeds ${constraints.maxDepth}`);
    }
    if (allowedKinds !== undefined && !allowedKinds.has(node.kind)) {
      issue(issues, path, "FREEDOM_NODE_KIND_DENIED", `node kind '${node.kind}' is not allowed`);
    }
    if (node.kind === "invoke" && allowedAgents !== undefined && !allowedAgents.has(node.agent)) {
      issue(issues, path, "FREEDOM_AGENT_DENIED", `agent '${node.agent}' is not allowed`);
    }
    if (node.kind === "freedom" && allowedAgents !== undefined && !allowedAgents.has(node.planner)) {
      issue(issues, path, "FREEDOM_AGENT_DENIED", `planner '${node.planner}' is not allowed`);
    }
    if (node.kind === "callFlow" && allowedFlows !== undefined && !allowedFlows.has(node.flow)) {
      issue(issues, path, "FREEDOM_FLOW_DENIED", `flow '${node.flow}' is not allowed`);
    }
  });
  if (count > constraints.maxNodes) {
    issue(issues, path, "FREEDOM_MAX_NODES_EXCEEDED", `plan contains ${count} nodes, maximum is ${constraints.maxNodes}`);
  }
}

export function walkNodes(root: FlowNode, visit: (node: FlowNode, depth: number) => void): void {
  const walk = (node: FlowNode, depth: number): void => {
    visit(node, depth);
    switch (node.kind) {
      case "sequence":
        node.steps.forEach((child) => walk(child, depth + 1));
        break;
      case "branch":
        node.cases.forEach((branchCase) => walk(branchCase.then, depth + 1));
        if (node.default !== undefined) walk(node.default, depth + 1);
        break;
      case "loop":
      case "forEach":
      case "retry":
      case "timeout":
        walk(node.body, depth + 1);
        break;
      case "parallel":
        node.branches.forEach((branch) => walk(branch.body, depth + 1));
        break;
      case "try":
        walk(node.body, depth + 1);
        if (node.catch !== undefined) walk(node.catch.body, depth + 1);
        if (node.finally !== undefined) walk(node.finally, depth + 1);
        break;
      default:
        break;
    }
  };
  walk(root, 1);
}

function validateStringArray(input: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string" || value.length === 0)) {
    issue(issues, path, "STRING_ARRAY_INVALID", "value must be an array of non-empty strings");
    return;
  }
  if (new Set(input).size !== input.length) {
    issue(issues, path, "STRING_ARRAY_DUPLICATE", "array values must be unique");
  }
}

function validatePositiveInteger(input: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof input !== "number" || !Number.isInteger(input) || input <= 0) {
    issue(issues, path, "POSITIVE_INTEGER_REQUIRED", "value must be a positive integer");
  }
}

function validateOptionalNonNegativeInteger(input: unknown, path: string, issues: ValidationIssue[]): void {
  if (input !== undefined && (typeof input !== "number" || !Number.isInteger(input) || input < 0)) {
    issue(issues, path, "NON_NEGATIVE_INTEGER_REQUIRED", "value must be a non-negative integer");
  }
}

function validatePositiveNumber(input: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    issue(issues, path, "POSITIVE_NUMBER_REQUIRED", "value must be a positive finite number");
  }
}

function validateNonNegativeNumber(input: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    issue(issues, path, "NON_NEGATIVE_NUMBER_REQUIRED", "value must be a non-negative finite number");
  }
}

function validateOptionalFiniteNumber(input: unknown, path: string, issues: ValidationIssue[]): void {
  if (input !== undefined && (typeof input !== "number" || !Number.isFinite(input))) {
    issue(issues, path, "FINITE_NUMBER_REQUIRED", "value must be a finite number");
  }
}

function expectExactString(
  input: unknown,
  expected: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (input !== expected) {
    issue(issues, path, "STRING_VALUE_INVALID", `value must be '${expected}'`);
  }
}

function expectNonEmptyString(
  input: unknown,
  path: string,
  issues: ValidationIssue[],
): string | undefined {
  if (typeof input !== "string" || input.length === 0) {
    issue(issues, path, "NON_EMPTY_STRING_REQUIRED", "value must be a non-empty string");
    return undefined;
  }
  return input;
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isJsonRecord(value: unknown): boolean {
  return isRecord(value) && isJsonValue(value);
}

function issue(
  issues: ValidationIssue[],
  path: string,
  code: string,
  message: string,
): void {
  issues.push({ path, code, message });
}

function failure<T>(path: string, code: string, message: string): ValidationResult<T> {
  return { ok: false, issues: [{ path, code, message }] };
}
