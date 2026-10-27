import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError, Errors } from '../utils/errors';
import { logger } from '../utils/logger';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: `Route ${req.method} ${req.path} not found.` } });
};

function send(
  res: Parameters<ErrorRequestHandler>[2],
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  res.status(status).json({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
}

/** Postgres SQLSTATE for a raw-query failure, when Prisma surfaces one. */
function sqlState(err: Prisma.PrismaClientKnownRequestError): string | undefined {
  const meta = err.meta as { code?: string } | undefined;
  return meta?.code;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return _next(err);

  if (err instanceof AppError) return send(res, err.status, err.code, err.message, err.details);

  if (err instanceof ZodError) {
    return send(
      res,
      400,
      'VALIDATION_ERROR',
      'The request is invalid.',
      err.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message })),
    );
  }

  // body-parser errors: malformed JSON / oversized payload.
  if (err?.type === 'entity.parse.failed') return send(res, 400, 'INVALID_JSON', 'Request body is not valid JSON.');
  if (err?.type === 'entity.too.large') return send(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const state = sqlState(err);
    if (err.code === 'P2002' || state === '23505') {
      return send(res, 409, 'DUPLICATE_REFERENCE', 'A record with this reference_id already exists for this account.');
    }
    if (state === '22003') {
      const e = Errors.balanceLimit();
      return send(res, e.status, e.code, e.message);
    }
  }

  // Unexpected: log full detail server-side, return nothing sensitive.
  logger.error({ err, method: req.method, path: req.path }, 'Unhandled error');
  return send(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
};
