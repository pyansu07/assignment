import type { Prisma, TransactionType } from '@prisma/client';
import type { Db } from '../db/prisma';

export interface NewTransaction {
  accountId: string;
  type: TransactionType;
  amount: string;
  description: string;
  referenceId: string;
  transferId?: string;
}

export const transactionRepository = {
  /**
   * Inserts a ledger entry. The composite UNIQUE (account_id, reference_id) constraint is the
   * final arbiter of duplicates: ON CONFLICT DO NOTHING returns no row when it already exists.
   */
  async insert(db: Db, t: NewTransaction) {
    const rows = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO transactions (account_id, type, amount, description, reference_id, transfer_id)
      VALUES (${t.accountId}::uuid, ${t.type}::transaction_type, ${t.amount}::numeric,
              ${t.description}, ${t.referenceId}, ${t.transferId ?? null}::uuid)
      ON CONFLICT (account_id, reference_id) DO NOTHING
      RETURNING id::text AS id`;
    if (rows.length === 0) return null;
    return db.transaction.findUniqueOrThrow({ where: { id: rows[0].id } });
  },

  findByReference(db: Db, accountId: string, referenceId: string) {
    return db.transaction.findUnique({
      where: { accountId_referenceId: { accountId, referenceId } },
    });
  },

  async list(db: Db, params: { accountId: string; type?: TransactionType; page: number; limit: number }) {
    // The same `where` feeds both the count and the page, so metadata always matches the filter.
    const where: Prisma.TransactionWhereInput = {
      accountId: params.accountId,
      ...(params.type ? { type: params.type } : {}),
    };
    const total = await db.transaction.count({ where });
    const items = await db.transaction.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    });
    return { total, items };
  },
};
