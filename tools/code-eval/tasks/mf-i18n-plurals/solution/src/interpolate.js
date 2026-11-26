// Replaces {name} with params.name. Numbers are formatted for `locale`.
// A placeholder without a param is left as it is.
export function interpolate(message, params = {}, locale = "en") {
    return message.replace(/\{(\w+)\}/g, (placeholder, name) => {
        if (!Object.hasOwn(params, name)) return placeholder;
        const value = params[name];
        return typeof value === "number" ? new Intl.NumberFormat(locale).format(value) : String(value);
    });
}
