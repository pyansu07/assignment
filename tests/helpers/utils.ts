import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/db/prisma';

export const app = createApp();
export { prisma };

/** Wipes all ledger data. Only ever runs against the *_test database (enforced in vitest.config.ts). */
export async function resetDb() {
  if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to truncate a non-test database');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE transactions, transfers, accounts CASCADE');
}

export async function createAccount(name = 'Alice') {
  const res = await request(app).post('/accounts').send({ name });
  return res.body as { id: string; name: string; balance: string; created_at: string };
}

export const postTx = (accountId: string, body: Record<string, unknown>) =>
  request(app).post(`/accounts/${accountId}/transactions`).send(body);

export const tx = (type: 'credit' | 'debit', amount: string | number, reference_id: string, description = 'test') => ({
  type,
  amount,
  description,
  reference_id,
});

export async function balanceOf(accountId: string): Promise<string> {
  const res = await request(app).get(`/accounts/${accountId}/balance`);
  return res.body.balance;
}

/** Ground truth: balance recomputed from the ledger must equal the stored balance. */
export async function expectLedgerConsistent(accountId: string) {
  const rows = await prisma.$queryRaw<{ ledger: string; stored: string; n: bigint }[]>`
    SELECT COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END), 0)::text AS ledger,
           a.balance::text AS stored, COUNT(t.id) AS n
    FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
    WHERE a.id = ${accountId}::uuid GROUP BY a.id`;
  return { ledger: Number(rows[0].ledger), stored: Number(rows[0].stored), count: Number(rows[0].n) };
}
