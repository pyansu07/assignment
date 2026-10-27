import type { TransactionType } from '@prisma/client';
import { prisma, TX_OPTIONS } from '../db/prisma';
import { accountRepository } from '../repositories/accountRepository';
import { fingerprint, idempotencyRepository } from '../repositories/idempotencyRepository';
import { transactionRepository } from '../repositories/transactionRepository';
import { Errors } from '../utils/errors';
import { formatMoney } from '../utils/money';
import { toTransactionDto } from '../utils/serializers';

export interface CreateTransactionInput {
  accountId: string;
  type: TransactionType;
  amount: string;
  description: string;
  referenceId: string;
}

type TransactionDto = ReturnType<typeof toTransactionDto>;

export const transactionService = {
  /**
   * Inserts the ledger entry and applies it to the balance in ONE database transaction.
   *  1. Lock the account row (FOR UPDATE) - serialises writers on this account.
   *  2. If an Idempotency-Key was sent and already used: replay the stored result (same request)
   *     or reject with 409 (different request). Nothing else runs.
   *  3. INSERT the entry; the UNIQUE (account_id, reference_id) constraint rejects duplicates.
   *  4. Apply the balance change; a debit is a conditional UPDATE (balance >= amount).
   *  5. Record the key and response in the same transaction.
   * Any thrown error rolls back every step - including the key - so partial effects are impossible
   * and a failed request never reserves its key.
   */
  async create(
    input: CreateTransactionInput,
    idempotencyKey?: string,
  ): Promise<{ body: TransactionDto; replayed: boolean }> {
    // Normalised so "10" and "10.0000" are the same request.
    const requestHash = fingerprint([
      'transaction',
      input.accountId,
      input.type,
      formatMoney(input.amount),
      input.description,
      input.referenceId,
    ]);

    return prisma.$transaction(async (tx) => {
      const locked = await accountRepository.lockByIds(tx, [input.accountId]);
      if (locked.length === 0) throw Errors.accountNotFound(input.accountId);

      if (idempotencyKey) {
        const replay = await idempotencyRepository.findReplay<TransactionDto>(
          tx,
          input.accountId,
          idempotencyKey,
          requestHash,
        );
        if (replay) return { body: replay, replayed: true };
      }

      const entry = await transactionRepository.insert(tx, input);
      if (!entry) {
        const existing = await transactionRepository.findByReference(tx, input.accountId, input.referenceId);
        throw Errors.duplicateReference(existing ? toTransactionDto(existing) : undefined);
      }

      if (input.type === 'credit') {
        await accountRepository.credit(tx, input.accountId, input.amount);
      } else if (!(await accountRepository.debitIfSufficient(tx, input.accountId, input.amount))) {
        throw Errors.insufficientBalance();
      }

      const body = toTransactionDto(entry);
      if (idempotencyKey) {
        await idempotencyRepository.save(tx, input.accountId, idempotencyKey, requestHash, body);
      }
      return { body, replayed: false };
    }, TX_OPTIONS);
  },

  async list(params: { accountId: string; type?: TransactionType; page: number; limit: number }) {
    // Repeatable read: the existence check, count and page all come from one consistent snapshot.
    const { total, items } = await prisma.$transaction(
      async (tx) => {
        const account = await accountRepository.findById(tx, params.accountId);
        if (!account) throw Errors.accountNotFound(params.accountId);
        return transactionRepository.list(tx, params);
      },
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      data: items.map(toTransactionDto),
      pagination: {
        page: params.page,
        limit: params.limit,
        total_records: total,
        total_pages: Math.ceil(total / params.limit),
      },
    };
  },
};
