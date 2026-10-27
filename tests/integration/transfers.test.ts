import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app, balanceOf, createAccount, expectLedgerConsistent, postTx, prisma, resetDb, tx } from '../helpers/utils';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const transfer = (body: Record<string, unknown>) => request(app).post('/transfers').send(body);

async function pair(a = '100', b = '50') {
  const A = await createAccount('A');
  const B = await createAccount('B');
  await postTx(A.id, tx('credit', a, 'seedA'));
  await postTx(B.id, tx('credit', b, 'seedB'));
  return { A, B };
}

describe('transfers', () => {
  it('moves money and writes linked debit + credit entries (spec example)', async () => {
    const { A, B } = await pair();
    const res = await transfer({
      source_account_id: A.id,
      destination_account_id: B.id,
      amount: '30',
      reference_id: 't1',
    });
    expect(res.status).toBe(201);
    expect(await balanceOf(A.id)).toBe('70.0000');
    expect(await balanceOf(B.id)).toBe('80.0000');
    expect(res.body.entries).toHaveLength(2);
    const types = res.body.entries.map((e: { type: string }) => e.type).sort();
    expect(types).toEqual(['credit', 'debit']);
    expect(res.body.entries.every((e: { transfer_id: string }) => e.transfer_id === res.body.id)).toBe(true);
    expect((await expectLedgerConsistent(A.id)).stored).toBe(70);
    expect((await expectLedgerConsistent(B.id)).stored).toBe(80);
  });

  it('rejects insufficient funds with no partial effect', async () => {
    const { A, B } = await pair();
    const res = await transfer({
      source_account_id: A.id,
      destination_account_id: B.id,
      amount: '101',
      reference_id: 't2',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(await balanceOf(A.id)).toBe('100.0000');
    expect(await balanceOf(B.id)).toBe('50.0000');
    expect(await prisma.transfer.count()).toBe(0);
    expect(await prisma.transaction.count()).toBe(2); // only the seeds
  });

  it('rejects missing accounts, same account and bad amounts', async () => {
    const { A } = await pair();
    const ghost = '11111111-1111-4111-8111-111111111111';
    expect(
      (await transfer({ source_account_id: A.id, destination_account_id: ghost, amount: '1', reference_id: 'x' }))
        .status,
    ).toBe(404);
    expect(
      (await transfer({ source_account_id: ghost, destination_account_id: A.id, amount: '1', reference_id: 'x' }))
        .status,
    ).toBe(404);
    expect(
      (await transfer({ source_account_id: A.id, destination_account_id: A.id, amount: '1', reference_id: 'x' }))
        .status,
    ).toBe(400);
    expect(
      (await transfer({ source_account_id: A.id, destination_account_id: ghost, amount: '-1', reference_id: 'x' }))
        .status,
    ).toBe(400);
    expect(await balanceOf(A.id)).toBe('100.0000');
  });

  it('rolls back both sides when the destination leg fails at commit', async () => {
    const { A, B } = await pair();
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION test_fail_credit() RETURNS trigger AS $$
      BEGIN
        IF NEW.type = 'credit' AND NEW.transfer_id IS NOT NULL THEN RAISE EXCEPTION 'simulated failure'; END IF;
        RETURN NULL;
      END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE CONSTRAINT TRIGGER test_fail_credit_trigger AFTER INSERT ON transactions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_credit()`);
    try {
      const res = await transfer({
        source_account_id: A.id,
        destination_account_id: B.id,
        amount: '30',
        reference_id: 'rb',
      });
      expect(res.status).toBe(500);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER test_fail_credit_trigger ON transactions');
      await prisma.$executeRawUnsafe('DROP FUNCTION test_fail_credit()');
    }
    expect(await balanceOf(A.id)).toBe('100.0000');
    expect(await balanceOf(B.id)).toBe('50.0000');
    expect(await prisma.transfer.count()).toBe(0);
    expect(await prisma.transaction.count()).toBe(2);
  });

  it('is idempotent per (source, reference_id)', async () => {
    const { A, B } = await pair();
    const body = { source_account_id: A.id, destination_account_id: B.id, amount: '30', reference_id: 'idem' };
    const first = await transfer(body);
    const second = await transfer(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('DUPLICATE_REFERENCE');
    expect(second.body.error.details.existing.id).toBe(first.body.id);
    expect(await balanceOf(A.id)).toBe('70.0000');
    expect(await balanceOf(B.id)).toBe('80.0000');
    expect(await prisma.transfer.count()).toBe(1);
  });

  it('concurrent opposite transfers neither deadlock nor overspend', async () => {
    const { A, B } = await pair('100', '100');
    const reqs = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? transfer({ source_account_id: A.id, destination_account_id: B.id, amount: '30', reference_id: `ab${i}` })
        : transfer({ source_account_id: B.id, destination_account_id: A.id, amount: '20', reference_id: `ba${i}` }),
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);
    const a = await expectLedgerConsistent(A.id);
    const b = await expectLedgerConsistent(B.id);
    expect(a.stored).toBe(a.ledger);
    expect(b.stored).toBe(b.ledger);
    expect(a.stored).toBeGreaterThanOrEqual(0);
    expect(b.stored).toBeGreaterThanOrEqual(0);
    expect(a.stored + b.stored).toBe(200); // money is conserved
  });

  it('concurrent transfers from one account cannot overspend it', async () => {
    const { A, B } = await pair('100', '0');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        transfer({ source_account_id: A.id, destination_account_id: B.id, amount: '30', reference_id: `c${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(await balanceOf(A.id)).toBe('10.0000');
    expect(await balanceOf(B.id)).toBe('90.0000');
  });
});
