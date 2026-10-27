const uuid = { type: 'string', format: 'uuid' };
const money = { type: 'string', pattern: '^\\d{1,15}(\\.\\d{1,4})?$', example: '100.5000' };
const errorRef = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});
const accountIdParam = { name: 'accountId', in: 'path', required: true, schema: uuid };
const idempotencyKeyHeader = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: 255 },
  description:
    'Optional. Retrying with the same key and identical payload replays the original 201 response (header Idempotent-Replayed: true) without executing again. The same key with a different payload returns 409 IDEMPOTENCY_KEY_REUSED. Scoped per account (the source account for transfers). Failed requests do not consume the key.',
};
const replayedHeader = {
  'Idempotent-Replayed': {
    description:
      'Present with value "true" when the response is a replay of an earlier request with the same Idempotency-Key.',
    schema: { type: 'string', enum: ['true'] },
  },
};

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Transaction Ledger API',
    version: '1.0.0',
    description:
      'Accounts, immutable credit/debit ledger entries and atomic transfers. Money values are decimal strings with up to 4 fractional digits (NUMERIC(19,4)).',
  },
  paths: {
    '/accounts': {
      post: {
        summary: 'Create an account (balance always starts at 0)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                additionalProperties: false,
                properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Account' } } },
          },
          '400': errorRef('VALIDATION_ERROR / INVALID_JSON (also when balance, id or created_at are supplied)'),
        },
      },
    },
    '/accounts/{accountId}/balance': {
      get: {
        summary: 'Get current balance',
        parameters: [accountIdParam],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { account_id: uuid, balance: money },
                },
              },
            },
          },
          '400': errorRef('Malformed account id'),
          '404': errorRef('ACCOUNT_NOT_FOUND'),
        },
      },
    },
    '/accounts/{accountId}/transactions': {
      post: {
        summary: 'Create a credit or debit transaction (atomic with the balance update)',
        parameters: [accountIdParam, idempotencyKeyHeader],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['type', 'amount', 'description', 'reference_id'],
                additionalProperties: false,
                properties: {
                  type: { type: 'string', enum: ['credit', 'debit'] },
                  amount: {
                    ...money,
                    description:
                      'Positive decimal string, max 4 decimals. JSON numbers are accepted but strings are recommended.',
                  },
                  description: { type: 'string', minLength: 1, maxLength: 500 },
                  reference_id: { type: 'string', minLength: 1, maxLength: 100, description: 'Unique per account.' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created (or replayed: same Idempotency-Key and payload)',
            headers: replayedHeader,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Transaction' } } },
          },
          '400': errorRef('VALIDATION_ERROR (incl. blank or >255 char Idempotency-Key) / INVALID_JSON'),
          '404': errorRef('ACCOUNT_NOT_FOUND'),
          '409': errorRef(
            'INSUFFICIENT_BALANCE, DUPLICATE_REFERENCE (details.existing holds the original transaction; nothing changed), IDEMPOTENCY_KEY_REUSED (key already used with a different payload) or BALANCE_LIMIT_EXCEEDED',
          ),
        },
      },
      get: {
        summary: 'List transactions (latest first)',
        parameters: [
          accountIdParam,
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['credit', 'debit'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Transaction' } },
                    pagination: {
                      type: 'object',
                      properties: {
                        page: { type: 'integer' },
                        limit: { type: 'integer' },
                        total_records: { type: 'integer' },
                        total_pages: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': errorRef('Invalid type/page/limit'),
          '404': errorRef('ACCOUNT_NOT_FOUND'),
        },
      },
    },
    '/transfers': {
      post: {
        summary: 'Atomically transfer money between two accounts (bonus)',
        description:
          'Writes one transfer row plus a linked debit and credit ledger entry (shared transfer_id) in a single DB transaction. Idempotent per (source_account_id, reference_id); the optional Idempotency-Key header adds replay semantics scoped to the source account.',
        parameters: [idempotencyKeyHeader],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['source_account_id', 'destination_account_id', 'amount', 'reference_id'],
                additionalProperties: false,
                properties: {
                  source_account_id: uuid,
                  destination_account_id: uuid,
                  amount: money,
                  description: { type: 'string', maxLength: 500, default: 'Transfer' },
                  reference_id: { type: 'string', maxLength: 100 },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created (or replayed: same Idempotency-Key and payload)',
            headers: replayedHeader,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Transfer' } } },
          },
          '400': errorRef('VALIDATION_ERROR (incl. same source and destination, bad Idempotency-Key)'),
          '404': errorRef('ACCOUNT_NOT_FOUND'),
          '409': errorRef('INSUFFICIENT_BALANCE, DUPLICATE_REFERENCE or IDEMPOTENCY_KEY_REUSED'),
        },
      },
    },
  },
  components: {
    schemas: {
      Account: {
        type: 'object',
        properties: {
          id: uuid,
          name: { type: 'string' },
          balance: money,
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Transaction: {
        type: 'object',
        properties: {
          id: uuid,
          account_id: uuid,
          type: { type: 'string', enum: ['credit', 'debit'] },
          amount: money,
          description: { type: 'string' },
          reference_id: { type: 'string' },
          transfer_id: { ...uuid, nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Transfer: {
        type: 'object',
        properties: {
          id: uuid,
          source_account_id: uuid,
          destination_account_id: uuid,
          amount: money,
          description: { type: 'string' },
          reference_id: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          entries: { type: 'array', items: { $ref: '#/components/schemas/Transaction' } },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'INSUFFICIENT_BALANCE' },
              message: { type: 'string' },
              details: {},
            },
          },
        },
      },
    },
  },
};
