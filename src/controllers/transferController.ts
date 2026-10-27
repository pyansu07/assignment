import type { Request, Response } from 'express';
import { idempotencyHeaderSchema } from '../schemas/common';
import { transferSchema } from '../schemas/transaction';
import { transferService } from '../services/transferService';

export const transferController = {
  async create(req: Request, res: Response) {
    const idempotencyKey = idempotencyHeaderSchema.parse(req.headers)['idempotency-key'];
    const body = transferSchema.parse(req.body ?? {});
    const { body: transfer, replayed } = await transferService.create(
      {
        sourceAccountId: body.source_account_id,
        destinationAccountId: body.destination_account_id,
        amount: body.amount,
        description: body.description,
        referenceId: body.reference_id,
      },
      idempotencyKey,
    );
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(201).json(transfer);
  },
};
