# Transaction Ledger API

A small REST backend for a transaction ledger: create accounts, post immutable credit/debit transactions, read balances and paginated history, and (bonus) transfer money atomically between accounts.

- **Stack:** Node.js 20+ · TypeScript · Express 4 · PostgreSQL 14+ · Prisma 6 · Zod · Vitest + Supertest
- **Docs:** Swagger UI at `http://localhost:3000/docs`, raw OpenAPI 3 at `/openapi.json`, assumptions in [Assumptions.md](Assumptions.md)

## Quick start

Prerequisites: Node.js ≥ 20, a running PostgreSQL ≥ 14 (Docker optional, see below).

```bash
npm install

# 1. create two empty databases (dev + disposable test)
psql -U postgres -c "CREATE DATABASE ledger_dev" -c "CREATE DATABASE ledger_test"

# 2. configure
cp .env.example .env        # Windows: copy .env.example .env  -> then edit the credentials

# 3. create the schema
npm run db:generate
npm run db:migrate          # prisma migrate deploy

# 4. run
npm run dev                 # watch mode, or: npm run build && npm start
```

No local Postgres? `docker run --name ledger-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:17`, then create the databases with
`docker exec ledger-pg psql -U postgres -c "CREATE DATABASE ledger_dev" -c "CREATE DATABASE ledger_test"`.

### Environment variables (`.env`)

| Variable            | Purpose                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `PORT`              | HTTP port (default 3000)                                                         |
| `DATABASE_URL`      | Postgres connection string for the app                                           |
| `TEST_DATABASE_URL` | Used **only** by tests; the DB name must end in `_test` (tests refuse otherwise) |

### Scripts

| Command                           | What it does                                            |
| --------------------------------- | ------------------------------------------------------- |
| `npm run dev`                     | start with auto-reload                                  |
| `npm run build` / `npm start`     | compile to `dist/` / run compiled server                |
| `npm run db:migrate`              | apply migrations (`prisma migrate deploy`)              |
| `npm run db:migrate:dev`          | create a new migration during development               |
| `npm test`                        | run all tests (applies migrations to the test DB first) |
| `npm run lint` / `typecheck`      | ESLint / `tsc --noEmit`                                 |
| `npm run format` / `format:check` | Prettier                                                |

## API

All bodies are JSON. Money is a **decimal string** with up to 4 decimals (`"12.5"`, `"0.0001"`); responses always return 4 decimals (`"12.5000"`). Plain JSON numbers are accepted for amounts, but strings are recommended. Ids are UUIDs. Timestamps are ISO-8601 UTC.

| Method | Path                                | Purpose                                      |
| ------ | ----------------------------------- | -------------------------------------------- |
| POST   | `/accounts`                         | Create an account (balance starts at 0)      |
| GET    | `/accounts/:accountId/balance`      | Current balance                              |
| POST   | `/accounts/:accountId/transactions` | Post a credit or debit                       |
| GET    | `/accounts/:accountId/transactions` | History: filter, paginate, latest first      |
| POST   | `/transfers`                        | Atomic transfer between two accounts (bonus) |
| GET    | `/health`                           | Liveness                                     |

There are intentionally no update/delete endpoints for transactions.

### Create account

```http
POST /accounts
{ "name": "Alice" }
```

`201` → `{ "id": "…", "name": "Alice", "balance": "0.0000", "created_at": "2026-10-27T12:00:00.000Z" }`.
Any extra field (`balance`, `id`, `created_at`, …) → `400`.

### Create transaction

```http
POST /accounts/{accountId}/transactions
{ "type": "debit", "amount": "30.00", "description": "Coffee machine", "reference_id": "inv-1001" }
```

`201` →

```json
{
  "id": "…",
  "account_id": "…",
  "type": "debit",
  "amount": "30.0000",
  "description": "Coffee machine",
  "reference_id": "inv-1001",
  "transfer_id": null,
  "created_at": "…"
}
```

Failures: `400 VALIDATION_ERROR`, `404 ACCOUNT_NOT_FOUND`, `409 INSUFFICIENT_BALANCE`, `409 DUPLICATE_REFERENCE`, `409 BALANCE_LIMIT_EXCEEDED`.

**Duplicate** (same account + `reference_id`): `409`, no row created, balance unchanged, and the original is returned:

```json
{
  "error": {
    "code": "DUPLICATE_REFERENCE",
    "message": "…No changes were made.",
    "details": { "existing": { "id": "…", "…": "…" } }
  }
}
```

### Idempotency-Key (optional)

Send an `Idempotency-Key` header to make a request safe to retry (network timeout, client crash). It is supported on `POST /accounts/{id}/transactions` and `POST /transfers`. Without the header, behavior is exactly as described above (only `reference_id` duplicate handling applies).

```http
POST /accounts/{accountId}/transactions
Idempotency-Key: 7b1f3c52-order-1001
{ "type": "debit", "amount": "30.00", "description": "Coffee machine", "reference_id": "inv-1001" }
```

| Situation                                                                             | Result                                                                                                                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| New key                                                                               | Executes normally → `201`; the key is stored in the same DB transaction as the ledger change                                       |
| Same key + identical payload (retry)                                                  | **Not executed again**; the original `201` body is returned with header `Idempotent-Replayed: true`. No new row, balance unchanged |
| Same key + different payload (amount, type, description, `reference_id`, or accounts) | `409 IDEMPOTENCY_KEY_REUSED`; nothing changes                                                                                      |
| Same key sent concurrently                                                            | Requests serialise on the account row lock: one executes, the rest replay its result (or get `409` if their payload differs)       |
| Operation fails (e.g. `INSUFFICIENT_BALANCE`, duplicate `reference_id`, `404`)        | Everything rolls back **including the key**, so the key is not consumed and the request can be retried later                       |
| Blank or longer than 255 characters                                                   | `400 VALIDATION_ERROR` (`field: "idempotency-key"`)                                                                                |

- **Scope:** keys are unique per account (`UNIQUE (account_id, key)`), so two accounts can use the same key independently. For transfers the scope is the **source** account. Reusing one key for a transaction and a transfer on the same account counts as a different payload → `409`.
- **What is stored:** the key, a SHA-256 fingerprint of the normalised request (`"10"` and `"10.00"` are the same amount) and the response body — never the raw request. Records are immutable (DB trigger).
- **No expiry:** keys are kept indefinitely (see Limitations).
- `reference_id` rules still apply on top: a _new_ key with an already-used `reference_id` returns `409 DUPLICATE_REFERENCE`.

### Balance

`GET /accounts/{id}/balance` → `200 { "account_id": "…", "balance": "100.0000" }`

### History

`GET /accounts/{id}/transactions?type=credit|debit&page=1&limit=20`

- `type` optional; `page` ≥ 1 (default 1); `limit` 1–100 (default 20). Anything else → `400`.
- Sorted `created_at DESC, id DESC`. A page past the end returns an empty `data`.

```json
{ "data": [{ "…": "transaction" }], "pagination": { "page": 1, "limit": 20, "total_records": 7, "total_pages": 1 } }
```

### Transfer (bonus)

```http
POST /transfers
{ "source_account_id": "…", "destination_account_id": "…", "amount": "30", "reference_id": "xfer-1", "description": "optional" }
```

`201` → transfer object with `entries`: the linked `debit` (source) and `credit` (destination) ledger rows sharing `transfer_id`. Errors: `400` (validation, same account), `404`, `409 INSUFFICIENT_BALANCE`, `409 DUPLICATE_REFERENCE` (idempotent per source account + `reference_id`), `409 IDEMPOTENCY_KEY_REUSED`. Accepts the optional `Idempotency-Key` header (see above).

### Errors

Always `{ "error": { "code": "…", "message": "…", "details"?: … } }`.

| Status | Codes                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR` (details = list of `{field, message}`), `INVALID_JSON`                         |
| 404    | `ACCOUNT_NOT_FOUND`, `ROUTE_NOT_FOUND`                                                            |
| 409    | `INSUFFICIENT_BALANCE`, `DUPLICATE_REFERENCE`, `IDEMPOTENCY_KEY_REUSED`, `BALANCE_LIMIT_EXCEEDED` |
| 413    | `PAYLOAD_TOO_LARGE` (body > 10 kB)                                                                |
| 500    | `INTERNAL_ERROR` (details are logged server-side only)                                            |

## Design & consistency guarantees

- **Atomicity.** Each transaction/transfer runs in one DB transaction: lock account row(s) `FOR UPDATE` → insert ledger row → conditional balance update. Any failure rolls everything back.
- **No overspending.** A debit is `UPDATE … SET balance = balance - $x WHERE balance >= $x`, run under the account row lock; a `CHECK (balance >= 0)` constraint is the backstop.
- **Idempotency.** `UNIQUE (account_id, reference_id)` is the final arbiter; the insert uses `ON CONFLICT DO NOTHING`, so concurrent duplicates yield exactly one success.
- **Idempotency-Key.** Optional header on transactions and transfers. The key lookup and the key insert run inside the same DB transaction as the ledger change, after the account row lock, so same-key requests cannot execute twice; `UNIQUE (account_id, key)` is the backstop and a rolled-back operation never reserves its key.
- **Deadlock-free transfers.** Both account rows are locked in ascending id order.
- **Exact money.** `NUMERIC(19,4)`; arithmetic happens in Postgres, never in JS floats. Input is validated by strict regex, never rounded.
- **Immutability.** No mutation routes, FKs are `ON DELETE RESTRICT`, and DB triggers reject `UPDATE`/`DELETE` on `transactions` and `transfers`.
- **Other DB constraints:** `amount > 0`, non-blank name/reference, source ≠ destination, one debit + one credit per transfer.
- **Balance invariant:** `balance = Σ credits − Σ debits`, verified in the tests against the ledger after concurrent load.

## Tests

```bash
npm test
```

Runs against the real PostgreSQL database in `TEST_DATABASE_URL` (migrations are applied automatically; tables are truncated between tests — hence the `_test` name guard). Covers validation, money precision, credit/debit, insufficient funds, duplicates, rollback on commit failure (via a temporary deferred DB trigger), immutability, filtering/pagination/ordering, concurrent debits, concurrent duplicate references, and transfers (including concurrent opposite transfers).

## Limitations

Idempotency keys are stored forever (no expiry/cleanup job) and a failed request is never cached - only successful results are replayed. No authentication/authorization, rate limiting or multi-currency — this is an assessment implementation and should not be exposed publicly without access controls. See [Assumptions.md](Assumptions.md).
