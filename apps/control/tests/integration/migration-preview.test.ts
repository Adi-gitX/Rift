/**
 * D1 branching + migration preview, end to end through the ProvisionRunner:
 *
 *   wrangler.jsonc at headSha declares d1_databases[0] → load-config detects
 *   the base → fork-base-db exports base + imports into the per-PR D1 →
 *   apply-migrations runs only the pending migrations/*.sql (0001 is already
 *   in the base's d1_migrations) → snapshot-schema diffs fork vs base →
 *   route-and-comment posts a sticky comment carrying the Database section.
 *
 * CF + GitHub are the in-memory fakes in tests/fake-d1.ts / fake-github.ts.
 * The GitHub installation token is pre-seeded in CACHE so no App PEM is needed.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ProvisionRunner } from '../../src/do/provision-runner.ts';
import type { ProvisionRunnerState } from '../../src/runner/provision/state.ts';
import type {
  ApplyMigrationsResult,
  ForkBaseDbResult,
  LoadConfigResult,
  SnapshotSchemaResult,
} from '../../src/runner/provision/steps.ts';
import { upsertInstallation } from '../../src/lib/db/installations.ts';
import { upsertRepo } from '../../src/lib/db/repos.ts';
import { createPrEnvironment } from '../../src/lib/db/prEnvironments.ts';

const BASE_DB = 'base-users-db';

const INIT_SQL = `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);`;
const POSTS_SQL = `-- add posts
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL
);
CREATE INDEX idx_posts_user ON posts(user_id);
ALTER TABLE users ADD COLUMN bio TEXT;
INSERT INTO posts (user_id, title) SELECT id, 'hello' FROM users;`;
const BAD_SQL = `CREATE TABLE users (id INTEGER PRIMARY KEY);`; // already exists → SQLITE_ERROR
const RENAME_SQL = `ALTER TABLE users RENAME COLUMN bio TO about;`;

const seedFakeD1 = async (db: string, sql: string): Promise<void> => {
  const r = await fetch('https://fake-d1.local/seed', {
    method: 'POST',
    body: JSON.stringify({ db, sql }),
  });
  if (!r.ok) throw new Error(`seed failed: ${await r.text()}`);
};

const seedFakeGithub = async (repo: string, files: Record<string, string>): Promise<void> => {
  await fetch('https://fake-gh.local/seed', {
    method: 'POST',
    body: JSON.stringify({ repo, files }),
  });
};

const wranglerJsonc = `// customer config
{
  "name": "demo",
  "main": "src/index.ts",
  "d1_databases": [
    { "binding": "DB", "database_name": "raft-demo-source", "database_id": "${BASE_DB}" }, // trailing comma ok
  ],
}`;

const seedRepo = async (
  suffix: string,
  prNumber = 1,
): Promise<{ prEnvId: string; installationId: string; repoFullName: string }> => {
  const installationId = `mig-${suffix}`;
  const repoFullName = `acme/mig-${suffix}`;
  await upsertInstallation(env.DB, {
    id: installationId,
    githubAccount: 'acme',
    githubAccountId: 1,
    accountType: 'organization',
  });
  const r = await upsertRepo(env.DB, {
    installationId,
    githubRepoId: 1,
    fullName: repoFullName,
    uploadTokenHash: 'h',
  });
  if (!r.ok) throw r.error;
  const pe = await createPrEnvironment(env.DB, {
    repoId: r.value.id,
    prNumber,
    headSha: `sha-${suffix}`,
  });
  if (!pe.ok) throw pe.error;
  // Pre-seed the GitHub installation token so getInstallationToken() skips JWT signing.
  await env.CACHE.put(`gh:install-token:${installationId}`, 'ghs_test');
  return { prEnvId: pe.value.id, installationId, repoFullName };
};

const initialState = (
  s: { prEnvId: string; installationId: string; repoFullName: string },
  suffix: string,
  headSha: string,
): ProvisionRunnerState => ({
  prEnvId: s.prEnvId,
  installationId: s.installationId,
  scope: `pr-1--acmemig${suffix}`,
  scriptName: `raft-mig${suffix}-acmemig${suffix}-pr-1`,
  previewHostname: `https://raft-dispatcher.raft-test.workers.dev/pr-1--acmemig${suffix}`,
  params: {
    installationId: s.installationId,
    repoFullName: s.repoFullName,
    prNumber: 1,
    headSha,
    baseSha: 'b',
    baseBranch: 'main',
    triggerActor: 'alice',
  },
  cursor: 0,
  status: 'pending',
  attempts: 0,
  startedAt: 0,
  errorHistory: [],
});

const drive = async (
  stub: DurableObjectStub<ProvisionRunner>,
): Promise<ProvisionRunnerState | null> => {
  for (let i = 0; i < 40; i++) {
    await runDurableObjectAlarm(stub);
    const snap = await runInDurableObject(stub, async (inst: ProvisionRunner) =>
      inst.getStateSnapshot(),
    );
    if (!snap || snap.status === 'succeeded' || snap.status === 'failed') return snap;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
};

const results = (stub: DurableObjectStub<ProvisionRunner>) =>
  runInDurableObject(stub, async (inst: ProvisionRunner) => inst.getStepResults());

describe('D1 branching + migration preview', () => {
  beforeAll(async () => {
    // Base "production" DB: users table with 3 rows and 0001 already applied.
    await seedFakeD1(
      BASE_DB,
      `${INIT_SQL} INSERT INTO users VALUES (1); INSERT INTO users VALUES (2); INSERT INTO users VALUES (3);
       CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
       INSERT INTO d1_migrations (name) VALUES ('0001_init.sql');`,
    );
  });

  it('forks the base, applies only pending migrations, diffs schema, and comments', async () => {
    const seeded = await seedRepo('a');
    await seedFakeGithub(seeded.repoFullName, {
      'wrangler.jsonc': wranglerJsonc,
      'src/index.ts': 'export default {}',
      'migrations/0001_init.sql': INIT_SQL,
      'migrations/0002_add_posts.sql': POSTS_SQL,
      'migrations/README.md': 'not sql',
    });
    // Customer-bundle mode needs an uploaded bundle; pre-seed it.
    await env.BUNDLES_KV.put(
      `bundle:${seeded.installationId}:${seeded.repoFullName}:sha-a`,
      JSON.stringify({
        wrangler: { main_module: 'index.js' },
        modules: [{ name: 'index.js', content_b64: btoa('export default {}') }],
      }),
    );
    const stub = env.PROVISION_RUNNER.get(
      env.PROVISION_RUNNER.idFromName(seeded.prEnvId),
    ) as DurableObjectStub<ProvisionRunner>;
    await stub.start(initialState(seeded, 'a', 'sha-a'));
    const final = await drive(stub);
    expect(final?.status).toBe('succeeded');

    const r = await results(stub);
    const config = r['load-config'] as LoadConfigResult;
    expect(config.mode).toBe('customer-bundle');
    expect(config.db?.baseDatabaseId).toBe(BASE_DB);
    expect(config.db?.migrationFiles.map((f) => f.name)).toEqual([
      '0001_init.sql',
      '0002_add_posts.sql',
    ]);

    const fork = r['fork-base-db'] as ForkBaseDbResult;
    expect(fork.source).toBe('forked');
    expect(fork.baseDatabaseName).toBe('raft-demo-source');

    const apply = r['apply-migrations'] as ApplyMigrationsResult;
    expect(apply.status).toBe('applied');
    expect(apply.alreadyApplied).toEqual(['0001_init.sql']);
    expect(apply.applied).toEqual(['0002_add_posts.sql']);
    expect(apply.outcomes[0]?.statements).toBe(4);
    expect(apply.warnings).toEqual([]);

    const snap = r['snapshot-schema'] as SnapshotSchemaResult;
    expect(snap.status).toBe('diffed');
    expect(snap.diff?.tablesAdded).toEqual(['posts']);
    expect(snap.diff?.columnsAdded).toEqual([{ table: 'users', column: 'bio', type: 'TEXT' }]);
    expect(snap.diff?.indexesAdded).toEqual(['idx_posts_user']);
    expect(snap.diff?.rowDeltas).toEqual([{ table: 'posts', after: 3 }]);

    // Base untouched: still only `users`, no posts.
    const baseDump = await (await fetch(`https://fake-d1.local/dump?db=${BASE_DB}`)).text();
    expect(baseDump).not.toContain('posts');

    // Repo row learned its base D1.
    const repoRow = await env.DB.prepare('SELECT base_d1_id FROM repos WHERE full_name = ?')
      .bind(seeded.repoFullName)
      .first<{ base_d1_id: string }>();
    expect(repoRow?.base_d1_id).toBe(BASE_DB);

    // Sticky comment carries the Database section.
    const comments = (await (
      await fetch(
        `https://fake-gh.local/comments?key=${encodeURIComponent(`${seeded.repoFullName}#1`)}`,
      )
    ).json()) as { body: string }[];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain('**Database:** forked from base `raft-demo-source`');
    expect(comments[0]?.body).toContain('`0002_add_posts.sql`');
    expect(comments[0]?.body).toContain('| + table | `posts` |');
    expect(comments[0]?.body).toContain('| + column | `users.bio` TEXT |');
    expect(comments[0]?.body).toContain('posts 0 → 3');
  });

  it('a failing migration is reported, later ones are skipped, and the preview still ships', async () => {
    const seeded = await seedRepo('b');
    await seedFakeGithub(seeded.repoFullName, {
      'wrangler.jsonc': wranglerJsonc,
      'migrations/0001_init.sql': INIT_SQL,
      'migrations/0002_bad.sql': BAD_SQL,
      'migrations/0003_rename.sql': RENAME_SQL,
    });
    await env.BUNDLES_KV.put(
      `bundle:${seeded.installationId}:${seeded.repoFullName}:sha-b`,
      JSON.stringify({
        wrangler: { main_module: 'index.js' },
        modules: [{ name: 'index.js', content_b64: btoa('export default {}') }],
      }),
    );
    const stub = env.PROVISION_RUNNER.get(
      env.PROVISION_RUNNER.idFromName(seeded.prEnvId),
    ) as DurableObjectStub<ProvisionRunner>;
    await stub.start(initialState(seeded, 'b', 'sha-b'));
    const final = await drive(stub);
    expect(final?.status).toBe('succeeded');

    const apply = (await results(stub))['apply-migrations'] as ApplyMigrationsResult;
    expect(apply.status).toBe('failed');
    expect(apply.outcomes.map((o) => [o.name, o.status])).toEqual([
      ['0002_bad.sql', 'failed'],
      ['0003_rename.sql', 'skipped'],
    ]);
    expect(apply.outcomes[0]?.error).toContain('already exists');

    const row = await env.DB.prepare('SELECT state FROM pr_environments WHERE id = ?')
      .bind(seeded.prEnvId)
      .first<{ state: string }>();
    expect(row?.state).toBe('ready');

    const comments = (await (
      await fetch(
        `https://fake-gh.local/comments?key=${encodeURIComponent(`${seeded.repoFullName}#1`)}`,
      )
    ).json()) as { body: string }[];
    expect(comments[0]?.body).toContain('❌ **Migration failed:** `0002_bad.sql`');
    expect(comments[0]?.body).toContain('Skipped: `0003_rename.sql`');
  });

  it('synchronize re-runs apply-migrations, skips already-applied files, and flags destructive SQL', async () => {
    const seeded = await seedRepo('c');
    const files = {
      'wrangler.jsonc': wranglerJsonc,
      'migrations/0001_init.sql': INIT_SQL,
      'migrations/0002_add_posts.sql': POSTS_SQL,
    };
    await seedFakeGithub(seeded.repoFullName, files);
    const bundle = JSON.stringify({
      wrangler: { main_module: 'index.js' },
      modules: [{ name: 'index.js', content_b64: btoa('export default {}') }],
    });
    await env.BUNDLES_KV.put(
      `bundle:${seeded.installationId}:${seeded.repoFullName}:sha-c`,
      bundle,
    );
    const stub = env.PROVISION_RUNNER.get(
      env.PROVISION_RUNNER.idFromName(seeded.prEnvId),
    ) as DurableObjectStub<ProvisionRunner>;
    await stub.start(initialState(seeded, 'c', 'sha-c'));
    expect((await drive(stub))?.status).toBe('succeeded');

    // New push adds a rename migration.
    await seedFakeGithub(seeded.repoFullName, {
      ...files,
      'migrations/0003_rename.sql': RENAME_SQL,
    });
    await env.BUNDLES_KV.put(
      `bundle:${seeded.installationId}:${seeded.repoFullName}:sha-c2`,
      bundle,
    );
    await stub.start(initialState(seeded, 'c', 'sha-c2'));
    expect((await drive(stub))?.status).toBe('succeeded');

    const r = await results(stub);
    const apply = r['apply-migrations'] as ApplyMigrationsResult;
    expect(apply.alreadyApplied).toEqual(['0001_init.sql', '0002_add_posts.sql']);
    expect(apply.applied).toEqual(['0003_rename.sql']);
    expect(apply.warnings).toEqual([
      expect.objectContaining({
        kind: 'rename',
        migration: '0003_rename.sql',
        severity: 'warning',
      }),
    ]);
    const snap = r['snapshot-schema'] as SnapshotSchemaResult;
    expect(snap.diff?.columnsAdded).toEqual([{ table: 'users', column: 'about', type: 'TEXT' }]);
    // fork-base-db was NOT re-run (one-shot per PR env).
    expect((r['fork-base-db'] as ForkBaseDbResult).source).toBe('forked');

    const comments = (await (
      await fetch(
        `https://fake-gh.local/comments?key=${encodeURIComponent(`${seeded.repoFullName}#1`)}`,
      )
    ).json()) as { body: string }[];
    expect(comments).toHaveLength(1); // edited in place, never duplicated
    expect(comments[0]?.body).toContain('⚠️ **Destructive statement** (rename)');
  });
});
