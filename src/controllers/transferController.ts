import type { Request, Response } from 'express';
import { transferSchema } from '../schemas/transaction';
import { transferService } from '../services/transferService';

export const transferController = {
  async create(req: Request, res: Response) {
    const body = transferSchema.parse(req.body ?? {});
    const transfer = await transferService.create({
      sourceAccountId: body.source_account_id,
      destinationAccountId: body.destination_account_id,
      amount: body.amount,
      description: body.description,
      referenceId: body.reference_id,
    });
    res.status(201).json(transfer);
  },
};
