import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fail = (message, details = {}) => {
  console.error(
    JSON.stringify({ stage: "refresh-test-database", ok: false, message, ...details })
  );
  process.exit(1);
};

const args = new Set(process.argv.slice(2));
if (!args.has("--yes")) {
  fail(
    "Refusing to run without --yes. This overwrites every table in the target database. Re-run as: npm run db:refresh-test -- --yes"
  );
}

const sourceRaw = process.env.DIRECT_DATABASE_URL?.trim();
const targetRaw = process.env.TEST_DATABASE_URL?.trim();

if (!sourceRaw) fail("DIRECT_DATABASE_URL is required (the production direct connection to dump from).");
if (!targetRaw) fail("TEST_DATABASE_URL is required (the dedicated test database to overwrite).");

const parseDirectUrl = (raw, label) => {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${label} is not a valid URL.`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    fail(`${label} must use the postgres or postgresql protocol.`);
  }
  if (url.searchParams.get("pgbouncer") === "true" || url.searchParams.get("pool_mode")) {
    fail(`${label} appears to be a pooled connection URL; use a direct (non-pooled) connection.`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) fail(`${label} must include a database name.`);
  return {
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    schema: url.searchParams.get("schema") || "",
    sslmode: url.searchParams.get("sslmode") || "require",
  };
};

const source = parseDirectUrl(sourceRaw, "DIRECT_DATABASE_URL");
const target = parseDirectUrl(targetRaw, "TEST_DATABASE_URL");

// Prisma Postgres always reports the database name as "postgres" for every
// project (AIHub and AIHub-Test both connect to host/db "db.prisma.io/postgres").
// The unique identity of a Prisma Postgres database is its generated username,
// not the host or database path, so that's what must differ here.
if (targetRaw === sourceRaw || target.user === source.user) {
  fail(
    "TEST_DATABASE_URL uses the same Prisma Postgres credentials as DIRECT_DATABASE_URL, which means they are the same database. Refusing to overwrite production.",
    { sourceUserPrefix: source.user.slice(0, 6), targetUserPrefix: target.user.slice(0, 6) }
  );
}

const requireBinary = (command) => {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  if (result.error) {
    fail(`${command} was not found on PATH. Install the PostgreSQL 17 client tools first.`, {
      hint:
        process.platform === "darwin"
          ? "brew install postgresql@17"
          : process.platform === "win32"
            ? "Install via https://www.postgresql.org/download/windows/ and add the bin directory to PATH"
            : "Install the postgresql-client-17 package for your distribution",
    });
  }
};
requireBinary("pg_dump");
requireBinary("pg_restore");

// Credentials go through PGPASSWORD, never argv, so they never show up in a process listing.
const connectionArgs = (endpoint) => {
  const connArgs = ["-h", endpoint.host, "-p", endpoint.port, "-U", endpoint.user, "-d", endpoint.database];
  if (endpoint.schema) connArgs.push("--schema", endpoint.schema);
  return connArgs;
};
const connectionEnv = (endpoint) => ({
  ...process.env,
  PGPASSWORD: endpoint.password,
  PGSSLMODE: endpoint.sslmode,
});

const redact = (text, endpoints) => {
  let out = text;
  for (const endpoint of endpoints) {
    if (endpoint.password) out = out.replaceAll(endpoint.password, "[redacted]");
  }
  return out;
};

const run = (command, commandArgs, env, label, endpoints) => {
  console.log(`[refresh-test-database] ${label}`);
  const result = spawnSync(command, commandArgs, { env, stdio: ["ignore", "inherit", "pipe"] });
  if (result.error) fail(`${label} failed to start.`, { error: String(result.error) });
  if (result.status !== 0) {
    fail(`${label} exited with a non-zero status.`, {
      status: result.status,
      stderr: redact(result.stderr?.toString().slice(0, 2000) || "", endpoints),
    });
  }
  if (result.stderr?.length) {
    process.stderr.write(redact(result.stderr.toString(), endpoints));
  }
};

const dumpFile = join(tmpdir(), `tomverse-db-refresh-${randomUUID()}.dump`);

console.log(
  JSON.stringify({
    stage: "refresh-test-database",
    // host/database look identical for every Prisma Postgres project (both are
    // always db.prisma.io/postgres) — the credential prefix is what actually
    // distinguishes AIHub from AIHub-Test, so surface it here for a sanity check.
    source: { host: source.host, database: source.database, userPrefix: source.user.slice(0, 6) },
    target: { host: target.host, database: target.database, userPrefix: target.user.slice(0, 6) },
  })
);

try {
  run(
    "pg_dump",
    [...connectionArgs(source), "-F", "c", "--no-owner", "--no-privileges", "-f", dumpFile],
    connectionEnv(source),
    `Dumping ${source.database} from ${source.host}`,
    [source, target]
  );

  run(
    "pg_restore",
    [...connectionArgs(target), "--no-owner", "--no-privileges", "--clean", "--if-exists", dumpFile],
    connectionEnv(target),
    `Restoring into ${target.database} on ${target.host} (existing objects are dropped first)`,
    [source, target]
  );

  console.log(
    JSON.stringify({ stage: "refresh-test-database", ok: true, message: "Test database refreshed from production." })
  );
} finally {
  await unlink(dumpFile).catch(() => undefined);
}
