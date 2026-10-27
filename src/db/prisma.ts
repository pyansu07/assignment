import { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env';

export const prisma = new PrismaClient({
  datasourceUrl: env.databaseUrl,
  log: env.nodeEnv === 'development' ? ['warn', 'error'] : ['error'],
});

/** Client handed to repositories; works both inside and outside an interactive transaction. */
export type Db = PrismaClient | Prisma.TransactionClient;

/** Options for every ledger write transaction. Row locks make writers queue, so allow generous waits. */
export const TX_OPTIONS = { maxWait: 15_000, timeout: 15_000 } as const;
