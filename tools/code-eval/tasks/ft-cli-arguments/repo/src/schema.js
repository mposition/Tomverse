// Fills in defaults so the parser does not have to.
export function normalizeSchema(schema = {}) {
    const options = {};
    for (const [name, spec] of Object.entries(schema.options ?? {})) {
        options[name] = { type: "boolean", multiple: false, ...spec };
    }
    return { options };
}
