import type { Db } from '../db/prisma';

export interface NewTransfer {
  sourceAccountId: string;
  destinationAccountId: string;
  amount: string;
  description: string;
  referenceId: string;
}

export const transferRepository = {
  /** Returns the new transfer id, or null if (source_account_id, reference_id) already exists. */
  async insert(db: Db, t: NewTransfer) {
    const rows = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO transfers (source_account_id, destination_account_id, amount, description, reference_id)
      VALUES (${t.sourceAccountId}::uuid, ${t.destinationAccountId}::uuid, ${t.amount}::numeric,
              ${t.description}, ${t.referenceId})
      ON CONFLICT (source_account_id, reference_id) DO NOTHING
      RETURNING id::text AS id`;
    return rows.length ? rows[0].id : null;
  },

  findById(db: Db, id: string) {
    return db.transfer.findUnique({ where: { id }, include: { entries: { orderBy: { type: 'asc' } } } });
  },

  findByReference(db: Db, sourceAccountId: string, referenceId: string) {
    return db.transfer.findUnique({
      where: { sourceAccountId_referenceId: { sourceAccountId, referenceId } },
      include: { entries: { orderBy: { type: 'asc' } } },
    });
  },
};
