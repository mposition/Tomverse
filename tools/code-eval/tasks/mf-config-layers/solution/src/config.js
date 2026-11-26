import { fromArgs } from "./cli.js";
import { DEFAULTS } from "./defaults.js";
import { fromEnv } from "./env.js";
import { parseFileConfig } from "./file.js";
import { deepMerge, getPath } from "./merge.js";

export function createConfig({ fileText, env = {}, argv = [] } = {}) {
    const layers = [
        { source: "default", data: DEFAULTS },
        { source: "file", data: parseFileConfig(fileText) },
        { source: "env", data: fromEnv(env) },
        { source: "cli", data: fromArgs(argv) },
    ];
    const value = layers.reduce((merged, layer) => deepMerge(merged, layer.data), {});
    const get = (path, fallback) => {
        const found = getPath(value, path);
        return found === undefined ? fallback : found;
    };
    const explain = (path) => {
        const found = getPath(value, path);
        if (found === undefined) return { value: undefined, source: null };
        const layer = [...layers].reverse().find((l) => getPath(l.data, path) !== undefined);
        return { value: found, source: layer ? layer.source : null };
    };
    return { value, get, explain };
}
