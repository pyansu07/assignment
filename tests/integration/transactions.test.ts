import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app, balanceOf, createAccount, expectLedgerConsistent, postTx, prisma, resetDb, tx } from '../helpers/utils';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('credit / debit', () => {
  it('credit increases and debit decreases the balance (spec example: 100,50,-30,-20)', async () => {
    const { id } = await createAccount();
    expect((await postTx(id, tx('credit', '100', 'r1'))).status).toBe(201);
    expect((await postTx(id, tx('credit', '50', 'r2'))).status).toBe(201);
    expect((await postTx(id, tx('debit', '30', 'r3'))).status).toBe(201);
    const last = await postTx(id, tx('debit', '20', 'r4'));
    expect(last.status).toBe(201);
    expect(last.body).toMatchObject({ account_id: id, type: 'debit', amount: '20.0000', reference_id: 'r4' });
    expect(await balanceOf(id)).toBe('100.0000');
    expect(await expectLedgerConsistent(id)).toEqual({ ledger: 100, stored: 100, count: 4 });
  });

  it('uses exact decimal arithmetic (no float drift)', async () => {
    const { id } = await createAccount();
    await postTx(id, tx('credit', '0.1', 'a'));
    await postTx(id, tx('credit', '0.2', 'b'));
    expect(await balanceOf(id)).toBe('0.3000');
  });

  it('rejects a debit exceeding the balance and creates no transaction', async () => {
    const { id } = await createAccount();
    await postTx(id, tx('credit', '100', 'c1'));
    const res = await postTx(id, tx('debit', '150', 'd1'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(await balanceOf(id)).toBe('100.0000');
    expect(await prisma.transaction.count({ where: { accountId: id } })).toBe(1);
    // the failed reference was not consumed - it can be retried after funding
    await postTx(id, tx('credit', '100', 'c2'));
    expect((await postTx(id, tx('debit', '150', 'd1'))).status).toBe(201);
  });

  it.each([['0'], ['0.0000'], ['-5'], ['abc'], ['1.23456'], ['1e3'], [''], ['9999999999999999'], [0], [-1], [null]])(
    'rejects invalid amount %j',
    async (amount) => {
      const { id } = await createAccount();
      const res = await postTx(id, tx('credit', amount as string, 'r'));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(await prisma.transaction.count()).toBe(0);
    },
  );

  it('accepts a plain JSON number amount exactly', async () => {
    const { id } = await createAccount();
    expect((await postTx(id, tx('credit', 10.25, 'n1'))).status).toBe(201);
    expect(await balanceOf(id)).toBe('10.2500');
  });

  it('rejects unsupported type, missing fields, unknown fields', async () => {
    const { id } = await createAccount();
    expect((await postTx(id, tx('refund' as 'credit', '5', 'r'))).status).toBe(400);
    expect((await postTx(id, { type: 'credit', amount: '5', description: 'x' })).status).toBe(400); // no reference
    expect((await postTx(id, { type: 'credit', amount: '5', reference_id: 'r' })).status).toBe(400); // no description
    expect((await postTx(id, { ...tx('credit', '5', 'r'), balance: '999' })).status).toBe(400);
    expect((await postTx(id, { ...tx('credit', '5', 'r'), id: 'x', created_at: 'y' })).status).toBe(400);
    expect(await prisma.transaction.count()).toBe(0);
  });

  it('rejects nonexistent (404) and malformed (400) account ids', async () => {
    const res = await postTx('11111111-1111-4111-8111-111111111111', tx('credit', '5', 'r'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_FOUND');
    expect((await postTx('nope', tx('credit', '5', 'r'))).status).toBe(400);
  });

  it('rejects an out-of-range resulting balance without side effects', async () => {
    const { id } = await createAccount();
    await postTx(id, tx('credit', '999999999999999', 'big1'));
    const res = await postTx(id, tx('credit', '999999999999999', 'big2'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(await prisma.transaction.count()).toBe(1);
  });
});

describe('idempotency & integrity', () => {
  it('duplicate reference on the same account -> 409, no new row, no balance change', async () => {
    const { id } = await createAccount();
    const first = await postTx(id, tx('credit', '100', 'dup'));
    const second = await postTx(id, tx('credit', '100', 'dup'));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('DUPLICATE_REFERENCE');
    expect(second.body.error.details.existing.id).toBe(first.body.id);
    expect(await balanceOf(id)).toBe('100.0000');
    expect(await prisma.transaction.count()).toBe(1);
  });

  it('allows the same reference on a different account', async () => {
    const a = await createAccount('A');
    const b = await createAccount('B');
    expect((await postTx(a.id, tx('credit', '10', 'shared'))).status).toBe(201);
    expect((await postTx(b.id, tx('credit', '10', 'shared'))).status).toBe(201);
  });

  it('rolls back the balance update when the transaction fails at commit', async () => {
    const { id } = await createAccount();
    await postTx(id, tx('credit', '100', 'seed'));
    // Deferred constraint trigger: the insert AND the balance update succeed, then COMMIT fails.
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION test_fail_at_commit() RETURNS trigger AS $$
      BEGIN
        IF NEW.description = '__fail__' THEN RAISE EXCEPTION 'simulated commit failure'; END IF;
        RETURN NULL;
      END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE CONSTRAINT TRIGGER test_fail_trigger AFTER INSERT ON transactions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_at_commit()`);
    try {
      const res = await postTx(id, { ...tx('credit', '50', 'boom'), description: '__fail__' });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toContain('simulated');
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER test_fail_trigger ON transactions');
      await prisma.$executeRawUnsafe('DROP FUNCTION test_fail_at_commit()');
    }
    expect(await balanceOf(id)).toBe('100.0000');
    expect(await prisma.transaction.count({ where: { referenceId: 'boom' } })).toBe(0);
    expect(await expectLedgerConsistent(id)).toMatchObject({ ledger: 100, stored: 100, count: 1 });
  });

  it('exposes no update/delete routes and the database blocks mutation', async () => {
    const { id } = await createAccount();
    const t = await postTx(id, tx('credit', '10', 'imm'));
    const url = `/accounts/${id}/transactions/${t.body.id}`;
    for (const m of ['put', 'patch', 'delete'] as const) {
      expect((await request(app)[m](url).send({ amount: '1' })).status).toBe(404);
      expect((await request(app)[m](`/accounts/${id}/transactions`).send({})).status).toBe(404);
    }
    await expect(prisma.$executeRaw`UPDATE transactions SET amount = 1`).rejects.toThrow();
    await expect(prisma.$executeRaw`DELETE FROM transactions`).rejects.toThrow();
    await expect(prisma.account.delete({ where: { id } })).rejects.toThrow();
    expect(await balanceOf(id)).toBe('10.0000');
  });
});
