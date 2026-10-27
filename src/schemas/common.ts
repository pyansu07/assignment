import { z } from 'zod';
import { isPositiveMoney, MONEY_REGEX } from '../utils/money';

export const uuidSchema = z.string().uuid('must be a valid UUID');

/**
 * Money is accepted as a decimal string ("12.50"). A plain JSON number is also accepted for
 * convenience, but is converted with String() and held to the same strict format, so 1e21,
 * NaN, or more than 4 decimals are rejected rather than rounded.
 */
export const amountSchema = z
  .union([z.string(), z.number()], { errorMap: () => ({ message: 'amount is required (decimal string)' }) })
  .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (!/^\d+(\.\d+)?$/.test(v)) return fail('amount must be a plain positive decimal such as "10.50"');
    if (!MONEY_REGEX.test(v)) return fail('amount supports at most 15 integer digits and 4 decimal places');
    if (!isPositiveMoney(v)) return fail('amount must be greater than 0');
  });

export const descriptionSchema = z.string().trim().min(1, 'description is required').max(500);
export const referenceIdSchema = z.string().trim().min(1, 'reference_id is required').max(100);
