import type { Request, Response } from 'express';
import { accountParamsSchema } from '../schemas/account';
import { createTransactionSchema, listTransactionsQuerySchema } from '../schemas/transaction';
import { transactionService } from '../services/transactionService';

export const transactionController = {
  async create(req: Request, res: Response) {
    const { accountId } = accountParamsSchema.parse(req.params);
    const body = createTransactionSchema.parse(req.body ?? {});
    const transaction = await transactionService.create({
      accountId,
      type: body.type,
      amount: body.amount,
      description: body.description,
      referenceId: body.reference_id,
    });
    res.status(201).json(transaction);
  },

  async list(req: Request, res: Response) {
    const { accountId } = accountParamsSchema.parse(req.params);
    const query = listTransactionsQuerySchema.parse(req.query);
    res.status(200).json(await transactionService.list({ accountId, ...query }));
  },
};
