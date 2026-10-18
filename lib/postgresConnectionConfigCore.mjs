const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const SAFE_SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/;
const TEST_DATABASE_MARKER = /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i;

export class PostgresConnectionConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PostgresConnectionConfigurationError";
  }
}

const parseUrl = (raw, label) => {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new PostgresConnectionConfigurationError(`${label} is not a valid URL.`);
  }
  if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
    throw new PostgresConnectionConfigurationError(
      `${label} must use the postgres or postgresql protocol.`
    );
  }
  return url;
};

const databaseNameOf = (url) =>
  decodeURIComponent(url.pathname.replace(/^\//, ""));

/**
 * Resolve one URL for both node-postgres and Prisma's pg adapter.
 *
 * Prisma understands `?schema=...`; node-postgres does not. Passing the URL
 * only to `new Pool()` therefore leaves raw, unqualified SQL on `public`. The
 * startup `options` value below installs a search_path with no public fallback,
 * while the adapter option makes generated Prisma queries use the same schema.
 */
export const resolvePostgresConnectionConfig = (
  raw,
  { label = "DATABASE_URL", requireTestMarker = false } = {}
) => {
  if (!raw) {
    return {
      connectionString: raw,
      schema: null,
      poolOptions: undefined,
      database: "",
    };
  }

  const url = parseUrl(raw, label);
  const database = databaseNameOf(url);
  const schema = url.searchParams.get("schema")?.trim() || null;

  if (schema && !SAFE_SCHEMA_IDENTIFIER.test(schema)) {
    throw new PostgresConnectionConfigurationError(
      `${label} schema must be a simple lowercase PostgreSQL identifier.`
    );
  }

  if (
    requireTestMarker &&
    !TEST_DATABASE_MARKER.test(`${database}_${schema || ""}`)
  ) {
    throw new PostgresConnectionConfigurationError(
      `${label} database name or schema must contain a separate test marker.`
    );
  }

  const sslMode = url.searchParams.get("sslmode");
  if (
    ["prefer", "require", "verify-ca"].includes(sslMode || "") &&
    !url.searchParams.has("uselibpqcompat")
  ) {
    url.searchParams.set("uselibpqcompat", "true");
  }

  let poolOptions;
  if (schema) {
    const existingOptions = url.searchParams.get("options")?.trim();
    if (existingOptions && /(?:^|\s)(?:-c\s*)?search_path\s*=/i.test(existingOptions)) {
      throw new PostgresConnectionConfigurationError(
        `${label} must not set search_path in both schema and options.`
      );
    }
    poolOptions = [existingOptions, `-c search_path=${schema}`]
      .filter(Boolean)
      .join(" ");
    // These are Prisma URL parameters, not node-postgres connection-string
    // parameters. The equivalent startup option is passed to Pool directly.
    url.searchParams.delete("schema");
    url.searchParams.delete("options");
  }

  return {
    connectionString: url.toString(),
    schema,
    poolOptions,
    database,
  };
};

export const PRISMA_TRANSACTION_MAX_WAIT_MIN_MS = 2_000;
export const PRISMA_TRANSACTION_MAX_WAIT_MAX_MS = 15_000;

/**
 * Optional default for how long an interactive transaction may wait for a pool
 * connection before Prisma gives up with P2028.
 *
 * Unset keeps Prisma's own default (2 s), so an environment that never sets it
 * behaves exactly as before. It exists for a database whose fresh connection
 * alone takes longer than that: the dev environment's database measured about
 * 2.5 s per new connection from the app's region, so the first transaction
 * after the pool went idle (sign-in, rate limits) always failed. A call that
 * passes its own `maxWait` still overrides this.
 */
export const resolvePrismaTransactionOptions = (
  raw,
  { label = "PRISMA_TRANSACTION_MAX_WAIT_MS" } = {}
) => {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return undefined;
  }
  const text = String(raw).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new PostgresConnectionConfigurationError(
      `${label} must be a whole number of milliseconds.`
    );
  }
  const maxWait = Number(text);
  if (
    maxWait < PRISMA_TRANSACTION_MAX_WAIT_MIN_MS ||
    maxWait > PRISMA_TRANSACTION_MAX_WAIT_MAX_MS
  ) {
    throw new PostgresConnectionConfigurationError(
      `${label} must be between ${PRISMA_TRANSACTION_MAX_WAIT_MIN_MS} and ${PRISMA_TRANSACTION_MAX_WAIT_MAX_MS}.`
    );
  }
  return { maxWait };
};

/**
 * Roles, credentials and query parameters may differ while still naming the
 * same physical database. Key rotation and `?schema=...` must not defeat a
 * destructive-test comparison.
 */
export const postgresDatabaseTargetKey = (raw) => {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!POSTGRES_PROTOCOLS.has(url.protocol)) return null;
  const port = url.port || "5432";
  const host = url.hostname.toLowerCase();
  const database = databaseNameOf(url).toLowerCase();
  if (!host || !database) return null;
  return `${host}:${port}/${database}`;
};

export const isSamePostgresDatabaseTarget = (left, right) => {
  const leftKey = postgresDatabaseTargetKey(left);
  const rightKey = postgresDatabaseTargetKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
};
