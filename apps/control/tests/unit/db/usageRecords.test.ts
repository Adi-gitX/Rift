import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ulid } from '../../../src/lib/ids.ts';
import {
  getUsageForPeriod,
  listUsageForInstallation,
  upsertUsageRecord,
} from '../../../src/lib/db/usageRecords.ts';

describe('usage_records repo', () => {
  it('upsert is idempotent on (installation, period_start) and updates counters', async () => {
    const installationId = 'inst-usage-1';
    const periodStart = 1_700_000_000;
    await upsertUsageRecord(env.DB, {
      id: ulid(),
      installationId,
      periodStart,
      periodEnd: periodStart + 86400,
      prEnvsActive: 5,
      prEnvsCreated: 1,
      d1SizeBytes: 100,
      r2SizeBytes: 200,
    });
    await upsertUsageRecord(env.DB, {
      id: ulid(),
      installationId,
      periodStart,
      periodEnd: periodStart + 86400,
      prEnvsActive: 7,
      prEnvsCreated: 2,
      d1SizeBytes: 300,
      r2SizeBytes: 400,
    });
    const r = await getUsageForPeriod(env.DB, installationId, periodStart);
    if (!r.ok || !r.value) throw new Error('missing');
    expect(r.value.prEnvsActive).toBe(7);
    expect(r.value.prEnvsCreated).toBe(2);
    expect(r.value.d1SizeBytes).toBe(300);
    expect(r.value.r2SizeBytes).toBe(400);
  });

  it('lists usage records newest first', async () => {
    const installationId = 'inst-usage-2';
    for (const day of [1, 2, 3]) {
      await upsertUsageRecord(env.DB, {
        id: ulid(),
        installationId,
        periodStart: day * 86400,
        periodEnd: (day + 1) * 86400,
        prEnvsActive: day,
        prEnvsCreated: 0,
        d1SizeBytes: 0,
        r2SizeBytes: 0,
      });
    }
    const r = await listUsageForInstallation(env.DB, installationId);
    if (!r.ok) throw r.error;
    expect(r.value.map((u) => u.prEnvsActive)).toEqual([3, 2, 1]);
  });
});
