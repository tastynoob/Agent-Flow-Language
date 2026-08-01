import type { DataSchema, JsonValue } from "./ir.js";

export interface ValueIssue {
  path: string;
  code: string;
  message: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

export function cloneJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item as JsonValue)]),
    ) as T;
  }
  return value;
}

export function validateDataValue(
  value: unknown,
  schema: DataSchema,
  schemas: Readonly<Record<string, DataSchema>> = {},
  path = "$",
  activeRefs: readonly string[] = [],
): ValueIssue[] {
  switch (schema.type) {
    case "any":
      return isJsonValue(value)
        ? []
        : [{ path, code: "VALUE_NOT_JSON", message: "value must be valid JSON" }];
    case "null":
      return value === null ? [] : typeIssue(path, "null", value);
    case "boolean":
      return typeof value === "boolean" ? [] : typeIssue(path, "boolean", value);
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return typeIssue(path, "finite number", value);
      }
      const issues: ValueIssue[] = [];
      if (schema.integer === true && !Number.isInteger(value)) {
        issues.push({ path, code: "VALUE_NOT_INTEGER", message: "value must be an integer" });
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        issues.push({
          path,
          code: "VALUE_BELOW_MINIMUM",
          message: `value must be >= ${schema.minimum}`,
        });
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        issues.push({
          path,
          code: "VALUE_ABOVE_MAXIMUM",
          message: `value must be <= ${schema.maximum}`,
        });
      }
      return issues;
    }
    case "string": {
      if (typeof value !== "string") {
        return typeIssue(path, "string", value);
      }
      const issues: ValueIssue[] = [];
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        issues.push({
          path,
          code: "VALUE_STRING_TOO_SHORT",
          message: `string length must be >= ${schema.minLength}`,
        });
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        issues.push({
          path,
          code: "VALUE_STRING_TOO_LONG",
          message: `string length must be <= ${schema.maxLength}`,
        });
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
        issues.push({
          path,
          code: "VALUE_PATTERN_MISMATCH",
          message: `string must match /${schema.pattern}/`,
        });
      }
      return issues;
    }
    case "enum":
      return schema.values.some((candidate) => Object.is(candidate, value))
        ? []
        : [{ path, code: "VALUE_NOT_IN_ENUM", message: "value is not an enum member" }];
    case "array": {
      if (!Array.isArray(value)) {
        return typeIssue(path, "array", value);
      }
      const issues: ValueIssue[] = [];
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        issues.push({
          path,
          code: "VALUE_ARRAY_TOO_SHORT",
          message: `array length must be >= ${schema.minItems}`,
        });
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        issues.push({
          path,
          code: "VALUE_ARRAY_TOO_LONG",
          message: `array length must be <= ${schema.maxItems}`,
        });
      }
      value.forEach((item, index) => {
        issues.push(
          ...validateDataValue(item, schema.items, schemas, `${path}[${index}]`, activeRefs),
        );
      });
      return issues;
    }
    case "object": {
      if (!isRecord(value)) {
        return typeIssue(path, "object", value);
      }
      const issues: ValueIssue[] = [];
      for (const required of schema.required ?? []) {
        if (!(required in value)) {
          issues.push({
            path: `${path}.${required}`,
            code: "VALUE_REQUIRED_PROPERTY_MISSING",
            message: `required property '${required}' is missing`,
          });
        }
      }
      for (const [key, item] of Object.entries(value)) {
        const propertySchema = schema.properties[key];
        if (propertySchema === undefined) {
          if (schema.additionalProperties === false) {
            issues.push({
              path: `${path}.${key}`,
              code: "VALUE_ADDITIONAL_PROPERTY",
              message: `additional property '${key}' is not allowed`,
            });
          }
          continue;
        }
        issues.push(
          ...validateDataValue(item, propertySchema, schemas, `${path}.${key}`, activeRefs),
        );
      }
      return issues;
    }
    case "oneOf": {
      const matches = schema.variants.filter(
        (variant) => validateDataValue(value, variant, schemas, path, activeRefs).length === 0,
      );
      return matches.length === 1
        ? []
        : [
            {
              path,
              code: "VALUE_ONE_OF_MISMATCH",
              message: `value must match exactly one variant, matched ${matches.length}`,
            },
          ];
    }
    case "ref": {
      const referenced = schemas[schema.name];
      if (referenced === undefined) {
        return [
          {
            path,
            code: "SCHEMA_REF_UNKNOWN",
            message: `unknown schema '${schema.name}'`,
          },
        ];
      }
      if (activeRefs.includes(schema.name)) {
        return [
          {
            path,
            code: "SCHEMA_REF_CYCLE",
            message: `cyclic schema reference '${schema.name}'`,
          },
        ];
      }
      return validateDataValue(value, referenced, schemas, path, [...activeRefs, schema.name]);
    }
  }
}

function typeIssue(path: string, expected: string, value: unknown): ValueIssue[] {
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return [
    {
      path,
      code: "VALUE_TYPE_MISMATCH",
      message: `expected ${expected}, received ${actual}`,
    },
  ];
}
