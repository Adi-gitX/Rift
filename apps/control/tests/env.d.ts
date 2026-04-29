/// <reference types="@cloudflare/workers-types" />
import type { D1Migration } from 'cloudflare:test';
import type { Env } from '../src/env.ts';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
