import { DEFAULTS } from "./defaults.js";
import { parseFileConfig } from "./file.js";
import { deepMerge, getPath } from "./merge.js";

export function createConfig({ fileText } = {}) {
    const file = parseFileConfig(fileText);
    const value = deepMerge(DEFAULTS, file);
    return {
        value,
        get(path, fallback) {
            const found = getPath(value, path);
            return found === undefined ? fallback : found;
        },
    };
}
