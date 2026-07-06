// lib/prisma.ts
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// 💡 개발 환경(핫 리로드)에서 DB 커넥션이 무한 생성되는 것을 방지하는 글로벌 캐시
const globalForPrisma = global as unknown as { prisma: PrismaClient };

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);

// 💡 여기서 export const prisma 형식으로 '이름을 지정해서' 내보냅니다!
export const prisma =
    globalForPrisma.prisma ||
    new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;