/** Every error leaves the API as ApiError { error, message } with a stable code. */
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { Prisma } from '@sway/db';
import { isXBudgetExceeded, XApiError, XAuthError } from '@sway/x';
import type { ApiError } from '@sway/shared';
import { HttpError } from '../errors';
import { ChainError, ChainUnavailable } from '../services/chain';

export function setupErrors(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error | Record<string, unknown>, req, reply) => {
    const send = (status: number, error: string, message: string) => reply.status(status).send({ error, message } satisfies ApiError);

    if (err instanceof HttpError) return send(err.statusCode, err.code, err.message);
    if (err instanceof ZodError) {
      const i = err.issues[0];
      return send(400, 'invalid_input', i ? `${i.path.join('.') || 'input'}: ${i.message}` : 'Invalid input');
    }
    if (isXBudgetExceeded(err)) {
      return send(503, 'x_budget', 'The X API budget is used up for now. Try again in a few minutes.');
    }
    if (err instanceof XAuthError) return send(401, 'x_auth', 'Your X session expired. Connect X again.');
    if (err instanceof XApiError) {
      req.log.warn({ err }, 'X API error');
      return send(502, 'x_error', 'X did not answer. Try again in a moment.');
    }
    if (err instanceof ChainUnavailable) return send(503, 'chain_unavailable', err.message);
    if (err instanceof ChainError) {
      req.log.warn({ err }, 'chain error');
      return send(502, 'chain_error', err.reason ? `Transaction failed: ${err.reason}` : err.message);
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') return send(409, 'conflict', 'That already exists');
      if (err.code === 'P2025') return send(404, 'not_found', 'Not found');
    }
    const status = typeof (err as { statusCode?: unknown }).statusCode === 'number' ? ((err as { statusCode: number }).statusCode) : 500;
    if (status === 429) return send(429, 'rate_limited', 'Too many requests. Slow down a little.');
    if ((err as FastifyError).validation) return send(400, 'invalid_input', String((err as FastifyError).message));
    if (status >= 400 && status < 500) {
      const code = String((err as FastifyError).code ?? 'bad_request').toLowerCase().replace(/^fst_err_/, '');
      return send(status, code, String((err as Error).message ?? 'Bad request'));
    }
    req.log.error({ err }, 'unhandled error');
    return send(500, 'internal', 'Something went wrong');
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: 'not_found', message: `No route for ${req.method} ${req.url.split('?')[0]}` } satisfies ApiError);
  });
}
