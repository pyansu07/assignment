import { z } from 'zod';
import { uuidSchema } from './common';

// .strict(): client-supplied balance / id / created_at (or any unknown field) is rejected.
export const createAccountSchema = z
  .object({ name: z.string({ required_error: 'name is required' }).trim().min(1, 'name must not be empty').max(100) })
  .strict();

export const accountParamsSchema = z.object({ accountId: uuidSchema });
