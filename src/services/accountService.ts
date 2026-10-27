import { prisma } from '../db/prisma';
import { accountRepository } from '../repositories/accountRepository';
import { Errors } from '../utils/errors';
import { formatMoney } from '../utils/money';

export const accountService = {
  create: (name: string) => accountRepository.create(prisma, name),

  async getBalance(accountId: string) {
    const account = await accountRepository.findById(prisma, accountId);
    if (!account) throw Errors.accountNotFound(accountId);
    return { account_id: account.id, balance: formatMoney(account.balance) };
  },
};
