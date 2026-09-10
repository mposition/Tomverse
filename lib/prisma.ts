// lib/prisma.ts
import { Prisma, PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { resolvePostgresConnectionConfig } from '@/lib/postgresConnectionConfigCore.mjs';

const globalForPrisma = global as unknown as { prisma: PrismaClient };
const validLogLevels = new Set(["query", "info", "warn", "error"]);
const prismaLogLevels = (process.env.PRISMA_CLIENT_LOG || "")
    .split(",")
    .map((level) => level.trim())
    .filter((level): level is Prisma.LogLevel => validLogLevels.has(level));

const postgresConfig = resolvePostgresConnectionConfig(
    process.env.DATABASE_URL,
    {
        requireTestMarker:
            process.env.NODE_ENV === "test" && Boolean(process.env.DATABASE_URL),
    }
);

const pool = new Pool({
    connectionString: postgresConfig.connectionString,
    options: postgresConfig.poolOptions,
});

const adapter = new PrismaPg(
    pool,
    postgresConfig.schema ? { schema: postgresConfig.schema } : undefined
);

export const prisma =
    globalForPrisma.prisma ||
    new PrismaClient({
        adapter,
        log: prismaLogLevels.length > 0 ? prismaLogLevels : undefined,
    });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
