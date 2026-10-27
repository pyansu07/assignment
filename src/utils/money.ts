import { Prisma } from '@prisma/client';

/** NUMERIC(19,4): up to 15 integer digits and 4 fractional digits. */
export const MONEY_SCALE = 4;
export const MONEY_REGEX = /^\d{1,15}(\.\d{1,4})?$/;

/** Decimal string (always 4 fractional digits) for API output - never a JS float. */
export function formatMoney(value: Prisma.Decimal | string): string {
  return new Prisma.Decimal(value).toFixed(MONEY_SCALE);
}

export function isPositiveMoney(value: string): boolean {
  return MONEY_REGEX.test(value) && new Prisma.Decimal(value).gt(0);
}
