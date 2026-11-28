export const DEFAULTS = Object.freeze({
    server: { host: "127.0.0.1", port: 3000 },
    debug: false,
    tags: [],
    db: { url: "sqlite://local.db", pool: { min: 1, max: 5 } },
});
