import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { Db } from '../db/prisma';
import { AppError } from '../utils/errors';

/** Stable SHA-256 over the normalised request. Only this hash is stored, never the raw request. */
export function fingerprint(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export const idempotencyRepository = {
  /**
   * Looks up a key for this account. Must be called while holding the account row lock, which
   * serialises same-key requests: the second one sees the first one's committed record.
   * Returns the stored response for an identical request, null if the key is new, and throws
   * 409 if the key was already used for a different request.
   */
  async findReplay<T>(db: Db, accountId: string, key: string, requestHash: string): Promise<T | null> {
    const record = await db.idempotencyKey.findUnique({ where: { accountId_key: { accountId, key } } });
    if (!record) return null;
    if (record.requestHash !== requestHash) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used with a different request. No changes were made.',
      );
    }
    return record.response as T;
  },

  /** UNIQUE (account_id, key) is the backstop: a racing insert fails and rolls the whole operation back. */
  async save(db: Db, accountId: string, key: string, requestHash: string, response: unknown): Promise<void> {
    await db.idempotencyKey.create({
      data: { accountId, key, requestHash, response: response as Prisma.InputJsonValue },
    });
  },
};
