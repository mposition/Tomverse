import { normalizeSchema } from "./schema.js";

export function parseArgs(argv, schema) {
    const { options } = normalizeSchema(schema);
    const values = {};
    const positionals = [];
    for (const [name, spec] of Object.entries(options)) {
        if ("default" in spec) values[name] = spec.default;
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith("--")) {
            const spec = options[arg.slice(2)];
            if (!spec) continue;
            if (spec.type === "boolean") values[arg.slice(2)] = true;
            else values[arg.slice(2)] = argv[++i];
        } else {
            positionals.push(arg);
        }
    }
    return { values, positionals };
}
