import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message = code, readonly details?: Record<string, unknown>) {
    super(message);
  }
}
export const notFound = (what = 'not_found') => new HttpError(404, what);
export const forbidden = () => new HttpError(403, 'forbidden');
export const unauthorized = () => new HttpError(401, 'unauthorized');

/** PostgreSQL errors that are the client's fault, mapped to a clean 4xx instead of a 500. */
function fromPostgres(err: { code?: string; message?: string }): HttpError | null {
  if (err.message === 'last_admin' || err.message?.includes('last_admin')) return new HttpError(409, 'last_admin');
  switch (err.code) {
    case '22007': // invalid_datetime_format
    case '22008': // datetime_field_overflow
    case '22P02': // invalid_text_representation (bad uuid etc.)
      return new HttpError(400, 'invalid_request');
    case '23503': // foreign_key_violation
      return new HttpError(400, 'invalid_reference');
    default:
      return null;
  }
}

/** One error shape everywhere: { error: { code, message, issues?, … } }. Never leaks stack traces or SQL. */
export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof HttpError) {
    if (err.details?.retryAfterSeconds) reply.header('retry-after', String(err.details.retryAfterSeconds));
    return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...err.details } });
  }
  if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'invalid_request', message: 'invalid_request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
  const pg = fromPostgres(err as { code?: string; message?: string });
  if (pg) return reply.status(pg.status).send({ error: { code: pg.code, message: pg.code } });
  const status = (err as FastifyError).statusCode;
  if (status && status < 500) return reply.status(status).send({ error: { code: (err as FastifyError).code ?? 'bad_request', message: err.message } });
  req.log.error(err);
  return reply.status(500).send({ error: { code: 'internal', message: 'internal' } });
}
