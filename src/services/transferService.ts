import { prisma, TX_OPTIONS } from '../db/prisma';
import { accountRepository } from '../repositories/accountRepository';
import { fingerprint, idempotencyRepository } from '../repositories/idempotencyRepository';
import { transactionRepository } from '../repositories/transactionRepository';
import { transferRepository } from '../repositories/transferRepository';
import { Errors } from '../utils/errors';
import { formatMoney } from '../utils/money';
import { toTransferDto } from '../utils/serializers';

export interface TransferInput {
  sourceAccountId: string;
  destinationAccountId: string;
  amount: string;
  description: string;
  referenceId: string;
}

type TransferDto = ReturnType<typeof toTransferDto>;

export const transferService = {
  /**
   * Atomic transfer: one DB transaction writes the transfer row, a debit entry on the source,
   * a credit entry on the destination, and both balance updates. Any failure rolls back all of it.
   * Both account rows are locked in ascending id order, so opposite transfers cannot deadlock.
   *
   * Idempotency-Key is scoped to the SOURCE account. Same-key requests all lock that account, so
   * they run one after another: the first executes, the rest replay its stored result.
   */
  async create(input: TransferInput, idempotencyKey?: string): Promise<{ body: TransferDto; replayed: boolean }> {
    const requestHash = fingerprint([
      'transfer',
      input.sourceAccountId,
      input.destinationAccountId,
      formatMoney(input.amount),
      input.description,
      input.referenceId,
    ]);

    return prisma.$transaction(async (tx) => {
      const locked = await accountRepository.lockByIds(tx, [input.sourceAccountId, input.destinationAccountId]);
      for (const id of [input.sourceAccountId, input.destinationAccountId]) {
        if (!locked.includes(id)) throw Errors.accountNotFound(id);
      }

      if (idempotencyKey) {
        const replay = await idempotencyRepository.findReplay<TransferDto>(
          tx,
          input.sourceAccountId,
          idempotencyKey,
          requestHash,
        );
        if (replay) return { body: replay, replayed: true };
      }

      const id = await transferRepository.insert(tx, input);
      if (!id) {
        const existing = await transferRepository.findByReference(tx, input.sourceAccountId, input.referenceId);
        throw Errors.duplicateReference(existing ? toTransferDto(existing) : undefined);
      }

      if (!(await accountRepository.debitIfSufficient(tx, input.sourceAccountId, input.amount))) {
        throw Errors.insufficientBalance();
      }
      await accountRepository.credit(tx, input.destinationAccountId, input.amount);

      // Two linked immutable ledger entries sharing the transfer id.
      const common = {
        amount: input.amount,
        description: input.description,
        referenceId: `transfer:${id}`,
        transferId: id,
      };
      const debit = await transactionRepository.insert(tx, {
        ...common,
        accountId: input.sourceAccountId,
        type: 'debit',
      });
      const credit = await transactionRepository.insert(tx, {
        ...common,
        accountId: input.destinationAccountId,
        type: 'credit',
      });
      if (!debit || !credit) throw Errors.duplicateReference(undefined);

      const body = toTransferDto((await transferRepository.findById(tx, id))!);
      if (idempotencyKey) {
        await idempotencyRepository.save(tx, input.sourceAccountId, idempotencyKey, requestHash, body);
      }
      return { body, replayed: false };
    }, TX_OPTIONS);
  },
};
