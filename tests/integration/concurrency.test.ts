import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { balanceOf, createAccount, expectLedgerConsistent, postTx, prisma, resetDb, tx } from '../helpers/utils';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('concurrency', () => {
  it('concurrent debits never overspend: exactly the affordable ones succeed', async () => {
    const { id } = await createAccount();
    await postTx(id, tx('credit', '100', 'seed'));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => postTx(id, tx('debit', '30', `d${i}`))));
    const ok = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 409 && r.body.error.code === 'INSUFFICIENT_BALANCE').length;
    expect(ok).toBe(3); // floor(100 / 30)
    expect(rejected).toBe(17);
    expect(await balanceOf(id)).toBe('10.0000');
    expect(await prisma.transaction.count({ where: { accountId: id, type: 'debit' } })).toBe(3);
    expect(await expectLedgerConsistent(id)).toEqual({ ledger: 10, stored: 10, count: 4 });
  });

  it('concurrent requests with the same reference apply the effect at most once', async () => {
    const { id } = await createAccount();
    const results = await Promise.all(Array.from({ length: 15 }, () => postTx(id, tx('credit', '25', 'same-ref'))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === 'DUPLICATE_REFERENCE')).toHaveLength(14);
    expect(await balanceOf(id)).toBe('25.0000');
    expect(await prisma.transaction.count()).toBe(1);
  });

  it('mixed concurrent credits and debits keep ledger and balance consistent', async () => {
    const { id } = await createAccount();
    await postTx(id, tx('credit', '50', 'seed'));
    const reqs = Array.from({ length: 30 }, (_, i) => postTx(id, tx(i % 2 === 0 ? 'credit' : 'debit', '7.5', `m${i}`)));
    const results = await Promise.all(reqs);
    expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);
    const consistent = await expectLedgerConsistent(id);
    expect(consistent.stored).toBe(consistent.ledger);
    expect(consistent.stored).toBeGreaterThanOrEqual(0);
    expect(consistent.count).toBe(1 + results.filter((r) => r.status === 201).length);
  });
});
