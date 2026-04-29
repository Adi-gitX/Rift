export const ErrorCodes = {
  E_AUTH: 'E_AUTH',
  E_NOT_FOUND: 'E_NOT_FOUND',
  E_CF_API: 'E_CF_API',
  E_GITHUB_API: 'E_GITHUB_API',
  E_VALIDATION: 'E_VALIDATION',
  E_QUOTA: 'E_QUOTA',
  E_RATE_LIMIT: 'E_RATE_LIMIT',
  E_CONFLICT: 'E_CONFLICT',
  E_INTERNAL: 'E_INTERNAL',
  E_NOT_IMPLEMENTED: 'E_NOT_IMPLEMENTED',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface CodedErrorOptions {
  status?: number;
  details?: unknown;
  cause?: unknown;
}

export class CodedError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options: CodedErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CodedError';
    this.code = code;
    this.status = options.status ?? defaultStatusFor(code);
    this.details = options.details;
  }
}

/** Thrown inside Workflow steps to opt out of retries — see PRD amendment A9. */
export class NonRetryableError extends CodedError {
  constructor(code: ErrorCode, message: string, options: CodedErrorOptions = {}) {
    super(code, message, options);
    this.name = 'NonRetryableError';
  }
}

const defaultStatusFor = (code: ErrorCode): number => {
  switch (code) {
    case 'E_AUTH':
      return 401;
    case 'E_NOT_FOUND':
      return 404;
    case 'E_VALIDATION':
      return 422;
    case 'E_QUOTA':
    case 'E_RATE_LIMIT':
      return 429;
    case 'E_CONFLICT':
      return 409;
    case 'E_NOT_IMPLEMENTED':
      return 501;
    case 'E_CF_API':
    case 'E_GITHUB_API':
      return 502;
    case 'E_INTERNAL':
    default:
      return 500;
  }
};
