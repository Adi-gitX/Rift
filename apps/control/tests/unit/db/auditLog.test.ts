import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ulid } from '../../../src/lib/ids.ts';
import {
  appendAudit,
  listAuditForInstallation,
  listAuditForTarget,
} from '../../../src/lib/db/auditLog.ts';

describe('audit_log repo', () => {
  it('appends entries and lists by installation, newest first', async () => {
    const installId = 'inst-audit-1';
    await appendAudit(env.DB, {
      id: ulid(1),
      installationId: installId,
      actor: 'github-webhook',
      action: 'pr.opened',
      targetType: 'pr_environment',
      targetId: 'inst:repo:1',
      metadata: { sha: 'abc' },
      createdAt: 100,
    });
    await appendAudit(env.DB, {
      id: ulid(2),
      installationId: installId,
      actor: 'cron',
      action: 'gc.swept',
      targetType: 'pr_environment',
      targetId: 'inst:repo:2',
      createdAt: 200,
    });
    const r = await listAuditForInstallation(env.DB, installId);
    if (!r.ok) throw r.error;
    expect(r.value).toHaveLength(2);
    expect(r.value[0]?.action).toBe('gc.swept');
    expect(r.value[1]?.action).toBe('pr.opened');
    expect(r.value[1]?.metadata).toEqual({ sha: 'abc' });
  });

  it('lists by target', async () => {
    const installId = 'inst-audit-2';
    await appendAudit(env.DB, {
      id: ulid(),
      installationId: installId,
      actor: 'user@example.com',
      action: 'pr.redeployed',
      targetType: 'pr_environment',
      targetId: 'X',
    });
    const r = await listAuditForTarget(env.DB, 'pr_environment', 'X');
    if (!r.ok) throw r.error;
    expect(r.value).toHaveLength(1);
    expect(r.value[0]?.actor).toBe('user@example.com');
  });
});
