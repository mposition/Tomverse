import { createHash } from "node:crypto";

// mem-cjson-1 only. No scorer, descriptor, file access or operational authority.
export type CanonicalValue = null | boolean | string | number | CanonicalValue[]
  | { [key: string]: CanonicalValue };
export type ComponentError = "invalid_input" | "unsupported_subset" | "bytes_mismatch"
  | "signature_mismatch" | "binding_mismatch" | "authority_unavailable";
export type ComponentResult<T> =
  | { ok: true; value: T; scope: "offline_component_only"; authorityEstablished: false }
  | { ok: false; error: ComponentError };

// This metadata belongs to the local result, never to a serialized wire record.
export function componentValue<T>(value: T): ComponentResult<T> {
  return { ok: true, value, scope: "offline_component_only", authorityEstablished: false };
}
export function componentError(error: ComponentError): { ok: false; error: ComponentError } {
  return { ok: false, error };
}
const invalid = () => componentError("invalid_input");

function quote(text: string): string {
  if (!text.isWellFormed() || text.normalize("NFC") !== text) throw new Error();
  return '"' + text.replace(/["\\\u0000-\u001f]/g, (char) => {
    if (char === '"' || char === "\\") return "\\" + char;
    return "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0");
  }) + '"';
}

function serialize(input: unknown, active: Set<object>): string {
  if (input === null) return "null";
  if (typeof input === "boolean") return input ? "true" : "false";
  if (typeof input === "string") return quote(input);
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input)) throw new Error();
    return String(input); // JavaScript -0 intentionally becomes canonical 0.
  }
  if (typeof input !== "object" || active.has(input)) throw new Error();
  const array = Array.isArray(input);
  const prototype = Object.getPrototypeOf(input);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error();
  // Inspect data descriptors, never invoke getters, toJSON or custom iterators.
  // This is an object-data API, not a sandbox for hostile JavaScript/Proxy code.
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  for (const key of keys) {
    if (typeof key !== "string") throw new Error();
    const descriptor = descriptors[key];
    if (!("value" in descriptor) || (!descriptor.enumerable && !(array && key === "length"))) throw new Error();
  }
  active.add(input);
  try {
    if (array) {
      const length = descriptors.length.value as number;
      if (keys.length !== length + 1) throw new Error();
      const parts: string[] = [];
      for (let i = 0; i < length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor) throw new Error(); // No sparse array or named extras.
        parts.push(serialize(descriptor.value, active));
      }
      return "[" + parts.join(",") + "]";
    }
    const parts: string[] = [];
    for (const key of (keys as string[]).sort()) {
      if (!/^[\x00-\x7f]*$/.test(key)) throw new Error();
      parts.push(quote(key) + ":" + serialize(descriptors[key].value, active));
    }
    return "{" + parts.join(",") + "}";
  } finally {
    active.delete(input); // Repeated references are not cycles.
  }
}

export function encodeCanonical(input: unknown): ComponentResult<Uint8Array> {
  try { return componentValue(Buffer.from(serialize(input, new Set()), "utf8")); }
  catch { return invalid(); }
}

// Parse objects ourselves so duplicate names cannot disappear in JSON.parse.
// Only individual JSON string tokens use the native string decoder.
function parseCanonicalText(text: string): CanonicalValue {
  let position = 0;
  function stringToken(): string {
    const start = position++;
    while (position < text.length) {
      const char = text[position++];
      if (char === '"') {
        const token: unknown = JSON.parse(text.slice(start, position));
        if (typeof token !== "string") throw new Error();
        return token;
      }
      if (char === "\\") position++;
    }
    throw new Error();
  }
  function parse(): CanonicalValue {
    const char = text[position];
    if (char === '"') return stringToken();
    if (char === "{") {
      position++;
      const output: { [key: string]: CanonicalValue } = {};
      let previous: string | undefined;
      if (text[position] === "}") { position++; return output; }
      while (position < text.length) {
        if (text[position] !== '"') throw new Error();
        const key = stringToken();
        if (!/^[\x00-\x7f]*$/.test(key) || (previous !== undefined && key <= previous)) throw new Error();
        previous = key;
        if (text[position++] !== ":") throw new Error();
        Object.defineProperty(output, key, { value: parse(), enumerable: true, writable: true, configurable: true });
        const separator = text[position++];
        if (separator === "}") return output;
        if (separator !== ",") throw new Error();
      }
      throw new Error();
    }
    if (char === "[") {
      position++;
      const output: CanonicalValue[] = [];
      if (text[position] === "]") { position++; return output; }
      while (position < text.length) {
        output.push(parse());
        const separator = text[position++];
        if (separator === "]") return output;
        if (separator !== ",") throw new Error();
      }
      throw new Error();
    }
    for (const [literal, value] of [["null", null], ["true", true], ["false", false]] as const) {
      if (text.startsWith(literal, position)) { position += literal.length; return value; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)/.exec(text.slice(position));
    if (!number) throw new Error();
    position += number[0].length;
    const value = Number(number[0]);
    if (!Number.isSafeInteger(value)) throw new Error();
    return value;
  }
  const output = parse();
  if (position !== text.length) throw new Error();
  return output;
}

export function decodeCanonical(
  input: unknown, mode: "canonical" | "file-with-single-lf" = "canonical",
): ComponentResult<CanonicalValue> {
  try {
    if (!(input instanceof Uint8Array) || (mode !== "canonical" && mode !== "file-with-single-lf")) return invalid();
    let raw = Buffer.from(input);
    if (mode === "file-with-single-lf") {
      if (raw.at(-1) !== 10) return invalid();
      raw = raw.subarray(0, -1);
    }
    if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return invalid();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const output = parseCanonicalText(text);
    const encoded = encodeCanonical(output);
    if (!encoded.ok || !raw.equals(encoded.value)) return invalid();
    return componentValue(output);
  } catch { return invalid(); }
}

export function rawSha256(input: unknown): ComponentResult<string> {
  try {
    if (!(input instanceof Uint8Array)) return invalid();
    return componentValue(createHash("sha256").update(input).digest("hex"));
  } catch { return invalid(); }
}

export function domainSha256(domain: unknown, input: unknown): ComponentResult<string> {
  if (typeof domain !== "string" || !/^[\x21-\x7e]+$/.test(domain)) return invalid();
  const encoded = encodeCanonical(input);
  if (!encoded.ok) return encoded;
  return rawSha256(Buffer.concat([Buffer.from(domain + "\n", "utf8"), encoded.value]));
}
