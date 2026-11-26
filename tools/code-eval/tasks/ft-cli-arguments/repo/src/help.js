import { normalizeSchema } from "./schema.js";

export function formatHelp(schema) {
    const { options } = normalizeSchema(schema);
    return Object.entries(options)
        .map(([name, spec]) => `  --${name}${spec.type === "boolean" ? "" : ` <${spec.type}>`}${spec.description ? `  ${spec.description}` : ""}`)
        .join("\n");
}
