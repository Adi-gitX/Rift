import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import { cfApiOutboundMock } from './tests/cf-api-mock.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = await readD1Migrations(path.join(here, 'migrations'));

export default defineWorkersConfig({
  css: { postcss: { plugins: [] } },
  test: {
    setupFiles: ['./tests/apply-migrations.ts'],
    include: ['tests/**/*.{test,spec}.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: path.join(here, 'wrangler.jsonc') },
        miniflare: {
          compatibilityDate: '2026-04-29',
          compatibilityFlags: ['nodejs_compat'],
          outboundService: cfApiOutboundMock,
          d1Databases: { DB: 'raft-meta-test' },
          kvNamespaces: ['CACHE', 'ROUTES', 'BUNDLES_KV'],
          queueProducers: { EVENTS: 'raft-events', TAIL_EVENTS: 'raft-tail-events' },
          queueConsumers: {
            'raft-events': { maxBatchSize: 10, maxBatchTimeout: 1 },
            'raft-tail-events': { maxBatchSize: 50, maxBatchTimeout: 1 },
          },
          durableObjects: {
            REPO: { className: 'RepoCoordinator', useSQLite: true },
            PR_ENV: { className: 'PrEnvironment', useSQLite: true },
            LOGTAIL: { className: 'LogTail', useSQLite: true },
            PROVISION_RUNNER: { className: 'ProvisionRunner', useSQLite: true },
            TEARDOWN_RUNNER: { className: 'TeardownRunner', useSQLite: true },
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            CF_WORKERS_SUBDOMAIN: 'raft-test.workers.dev',
            GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
            GITHUB_APP_PRIVATE_KEY: '',
            SESSION_SIGNING_KEY: 'test-session-signing-key-32-bytes!!',
            INTERNAL_DISPATCH_SECRET: 'test-dispatch-secret',
            CF_API_TOKEN: 'test-cf-token',
          },
        },
      },
    },
  },
});
