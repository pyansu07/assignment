import type { Request, Response } from 'express';
import { accountParamsSchema, createAccountSchema } from '../schemas/account';
import { accountService } from '../services/accountService';
import { toAccountDto } from '../utils/serializers';

export const accountController = {
  async create(req: Request, res: Response) {
    const { name } = createAccountSchema.parse(req.body ?? {});
    const account = await accountService.create(name);
    res.status(201).json(toAccountDto(account));
  },

  async getBalance(req: Request, res: Response) {
    const { accountId } = accountParamsSchema.parse(req.params);
    res.status(200).json(await accountService.getBalance(accountId));
  },
};
