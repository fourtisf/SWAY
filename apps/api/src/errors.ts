/** HTTP errors with a stable machine-readable code. Rendered as ApiError { error, message }. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (code: string, message: string) => new HttpError(400, code, message);
export const unauthorized = (message = 'Sign in with X first') =>
  new HttpError(401, 'auth_required', message);
export const forbidden = (code: string, message: string) => new HttpError(403, code, message);
export const notFound = (what = 'Not found', code = 'not_found') => new HttpError(404, code, what);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const unprocessable = (code: string, message: string) => new HttpError(422, code, message);
export const unavailable = (code: string, message: string) => new HttpError(503, code, message);
