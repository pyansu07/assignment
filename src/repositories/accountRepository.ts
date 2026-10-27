import type { Db } from '../db/prisma';

export const accountRepository = {
  create(db: Db, name: string) {
    return db.account.create({ data: { name } });
  },

  findById(db: Db, id: string) {
    return db.account.findUnique({ where: { id } });
  },

  /**
   * Locks the given account rows (ascending id order, so concurrent multi-account operations
   * always acquire locks in the same order and cannot deadlock). Returns the ids that exist.
   */
  async lockByIds(db: Db, ids: string[]): Promise<string[]> {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM accounts
      WHERE id = ANY(${ids}::uuid[])
      ORDER BY id
      FOR UPDATE`;
    return rows.map((r) => r.id);
  },

  /** Atomic conditional debit: only applies if funds suffice. Returns false when it did not apply. */
  async debitIfSufficient(db: Db, id: string, amount: string): Promise<boolean> {
    const count = await db.$executeRaw`
      UPDATE accounts SET balance = balance - ${amount}::numeric
      WHERE id = ${id}::uuid AND balance >= ${amount}::numeric`;
    return count === 1;
  },

  async credit(db: Db, id: string, amount: string): Promise<void> {
    await db.$executeRaw`
      UPDATE accounts SET balance = balance + ${amount}::numeric WHERE id = ${id}::uuid`;
  },
};
