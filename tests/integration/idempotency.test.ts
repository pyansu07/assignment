import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app, balanceOf, createAccount, expectLedgerConsistent, postTx, prisma, resetDb, tx } from '../helpers/utils';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const withKey = (accountId: string, key: string | undefined, body: Record<string, unknown>) => {
  const req = request(app).post(`/accounts/${accountId}/transactions`);
  if (key !== undefined) req.set('Idempotency-Key', key);
  return req.send(body);
};
const transferWithKey = (key: string | undefined, body: Record<string, unknown>) => {
  const req = request(app).post('/transfers');
  if (key !== undefined) req.set('Idempotency-Key', key);
  return req.send(body);
};

describe('Idempotency-Key on transactions', () => {
  it('executes a request with a new key and stores the key', async () => {
    const { id } = await createAccount();
    const res = await withKey(id, 'key-1', tx('credit', '100', 'r1'));
    expect(res.status).toBe(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(await balanceOf(id)).toBe('100.0000');
    expect(await prisma.idempotencyKey.count({ where: { accountId: id, key: 'key-1' } })).toBe(1);
  });

  it('replays the original result for the same key and payload without a second effect', async () => {
    const { id } = await createAccount();
    const first = await withKey(id, 'key-1', tx('credit', '100', 'r1'));
    const retry = await withKey(id, 'key-1', tx('credit', '100', 'r1'));
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(await balanceOf(id)).toBe('100.0000');
    expect(await prisma.transaction.count()).toBe(1);
    expect(await expectLedgerConsistent(id)).toEqual({ ledger: 100, stored: 100, count: 1 });
  });

  it('treats numerically equal amounts ("100" vs "100.00") as the same request', async () => {
    const { id } = await createAccount();
    await withKey(id, 'k', tx('credit', '100', 'r1'));
    const retry = await withKey(id, 'k', tx('credit', '100.00', 'r1'));
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(await prisma.transaction.count()).toBe(1);
  });

  it.each([
    ['amount', tx('credit', '999', 'r1')],
    ['type', tx('debit', '100', 'r1')],
    ['reference_id', tx('credit', '100', 'other-ref')],
    ['description', tx('credit', '100', 'r1', 'different description')],
  ])('returns 409 when the key is reused with a different %s', async (_field, changed) => {
    const { id } = await createAccount();
    await withKey(id, 'key-1', tx('credit', '100', 'r1'));
    const res = await withKey(id, 'key-1', changed);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await balanceOf(id)).toBe('100.0000');
    expect(await prisma.transaction.count()).toBe(1);
  });

  it('concurrent identical requests execute exactly once', async () => {
    const { id } = await createAccount();
    const results = await Promise.all(
      Array.from({ length: 15 }, () => withKey(id, 'race-key', tx('credit', '25', 'race-ref'))),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(results.filter((r) => r.headers['idempotent-replayed'] !== 'true')).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await balanceOf(id)).toBe('25.0000');
    expect(await prisma.transaction.count()).toBe(1);
    expect(await prisma.idempotencyKey.count()).toBe(1);
  });

  it('concurrent requests with one key but different payloads: one executes, the rest get 409', async () => {
    const { id } = await createAccount();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => withKey(id, 'mixed', tx('credit', String(i + 1), `ref-${i}`))),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === 'IDEMPOTENCY_KEY_REUSED')).toHaveLength(9);
    expect(await prisma.transaction.count()).toBe(1);
    const consistent = await expectLedgerConsistent(id);
    expect(consistent.stored).toBe(consistent.ledger);
  });

  it('does not reserve the key when the operation fails (insufficient funds), so a retry can succeed', async () => {
    const { id } = await createAccount();
    const failed = await withKey(id, 'retry-key', tx('debit', '50', 'd1'));
    expect(failed.status).toBe(409);
    expect(failed.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(await prisma.idempotencyKey.count()).toBe(0);
    expect(await prisma.transaction.count()).toBe(0);

    await postTx(id, tx('credit', '100', 'fund'));
    const retried = await withKey(id, 'retry-key', tx('debit', '50', 'd1'));
    expect(retried.status).toBe(201);
    expect(retried.headers['idempotent-replayed']).toBeUndefined();
    expect(await balanceOf(id)).toBe('50.0000');
    expect(await prisma.idempotencyKey.count()).toBe(1);
  });

  it('does not reserve the key when a duplicate reference_id rejects the request', async () => {
    const { id } = await createAccount();
    await postTx(id, tx('credit', '10', 'taken'));
    const res = await withKey(id, 'k-dup', tx('credit', '10', 'taken'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_REFERENCE');
    expect(await prisma.idempotencyKey.count()).toBe(0);
    expect(await balanceOf(id)).toBe('10.0000');
  });

  it('keeps the existing reference_id duplicate behaviour when no key is supplied', async () => {
    const { id } = await createAccount();
    expect((await withKey(id, undefined, tx('credit', '100', 'same'))).status).toBe(201);
    const dup = await withKey(id, undefined, tx('credit', '100', 'same'));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_REFERENCE');
    expect(await balanceOf(id)).toBe('100.0000');
    expect(await prisma.transaction.count()).toBe(1);
    expect(await prisma.idempotencyKey.count()).toBe(0);
  });

  it('a different key with the same reference_id still hits the reference_id duplicate rule', async () => {
    const { id } = await createAccount();
    await withKey(id, 'key-a', tx('credit', '100', 'ref'));
    const res = await withKey(id, 'key-b', tx('credit', '100', 'ref'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_REFERENCE');
    expect(await balanceOf(id)).toBe('100.0000');
  });

  it('scopes keys per account: the same key works independently on two accounts', async () => {
    const a = await createAccount('A');
    const b = await createAccount('B');
    expect((await withKey(a.id, 'shared-key', tx('credit', '10', 'ra'))).status).toBe(201);
    const onB = await withKey(b.id, 'shared-key', tx('credit', '99', 'rb'));
    expect(onB.status).toBe(201);
    expect(onB.headers['idempotent-replayed']).toBeUndefined();
    expect(await balanceOf(a.id)).toBe('10.0000');
    expect(await balanceOf(b.id)).toBe('99.0000');
    expect(await prisma.idempotencyKey.count()).toBe(2);
  });

  it('rejects a blank or over-long key with a validation error and no side effects', async () => {
    const { id } = await createAccount();
    for (const key of ['', '   ', 'k'.repeat(256)]) {
      const res = await withKey(id, key, tx('credit', '10', 'r'));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details[0].field).toBe('idempotency-key');
    }
    expect((await withKey(id, 'k'.repeat(255), tx('credit', '10', 'ok'))).status).toBe(201);
    expect(await prisma.transaction.count()).toBe(1);
  });

  it('still validates the body and returns 404 for unknown accounts when a key is supplied', async () => {
    const { id } = await createAccount();
    expect((await withKey(id, 'k', tx('credit', '-1', 'r'))).status).toBe(400);
    expect((await withKey('11111111-1111-4111-8111-111111111111', 'k', tx('credit', '1', 'r'))).status).toBe(404);
    expect(await prisma.idempotencyKey.count()).toBe(0);
  });

  it('idempotency records are immutable at the database level', async () => {
    const { id } = await createAccount();
    await withKey(id, 'k', tx('credit', '10', 'r'));
    await expect(prisma.$executeRaw`UPDATE idempotency_keys SET key = 'x'`).rejects.toThrow();
    await expect(prisma.$executeRaw`DELETE FROM idempotency_keys`).rejects.toThrow();
  });
});

describe('Idempotency-Key on transfers', () => {
  async function pair() {
    const A = await createAccount('A');
    const B = await createAccount('B');
    await postTx(A.id, tx('credit', '100', 'seedA'));
    await postTx(B.id, tx('credit', '50', 'seedB'));
    return { A, B };
  }
  const body = (A: string, B: string, amount = '30', ref = 'x1') => ({
    source_account_id: A,
    destination_account_id: B,
    amount,
    reference_id: ref,
  });

  it('replays a retried transfer with no second effect', async () => {
    const { A, B } = await pair();
    const first = await transferWithKey('t-key', body(A.id, B.id));
    const retry = await transferWithKey('t-key', body(A.id, B.id));
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(await balanceOf(A.id)).toBe('70.0000');
    expect(await balanceOf(B.id)).toBe('80.0000');
    expect(await prisma.transfer.count()).toBe(1);
    expect(await prisma.transaction.count({ where: { transferId: { not: null } } })).toBe(2);
  });

  it('returns 409 when the key is reused with a different transfer', async () => {
    const { A, B } = await pair();
    await transferWithKey('t-key', body(A.id, B.id));
    const res = await transferWithKey('t-key', body(A.id, B.id, '31', 'x2'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await balanceOf(A.id)).toBe('70.0000');
    expect(await balanceOf(B.id)).toBe('80.0000');
    expect(await prisma.transfer.count()).toBe(1);
  });

  it('concurrent identical transfers execute exactly once', async () => {
    const { A, B } = await pair();
    const results = await Promise.all(Array.from({ length: 12 }, () => transferWithKey('t-race', body(A.id, B.id))));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await balanceOf(A.id)).toBe('70.0000');
    expect(await balanceOf(B.id)).toBe('80.0000');
    expect(await prisma.transfer.count()).toBe(1);
    expect(await prisma.idempotencyKey.count()).toBe(1);
  });

  it('does not reserve the key when the transfer fails for insufficient funds', async () => {
    const { A, B } = await pair();
    const failed = await transferWithKey('t-fail', body(A.id, B.id, '500'));
    expect(failed.status).toBe(409);
    expect(failed.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(await prisma.idempotencyKey.count()).toBe(0);
    expect(await prisma.transfer.count()).toBe(0);

    const retried = await transferWithKey('t-fail', body(A.id, B.id, '10', 'x3'));
    expect(retried.status).toBe(201);
    expect(await balanceOf(A.id)).toBe('90.0000');
  });

  it('a transaction key cannot be replayed as a transfer (different operation = different request)', async () => {
    const { A, B } = await pair();
    await withKey(A.id, 'shared', tx('credit', '5', 'cr'));
    const res = await transferWithKey('shared', body(A.id, B.id));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await prisma.transfer.count()).toBe(0);
  });

  it('works without a key exactly as before', async () => {
    const { A, B } = await pair();
    expect((await transferWithKey(undefined, body(A.id, B.id))).status).toBe(201);
    const dup = await transferWithKey(undefined, body(A.id, B.id));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_REFERENCE');
    expect(await prisma.idempotencyKey.count()).toBe(0);
  });
});
