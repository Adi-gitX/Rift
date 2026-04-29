import type { ErrorCode } from './errors.ts';

export interface ApiOk<T> {
  readonly ok: true;
  readonly data: T;
  readonly request_id: string;
}

export interface ApiErrBody {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

export interface ApiErr {
  readonly ok: false;
  readonly error: ApiErrBody;
  readonly request_id: string;
}

export type ApiResponse<T> = ApiOk<T> | ApiErr;

export const apiOk = <T>(data: T, requestId: string): ApiOk<T> => ({
  ok: true,
  data,
  request_id: requestId,
});

export const apiErr = (
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
): ApiErr => ({
  ok: false,
  error: details === undefined ? { code, message } : { code, message, details },
  request_id: requestId,
});
