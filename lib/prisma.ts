import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

// 환경변수에서 데이터베이스 주소를 가져옵니다.
const connectionString = `${process.env.DATABASE_URL}`;

// PostgreSQL 연결 풀과 Prisma 어댑터를 생성합니다.
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// PrismaClient에 adapter를 주입하여 생성합니다.
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
