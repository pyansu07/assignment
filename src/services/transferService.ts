import { prisma, TX_OPTIONS } from '../db/prisma';
import { accountRepository } from '../repositories/accountRepository';
import { transactionRepository } from '../repositories/transactionRepository';
import { transferRepository } from '../repositories/transferRepository';
import { Errors } from '../utils/errors';
import { toTransferDto } from '../utils/serializers';

export interface TransferInput {
  sourceAccountId: string;
  destinationAccountId: string;
  amount: string;
  description: string;
  referenceId: string;
}

export const transferService = {
  /**
   * Atomic transfer: one DB transaction writes the transfer row, a debit entry on the source,
   * a credit entry on the destination, and both balance updates. Any failure rolls back all of it.
   * Both account rows are locked in ascending id order, so opposite transfers cannot deadlock.
   */
  async create(input: TransferInput) {
    const transferId = await prisma.$transaction(async (tx) => {
      const locked = await accountRepository.lockByIds(tx, [input.sourceAccountId, input.destinationAccountId]);
      for (const id of [input.sourceAccountId, input.destinationAccountId]) {
        if (!locked.includes(id)) throw Errors.accountNotFound(id);
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
      return id;
    }, TX_OPTIONS);

    const transfer = await transferRepository.findById(prisma, transferId);
    return toTransferDto(transfer!);
  },
};
