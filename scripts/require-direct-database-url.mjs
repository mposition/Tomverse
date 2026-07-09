const directUrl = process.env.DIRECT_DATABASE_URL;

if (!directUrl) {
    console.error(
        "DIRECT_DATABASE_URL is required for production database migrations."
    );
    process.exit(1);
}

let parsed;
try {
    parsed = new URL(directUrl);
} catch {
    console.error("DIRECT_DATABASE_URL is not a valid URL.");
    process.exit(1);
}

if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    console.error(
        "DIRECT_DATABASE_URL must be a direct PostgreSQL URL, not a Prisma Accelerate or pooled URL."
    );
    process.exit(1);
}

console.log("Direct PostgreSQL migration connection is configured.");
