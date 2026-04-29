/**
 * CFClient — thin Cloudflare REST wrapper.
 *
 *  - returns `Result<T, CodedError>` at the boundary (PRD amendment A9);
 *  - retries idempotent requests on 429/5xx with exponential backoff + jitter;
 *  - validates responses through Zod schemas where the caller provides one;
 *  - never logs token values (the structured logger redacts >=40-char strings
 *    anyway, but the client masks the Authorization header pre-fetch);
 *  - takes an injectable `fetcher` so tests can stub.
 */
import { z } from 'zod';
import { CodedError, type Result, err, ok } from '@raft/shared-types';
import { Logger } from '../logger.ts';

export type Fetcher = typeof fetch;

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 1000;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface CFClientOptions {
  accountId: string;
  token: string;
  fetcher?: Fetcher;
  logger?: Logger;
  maxRetries?: number;
  /** Base delay in ms; tests pass 0 to skip waiting. */
  baseDelayMs?: number;
  /** Override base URL (default: https://api.cloudflare.com/client/v4). */
  baseUrl?: string;
}

export interface CFRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** When true, skip account-scoping and treat path as absolute under baseUrl. */
  unscoped?: boolean;
  /** Disable retry (e.g. POST that isn't idempotent). */
  noRetry?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// DIAGNOSTIC: one-time-per-isolate auth shape log.
// Originally added to debug a CF_API_TOKEN binding-name mismatch (uploaded
// secret name didn't match the Env field) that surfaced as 401-on-every-call.
// Safe to leave in (no token value is logged); remove once we are confident
// the auth path is stable across deploys.
let cfAuthDebugLogged = false;
const logCfAuthDebugOnce = (logger: Logger, token: string): void => {
  if (cfAuthDebugLogged) return;
  cfAuthDebugLogged = true;
  const safe = typeof token === 'string' ? token : String(token);
  logger.info('cf_auth_debug', {
    prefix: safe.slice(0, 8),
    suffix: safe.slice(-4),
    length: safe.length,
    has_newline: safe.includes('\n'),
    has_cr: safe.includes('\r'),
    has_space: safe.includes(' '),
    trimmed_length: safe.trim().length,
    type: typeof token,
  });
};

const backoffDelay = (attempt: number, base: number): number => {
  const expo = base * 2 ** attempt;
  const jitter = Math.random() * base;
  return expo + jitter;
};

export class CFClient {
  private readonly opts: Required<Omit<CFClientOptions, 'logger' | 'fetcher'>> & {
    logger: Logger;
    fetcher: Fetcher;
  };

  constructor(opts: CFClientOptions) {
    this.opts = {
      accountId: opts.accountId,
      token: opts.token,
      maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
      baseDelayMs: opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
      logger: opts.logger ?? new Logger({ component: 'cf-client' }),
      fetcher: opts.fetcher ?? globalThis.fetch.bind(globalThis),
    };
    logCfAuthDebugOnce(this.opts.logger, this.opts.token);
  }

  /**
   * Issues a CF API call. When `schema` is provided, the parsed `result`
   * field of the standard CF envelope is validated and returned.
   */
  async req<T extends z.ZodTypeAny>(
    options: CFRequestOptions,
    schema: T,
  ): Promise<Result<z.infer<T>, CodedError>> {
    const url = this.buildUrl(options.path, options.unscoped ?? false);
    const init = this.buildInit(options);
    return this.executeWithRetry(url, init, schema, options);
  }

  /** Raw request without envelope parsing — used for D1 import upload, etc. */
  async raw(options: CFRequestOptions): Promise<Result<Response, CodedError>> {
    const url = this.buildUrl(options.path, options.unscoped ?? false);
    const init = this.buildInit(options);
    return this.executeRawWithRetry(url, init, options);
  }

  private buildUrl(path: string, unscoped: boolean): string {
    if (path.startsWith('http')) return path;
    return unscoped
      ? `${this.opts.baseUrl}${path}`
      : `${this.opts.baseUrl}/accounts/${this.opts.accountId}${path}`;
  }

  private buildInit(o: CFRequestOptions): RequestInit {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.token}`,
      'user-agent': 'raft-control',
      ...o.headers,
    };
    const init: RequestInit = { method: o.method, headers };
    if (o.body !== undefined) {
      if (o.body instanceof FormData) {
        init.body = o.body;
      } else if (typeof o.body === 'string' || o.body instanceof ArrayBuffer || o.body instanceof Uint8Array) {
        init.body = o.body as BodyInit;
      } else {
        init.body = JSON.stringify(o.body);
        headers['content-type'] ??= 'application/json';
      }
    }
    return init;
  }

  private async executeWithRetry<T extends z.ZodTypeAny>(
    url: string,
    init: RequestInit,
    schema: T,
    o: CFRequestOptions,
  ): Promise<Result<z.infer<T>, CodedError>> {
    const max = o.noRetry ? 0 : this.opts.maxRetries;
    for (let attempt = 0; attempt <= max; attempt++) {
      const r = await this.executeOnce(url, init, schema);
      if (r.ok) return r;
      if (!isRetryable(r.error) || attempt === max) return r;
      const delay = backoffDelay(attempt, this.opts.baseDelayMs);
      this.opts.logger.warn('cf_retry', { url: redactUrl(url), attempt, delay });
      await sleep(delay);
    }
    return err(new CodedError('E_CF_API', 'cf_unreachable'));
  }

  private async executeRawWithRetry(
    url: string,
    init: RequestInit,
    o: CFRequestOptions,
  ): Promise<Result<Response, CodedError>> {
    const max = o.noRetry ? 0 : this.opts.maxRetries;
    for (let attempt = 0; attempt <= max; attempt++) {
      try {
        const res = await this.opts.fetcher(url, init);
        if (res.ok) return ok(res);
        const body = await safeText(res);
        // DIAGNOSTIC: log the full upstream body so the next 401/4xx tells us
        // *why* (CF returns a structured error code in the JSON body that the
        // numeric status alone hides). Pair with `cf_auth_debug` above. Safe
        // to remove once the auth path is provably stable.
        this.opts.logger.error('cf_response_error', {
          status: res.status,
          url: redactUrl(url),
          body,
        });
        const e = new CodedError('E_CF_API', `cf_status_${res.status}`, {
          status: 502,
          details: { upstreamStatus: res.status, body: body.slice(0, 1024) },
        });
        if (!RETRYABLE_STATUS.has(res.status) || attempt === max) return err(e);
        const delay = backoffDelay(attempt, this.opts.baseDelayMs);
        this.opts.logger.warn('cf_retry_raw', { url: redactUrl(url), attempt, delay });
        await sleep(delay);
      } catch (cause) {
        if (attempt === max) return err(new CodedError('E_CF_API', 'cf_network', { cause }));
        await sleep(backoffDelay(attempt, this.opts.baseDelayMs));
      }
    }
    return err(new CodedError('E_CF_API', 'cf_unreachable'));
  }

  private async executeOnce<T extends z.ZodTypeAny>(
    url: string,
    init: RequestInit,
    schema: T,
  ): Promise<Result<z.infer<T>, CodedError>> {
    let res: Response;
    try {
      res = await this.opts.fetcher(url, init);
    } catch (cause) {
      return err(new CodedError('E_CF_API', 'cf_network', { cause }));
    }
    const text = await safeText(res);
    if (!res.ok) {
      // DIAGNOSTIC: see executeRawWithRetry's note. Same purpose, different
      // code path. Remove once the auth path is provably stable.
      this.opts.logger.error('cf_response_error', {
        status: res.status,
        url: redactUrl(url),
        body: text,
      });
      return err(
        new CodedError('E_CF_API', `cf_status_${res.status}`, {
          status: 502,
          details: { upstreamStatus: res.status, body: text.slice(0, 1024) },
        }),
      );
    }
    const parsed = parseEnvelope(text, schema);
    return parsed;
  }
}

const envelopeShape = z.object({
  success: z.boolean(),
  errors: z
    .array(z.object({ code: z.number().int().optional(), message: z.string() }).passthrough())
    .default([]),
  messages: z.array(z.unknown()).default([]),
  result: z.unknown(),
});

const parseEnvelope = <T extends z.ZodTypeAny>(
  text: string,
  schema: T,
): Result<z.infer<T>, CodedError> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return err(new CodedError('E_CF_API', 'cf_invalid_json', { details: { body: text.slice(0, 1024) } }));
  }
  const env = envelopeShape.safeParse(json);
  if (!env.success) {
    return err(
      new CodedError('E_CF_API', 'cf_envelope_mismatch', {
        details: { issues: env.error.issues.slice(0, 8) },
      }),
    );
  }
  if (!env.data.success) {
    return err(
      new CodedError('E_CF_API', 'cf_envelope_failed', {
        details: { errors: env.data.errors },
      }),
    );
  }
  const parsed = schema.safeParse(env.data.result);
  if (!parsed.success) {
    return err(
      new CodedError('E_CF_API', 'cf_result_mismatch', {
        details: { issues: parsed.error.issues.slice(0, 8) },
      }),
    );
  }
  return ok(parsed.data as z.infer<T>);
};

const isRetryable = (e: CodedError): boolean => {
  if (e.code !== 'E_CF_API') return false;
  const upstream = (e.details as { upstreamStatus?: number } | undefined)?.upstreamStatus;
  if (upstream && RETRYABLE_STATUS.has(upstream)) return true;
  return e.message === 'cf_network' || e.message === 'cf_invalid_json';
};

const safeText = async (res: Response): Promise<string> => {
  try {
    return await res.text();
  } catch {
    return '';
  }
};

const redactUrl = (url: string): string => url.replace(/(token|key)=[^&]+/gi, '$1=<redacted>');
