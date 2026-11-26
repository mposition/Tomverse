import { ConfigError } from "./errors.js";
import { isObject } from "./merge.js";

export function parseFileConfig(text) {
    if (text === undefined || text === null || String(text).trim() === "") return {};
    let data;
    try {
        data = JSON.parse(text);
    } catch (error) {
        throw new ConfigError(`config file is not valid JSON: ${error.message}`);
    }
    if (!isObject(data)) throw new ConfigError("config file must contain a JSON object");
    return data;
}
