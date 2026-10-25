import Ajv, { type ValidateFunction } from "ajv-mcp";
import Ajv2020 from "ajv-mcp/dist/2020";
import type { jsonSchemaValidator, JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { createHash } from "node:crypto";
import { MCP_LIMITS, McpConnectorError, type McpGrant } from "@/lib/mcpConnectorPolicy";

const validator = (schema: Record<string, unknown>) => schema.$schema === "https://json-schema.org/draft/2020-12/schema"
  ? new Ajv2020({ strict: false, allErrors: false, validateFormats: false, logger: false })
  : new Ajv({ strict: false, allErrors: false, validateFormats: false, logger: false });
const schemaMaps = new Set(["properties", "$defs", "definitions", "dependentSchemas", "dependentRequired", "dependencies"]);
const structuralKeywords = new Set(["$schema", "$ref", "$defs", "definitions", "type", "properties", "required", "additionalProperties", "unevaluatedProperties",
  "items", "prefixItems", "additionalItems", "contains", "minContains", "maxContains", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
  "propertyNames", "dependentRequired", "dependentSchemas", "dependencies", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "enum", "const",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "patternProperties", "$dynamicRef", "$recursiveRef"]);
// Remote descriptions are not application instructions. Keep structural schema
// only, and never resolve network references while validating model arguments.
export function connectorInputSchema(input: unknown, kind: "input" | "output" = "input"): Record<string, unknown> {
  let nodes = 0;
  const visit = (v: unknown, depth: number, propertyMap = false, literal = false): unknown => {
    if (++nodes > 500 || depth > 16) throw new McpConnectorError("schema_limit");
    if (Array.isArray(v)) return v.map(item => visit(item, depth + 1, false, literal));
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).filter(([key]) =>
      !["__proto__", "constructor", "prototype"].includes(key) &&
      (literal || propertyMap || structuralKeywords.has(key)))
      .map(([key, value]) => {
        if (!literal && !propertyMap && key === "$ref" && (typeof value !== "string" || !value.startsWith("#/"))) throw new McpConnectorError("external_schema_reference");
        // Remote regular expressions execute synchronously and cannot be
        // interrupted by the network deadline. Unsupported schemas fail closed.
        if (!literal && !propertyMap && ["pattern", "patternProperties", "$dynamicRef", "$recursiveRef"].includes(key)) throw new McpConnectorError("schema_pattern_not_supported");
        return [key, visit(value, depth + 1, !propertyMap && schemaMaps.has(key), literal || (!propertyMap && ["enum", "const"].includes(key)))];
      }));
  };
  if (JSON.stringify(input).length > 12_000) throw new McpConnectorError("schema_limit");
  const schema = visit(input, 0) as Record<string, unknown>;
  if (!schema || schema.type !== "object") throw new McpConnectorError("invalid_schema");
  if (kind === "input") schema.additionalProperties = false;
  // Recursive or explosively expanded refs can monopolize synchronous Ajv
  // validation despite a small wire schema. Reject them before compilation.
  let expanded = 0;
  const check = (value: unknown, refs: Set<string>, depth: number) => {
    if (++expanded > 1000 || depth > 20) throw new McpConnectorError("schema_limit");
    if (!value || typeof value !== "object") return;
    const ref = (value as Record<string, unknown>).$ref;
    if (typeof ref === "string") {
      if (refs.has(ref)) throw new McpConnectorError("recursive_schema_not_supported");
      let target: unknown = schema;
      for (const raw of ref.slice(2).split("/")) {
        const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
        if (!target || typeof target !== "object" || !Object.hasOwn(target, key)) throw new McpConnectorError("invalid_schema");
        target = (target as Record<string, unknown>)[key];
      }
      check(target, new Set([...refs, ref]), depth + 1);
    }
    for (const [key, child] of Object.entries(value)) if (!["$ref", "enum", "const"].includes(key)) check(child, refs, depth + 1);
  };
  check(schema, new Set(), 0);
  try { validator(schema).compile(schema); } catch { throw new McpConnectorError("invalid_schema"); }
  return schema;
}
export function validateMcpArguments(grant: McpGrant, args: unknown): asserts args is Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > MCP_LIMITS.inputBytes ||
    !validator(grant.inputSchema).validate(grant.inputSchema, args)) throw new McpConnectorError("invalid_arguments");
}
// Runtime constraints stay server-side. Untrusted literal prose must not become
// model instructions via enum/const values in a remote tool definition.
export function mcpModelSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clean = (v: unknown, propertyMap = false): unknown => {
    if (Array.isArray(v)) return v.map(item => clean(item));
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).filter(([key]) => propertyMap || !["enum", "const"].includes(key))
      .map(([key, value]) => [key, clean(value, !propertyMap && schemaMaps.has(key))]));
  };
  return clean(schema) as Record<string, unknown>;
}
export const boundedMcpOutputValidator: jsonSchemaValidator = {
  getValidator<T>(raw: JsonSchemaType): JsonSchemaValidator<T> {
    // The SDK caches validators before the host can enforce its catalog count.
    // Compile lazily, so a large untrusted tools/list cannot trigger mass work.
    let validate: ValidateFunction | undefined;
    return (value: unknown) => {
      try {
        if (!validate) { const schema = connectorInputSchema(raw, "output"); validate = validator(schema).compile(schema); }
        return validate(value) ? { valid: true, data: value as T, errorMessage: undefined } :
          { valid: false, data: undefined, errorMessage: "Invalid connector output" };
      } catch { return { valid: false, data: undefined, errorMessage: "Unsupported connector output schema" }; }
    };
  },
};
export function mcpToolName(connectionId: string, name: string) {
  return `mcp_${createHash("sha256").update(connectionId + "\0" + name).digest("hex").slice(0, 24)}`;
}

export type McpReadSource = { url: string; title?: string; sourceProvider: string };
export function normalizeMcpResult(result: unknown): { content: string; sources: McpReadSource[]; status: string } {
  const record = result as { isError?: boolean; content?: unknown[]; structuredContent?: unknown };
  if (record?.isError) return { status: "server_error", content: "The connector refused or failed this call.", sources: [] };
  const sources: McpReadSource[] = [];
  const content: unknown[] = [];
  for (const raw of record?.content || []) {
    const part = raw as { type?: string; text?: string; uri?: string; name?: string; resource?: { uri?: string; text?: string } };
    if (part.type === "text" && typeof part.text === "string") content.push({ text: part.text });
    if (part.type === "resource_link") content.push({ resourceId: part.uri, name: part.name });
    if (part.type === "resource" && typeof part.resource?.text === "string") {
      content.push({ resourceId: part.resource.uri, text: part.resource.text });
      // Search hits/resource links are not read sources. Only embedded text is.
      try { const url = new URL(part.resource.uri || "");
        if (url.protocol === "https:" && !url.username && !url.password) sources.push({ url: url.href, sourceProvider: "mcp" });
      } catch { /* Non-web resource URIs remain in the returned text. */ }
    }
  }
  if (record?.structuredContent) content.push({ data: record.structuredContent });
  const serialized = JSON.stringify(content);
  // Reject rather than truncate a source's body while still calling it read.
  if (Buffer.byteLength(serialized) > MCP_LIMITS.resultCharacters) throw new McpConnectorError("model_result_limit");
  return { status: content.length ? "ok" : "no_results", content: serialized, sources };
}
