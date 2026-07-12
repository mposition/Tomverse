// lib/prisma.ts
import { Prisma, PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = global as unknown as { prisma: PrismaClient };
const validLogLevels = new Set(["query", "info", "warn", "error"]);
const prismaLogLevels = (process.env.PRISMA_CLIENT_LOG || "")
    .split(",")
    .map((level) => level.trim())
    .filter((level): level is Prisma.LogLevel => validLogLevels.has(level));

const normalizePostgresConnectionString = (value: string | undefined) => {
    if (!value) return value;
    try {
        const url = new URL(value);
        const sslMode = url.searchParams.get("sslmode");
        if (
            (sslMode === "prefer" ||
                sslMode === "require" ||
                sslMode === "verify-ca") &&
            !url.searchParams.has("uselibpqcompat")
        ) {
            url.searchParams.set("uselibpqcompat", "true");
            return url.toString();
        }
    } catch {
        return value;
    }
    return value;
};

const pool = new Pool({
    connectionString: normalizePostgresConnectionString(process.env.DATABASE_URL),
});

const adapter = new PrismaPg(pool);

export const prisma =
    globalForPrisma.prisma ||
    new PrismaClient({
        adapter,
        log: prismaLogLevels.length > 0 ? prismaLogLevels : undefined,
    });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
