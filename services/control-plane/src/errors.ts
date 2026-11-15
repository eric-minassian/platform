import type { ApiErrorBody } from '@ericminassian/platform-core';

/** Thrown anywhere in a request; rendered as `ApiErrorBody` by the server's error handler. */
export class ApiError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503;
  readonly code: string;
  constructor(status: ApiError['status'], code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message } };
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string) => new ApiError(400, 'bad_request', message);
