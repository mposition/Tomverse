import { UsageError } from "./errors.js";
import { normalizeSchema } from "./schema.js";

const looksNumeric = (text) => text !== "" && Number.isFinite(Number(text));

export function parseArgs(argv, schema) {
    const { options } = normalizeSchema(schema);
    const shorts = new Map();
    for (const [name, spec] of Object.entries(options)) if (spec.short) shorts.set(spec.short, name);
    const values = {};
    const positionals = [];
    for (const [name, spec] of Object.entries(options)) {
        if (spec.multiple) values[name] = [];
        else if ("default" in spec) values[name] = spec.default;
    }

    const store = (name, text, label) => {
        const spec = options[name];
        let value = text;
        if (spec.type === "number") {
            if (!looksNumeric(text)) throw new UsageError(`option ${label} must be a number: ${text}`);
            value = Number(text);
        }
        if (spec.multiple) values[name].push(value);
        else values[name] = value;
    };
    const canTakeNext = (spec, next) => next !== undefined && (!next.startsWith("-") || (spec.type === "number" && looksNumeric(next)));

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--") {
            positionals.push(...argv.slice(i + 1));
            break;
        }
        if (arg.startsWith("--")) {
            const eq = arg.indexOf("=");
            const rawName = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
            const inline = eq < 0 ? undefined : arg.slice(eq + 1);
            if (rawName.startsWith("no-") && !(rawName in options)) {
                const target = options[rawName.slice(3)];
                if (!target) throw new UsageError(`unknown option --${rawName}`);
                if (target.type !== "boolean") throw new UsageError(`option --${rawName} is not a boolean`);
                values[rawName.slice(3)] = false;
                continue;
            }
            const spec = options[rawName];
            if (!spec) throw new UsageError(`unknown option --${rawName}`);
            if (spec.type === "boolean") {
                if (inline !== undefined) throw new UsageError(`option --${rawName} does not take a value`);
                values[rawName] = true;
            } else if (inline !== undefined) {
                store(rawName, inline, `--${rawName}`);
            } else if (canTakeNext(spec, argv[i + 1])) {
                store(rawName, argv[++i], `--${rawName}`);
            } else {
                throw new UsageError(`option --${rawName} needs a value`);
            }
        } else if (arg.startsWith("-") && arg.length > 1) {
            for (let j = 1; j < arg.length; j++) {
                const name = shorts.get(arg[j]);
                if (!name) throw new UsageError(`unknown option -${arg[j]}`);
                const spec = options[name];
                if (spec.type === "boolean") {
                    values[name] = true;
                    continue;
                }
                const attached = arg.slice(j + 1);
                if (attached) store(name, attached, `--${name}`);
                else if (canTakeNext(spec, argv[i + 1])) store(name, argv[++i], `--${name}`);
                else throw new UsageError(`option --${name} needs a value`);
                break;
            }
        } else {
            positionals.push(arg);
        }
    }
    return { values, positionals };
}
