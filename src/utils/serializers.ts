import type { Account, Transaction, Transfer } from '@prisma/client';
import { formatMoney } from './money';

export const toAccountDto = (a: Account) => ({
  id: a.id,
  name: a.name,
  balance: formatMoney(a.balance),
  created_at: a.createdAt.toISOString(),
});

export const toTransactionDto = (t: Transaction) => ({
  id: t.id,
  account_id: t.accountId,
  type: t.type,
  amount: formatMoney(t.amount),
  description: t.description,
  reference_id: t.referenceId,
  transfer_id: t.transferId,
  created_at: t.createdAt.toISOString(),
});

export const toTransferDto = (t: Transfer & { entries: Transaction[] }) => ({
  id: t.id,
  source_account_id: t.sourceAccountId,
  destination_account_id: t.destinationAccountId,
  amount: formatMoney(t.amount),
  description: t.description,
  reference_id: t.referenceId,
  created_at: t.createdAt.toISOString(),
  entries: t.entries.map(toTransactionDto),
});
