import pg from "pg";

const { Client } = pg;
const directUrl = process.env.DIRECT_DATABASE_URL;

const fail = (message, details = {}) => {
    console.error(
        JSON.stringify({
            stage: "direct-database-check",
            ok: false,
            message,
            ...details,
        })
    );
    process.exit(1);
};

console.log("[migration-check 1/3] Validating DIRECT_DATABASE_URL");

if (!directUrl) {
    fail("DIRECT_DATABASE_URL is missing or resolved to an empty value.");
}

let parsed;
try {
    parsed = new URL(directUrl);
} catch {
    fail("DIRECT_DATABASE_URL is not a valid URL.");
}

if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    fail(
        "DIRECT_DATABASE_URL must use the postgresql:// or postgres:// protocol.",
        { protocol: parsed.protocol || "unknown" }
    );
}

if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    fail("DIRECT_DATABASE_URL must include a hostname and database name.");
}

if (
    parsed.searchParams.get("pgbouncer") === "true" ||
    parsed.searchParams.get("pool_mode")
) {
    fail("DIRECT_DATABASE_URL appears to be a pooled connection URL.");
}

console.log(
    JSON.stringify({
        stage: "direct-database-check",
        ok: true,
        protocol: parsed.protocol,
        host: parsed.hostname,
        port: parsed.port || "5432",
        sslMode: parsed.searchParams.get("sslmode") || "provider-default",
    })
);

console.log("[migration-check 2/3] Testing PostgreSQL connectivity");

const client = new Client({
    connectionString: directUrl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    application_name: "tomverse-prisma-migrate-check",
});

try {
    await client.connect();
    await client.query("SELECT 1");

    console.log("[migration-check 3/3] Testing PostgreSQL advisory locks");
    const result = await client.query(`
        WITH lock_attempt AS MATERIALIZED (
            SELECT pg_try_advisory_lock(72707369) AS acquired
        )
        SELECT
            acquired,
            CASE
                WHEN acquired THEN pg_advisory_unlock(72707369)
                ELSE false
            END AS released
        FROM lock_attempt
    `);

    if (!result.rows[0]?.acquired || !result.rows[0]?.released) {
        fail("The database connection could not acquire and release an advisory lock.");
    }

    console.log("Direct PostgreSQL connection and advisory locks are available.");
} catch (error) {
    const candidate = error && typeof error === "object" ? error : {};
    let message =
        typeof candidate.message === "string"
            ? candidate.message
            : "Unknown PostgreSQL connection error.";

    const secrets = [
        directUrl,
        decodeURIComponent(parsed.password || ""),
        decodeURIComponent(parsed.username || ""),
    ].filter(Boolean);
    for (const secret of secrets) {
        message = message.replaceAll(secret, "[redacted]");
    }

    fail("Direct PostgreSQL connectivity test failed.", {
        errorName:
            typeof candidate.name === "string" ? candidate.name : undefined,
        errorCode:
            typeof candidate.code === "string" ? candidate.code : undefined,
        errorMessage: message.slice(0, 500),
    });
} finally {
    await client.end().catch(() => undefined);
}
