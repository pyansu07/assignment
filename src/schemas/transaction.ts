import { z } from 'zod';
import { amountSchema, descriptionSchema, referenceIdSchema, uuidSchema } from './common';

export const createTransactionSchema = z
  .object({
    type: z.enum(['credit', 'debit'], {
      errorMap: () => ({ message: "type must be either 'credit' or 'debit'" }),
    }),
    amount: amountSchema,
    description: descriptionSchema,
    reference_id: referenceIdSchema,
  })
  .strict();

export const listTransactionsQuerySchema = z
  .object({
    type: z.enum(['credit', 'debit'], { errorMap: () => ({ message: "type must be 'credit' or 'debit'" }) }).optional(),
    page: z
      .string()
      .regex(/^\d+$/, 'page must be a positive integer')
      .default('1')
      .transform(Number)
      .pipe(z.number().int().min(1, 'page must be >= 1').max(1_000_000)),
    limit: z
      .string()
      .regex(/^\d+$/, 'limit must be a positive integer')
      .default('20')
      .transform(Number)
      .pipe(z.number().int().min(1, 'limit must be >= 1').max(100, 'limit must be <= 100')),
  })
  .strict();

export const transferSchema = z
  .object({
    source_account_id: uuidSchema,
    destination_account_id: uuidSchema,
    amount: amountSchema,
    description: descriptionSchema.optional().default('Transfer'),
    reference_id: referenceIdSchema,
  })
  .strict()
  .refine((v) => v.source_account_id !== v.destination_account_id, {
    message: 'source and destination accounts must be different',
    path: ['destination_account_id'],
  });
