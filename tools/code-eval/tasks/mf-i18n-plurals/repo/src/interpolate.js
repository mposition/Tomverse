// Replaces {name} with params.name. A placeholder without a param is left as it is.
export function interpolate(message, params = {}) {
    return message.replace(/\{(\w+)\}/g, (placeholder, name) => (name in params ? String(params[name]) : placeholder));
}
