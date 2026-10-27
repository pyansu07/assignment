import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app, createAccount, prisma, resetDb } from '../helpers/utils';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('accounts', () => {
  it('creates an account with zero balance and server-generated id/timestamp', async () => {
    const res = await request(app).post('/accounts').send({ name: '  Alice  ' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Alice');
    expect(res.body.balance).toBe('0.0000');
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(res.body.created_at).getTime()).not.toBeNaN();
  });

  it.each([{}, { name: '' }, { name: '   ' }, { name: 42 }, { name: 'x'.repeat(101) }])(
    'rejects invalid name %j',
    async (body) => {
      const res = await request(app).post('/accounts').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  it('rejects client-supplied balance, id and created_at', async () => {
    for (const extra of [{ balance: 500 }, { balance: '500' }, { id: 'abc' }, { created_at: '2020-01-01' }]) {
      const res = await request(app)
        .post('/accounts')
        .send({ name: 'Mallory', ...extra });
      expect(res.status).toBe(400);
    }
    expect(await prisma.account.count()).toBe(0);
  });

  it('rejects malformed JSON', async () => {
    const res = await request(app).post('/accounts').set('Content-Type', 'application/json').send('{"name":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('returns the balance of an existing account', async () => {
    const acc = await createAccount();
    const res = await request(app).get(`/accounts/${acc.id}/balance`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ account_id: acc.id, balance: '0.0000' });
  });

  it('returns 404 for a nonexistent account and 400 for a malformed id', async () => {
    const missing = await request(app).get('/accounts/11111111-1111-4111-8111-111111111111/balance');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('ACCOUNT_NOT_FOUND');
    const bad = await request(app).get('/accounts/not-a-uuid/balance');
    expect(bad.status).toBe(400);
  });
});
