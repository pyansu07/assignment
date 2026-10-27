import { describe, expect, it } from 'vitest';
import { amountSchema } from '../../src/schemas/common';
import { formatMoney } from '../../src/utils/money';

describe('amountSchema', () => {
  it.each([
    ['1', '1'],
    ['10.5', '10.5'],
    [' 0.0001 ', '0.0001'],
    [25, '25'],
    [1.25, '1.25'],
    ['999999999999999.9999', '999999999999999.9999'],
  ])('accepts %j', (input, expected) => {
    expect(amountSchema.parse(input)).toBe(expected);
  });

  it.each([
    '0',
    '0.0',
    '-1',
    '+1',
    '1.',
    '.5',
    '1e3',
    '1,5',
    'NaN',
    'Infinity',
    '1.00001',
    '1000000000000000',
    '',
    ' ',
    'abc',
    1e21,
    NaN,
    -3,
    null,
    undefined,
    {},
  ])('rejects %j', (input) => {
    expect(amountSchema.safeParse(input).success).toBe(false);
  });
});

describe('formatMoney', () => {
  it('always renders 4 decimals', () => {
    expect(formatMoney('5')).toBe('5.0000');
    expect(formatMoney('0.1')).toBe('0.1000');
  });
});
