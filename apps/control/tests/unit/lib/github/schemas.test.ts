import { describe, expect, it } from 'vitest';
import { parseEvent } from '../../../../src/lib/github/schemas.ts';

const prBody = {
  action: 'opened',
  number: 42,
  pull_request: {
    number: 42,
    head: { sha: 'abc123', ref: 'feature/x' },
    base: { sha: 'def456', ref: 'main' },
    user: { login: 'alice' },
  },
  repository: { id: 1, name: 'api', full_name: 'acme/api', default_branch: 'main' },
  installation: { id: 99 },
};

describe('parseEvent', () => {
  it('parses pull_request.opened', () => {
    const r = parseEvent('pull_request', prBody);
    expect(r.kind).toBe('pull_request');
    if (r.kind !== 'pull_request') return;
    expect(r.event.action).toBe('opened');
    expect(r.event.pull_request.head.sha).toBe('abc123');
  });

  it('ignores unknown events', () => {
    const r = parseEvent('issue_comment', { foo: 1 });
    expect(r.kind).toBe('ignored');
  });

  it('returns ignored on schema mismatch (no throw)', () => {
    const r = parseEvent('pull_request', { bogus: true });
    expect(r.kind).toBe('ignored');
  });

  it('parses installation.created', () => {
    const r = parseEvent('installation', {
      action: 'created',
      installation: { id: 1, account: { login: 'a', id: 2, type: 'User' } },
    });
    expect(r.kind).toBe('installation');
    if (r.kind !== 'installation') return;
    expect(r.event.installation.account.type).toBe('User');
  });
});
