/**
 * Hono app-env type used across middleware and routes.
 * Kept in its own module to avoid circular imports between
 * `index.ts`, `middleware/*`, and `routes/*`.
 */
import type { Env } from './env.ts';
import type { Logger } from './lib/logger.ts';

export interface ControlAppEnv {
  Bindings: Env;
  Variables: {
    requestId: string;
    logger: Logger;
  };
}
