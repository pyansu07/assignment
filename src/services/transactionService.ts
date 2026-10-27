import type { TransactionType } from '@prisma/client';
import { prisma, TX_OPTIONS } from '../db/prisma';
import { accountRepository } from '../repositories/accountRepository';
import { transactionRepository } from '../repositories/transactionRepository';
import { Errors } from '../utils/errors';
import { toTransactionDto } from '../utils/serializers';

export interface CreateTransactionInput {
  accountId: string;
  type: TransactionType;
  amount: string;
  description: string;
  referenceId: string;
}

export const transactionService = {
  /**
   * Inserts the ledger entry and applies it to the balance in ONE database transaction.
   *  1. Lock the account row (FOR UPDATE) - serialises writers on this account.
   *  2. INSERT the entry; the UNIQUE (account_id, reference_id) constraint rejects duplicates.
   *  3. Apply the balance change; a debit is a conditional UPDATE (balance >= amount).
   * Any thrown error rolls back every step, so partial effects are impossible.
   */
  async create(input: CreateTransactionInput) {
    const created = await prisma.$transaction(async (tx) => {
      const locked = await accountRepository.lockByIds(tx, [input.accountId]);
      if (locked.length === 0) throw Errors.accountNotFound(input.accountId);

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
      return entry;
    }, TX_OPTIONS);
    return toTransactionDto(created);
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
