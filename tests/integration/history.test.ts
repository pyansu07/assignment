import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app, createAccount, postTx, prisma, resetDb, tx } from '../helpers/utils';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function seed() {
  const { id } = await createAccount();
  // 5 credits then 2 debits, sequentially so created_at strictly increases
  for (let i = 1; i <= 5; i++) await postTx(id, tx('credit', '100', `c${i}`));
  for (let i = 1; i <= 2; i++) await postTx(id, tx('debit', '10', `d${i}`));
  return id;
}

const list = (id: string, qs = '') => request(app).get(`/accounts/${id}/transactions${qs}`);

describe('transaction history', () => {
  it('returns both types, latest first, with pagination metadata', async () => {
    const id = await seed();
    const res = await list(id);
    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ page: 1, limit: 20, total_records: 7, total_pages: 1 });
    expect(res.body.data.map((t: { reference_id: string }) => t.reference_id)).toEqual([
      'd2',
      'd1',
      'c5',
      'c4',
      'c3',
      'c2',
      'c1',
    ]);
  });

  it('filters by credit and by debit, with matching totals', async () => {
    const id = await seed();
    const credits = await list(id, '?type=credit');
    expect(credits.body.pagination.total_records).toBe(5);
    expect(credits.body.data.every((t: { type: string }) => t.type === 'credit')).toBe(true);
    const debits = await list(id, '?type=debit&limit=1&page=2');
    expect(debits.body.pagination).toEqual({ page: 2, limit: 1, total_records: 2, total_pages: 2 });
    expect(debits.body.data.map((t: { reference_id: string }) => t.reference_id)).toEqual(['d1']);
  });

  it('pages correctly through boundaries without overlap', async () => {
    const id = await seed();
    const seen: string[] = [];
    for (const page of [1, 2, 3, 4]) {
      const res = await list(id, `?limit=3&page=${page}`);
      expect(res.body.pagination).toMatchObject({ page, limit: 3, total_records: 7, total_pages: 3 });
      seen.push(...res.body.data.map((t: { id: string }) => t.id));
      if (page === 3) expect(res.body.data).toHaveLength(1);
      if (page === 4) expect(res.body.data).toHaveLength(0); // beyond last page
    }
    expect(new Set(seen).size).toBe(7);
  });

  it('handles an account with no transactions', async () => {
    const { id } = await createAccount();
    const res = await list(id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], pagination: { page: 1, limit: 20, total_records: 0, total_pages: 0 } });
  });

  it.each([
    '?page=0',
    '?page=-1',
    '?page=abc',
    '?page=1.5',
    '?limit=0',
    '?limit=-5',
    '?limit=101',
    '?limit=x',
    '?type=refund',
    '?foo=bar',
  ])('rejects invalid query %s', async (qs) => {
    const { id } = await createAccount();
    const res = await list(id, qs);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for a nonexistent account', async () => {
    expect((await list('11111111-1111-4111-8111-111111111111')).status).toBe(404);
  });
});
