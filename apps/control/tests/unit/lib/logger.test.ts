import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../../../src/lib/logger.ts';

describe('Logger', () => {
  it('writes a JSON line with msg + base + meta', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    new Logger({ request_id: 'req-1' }).info('hello', { extra: 1 });
    expect(spy).toHaveBeenCalledOnce();
    const arg = spy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg) as Record<string, unknown>;
    expect(parsed.msg).toBe('hello');
    expect(parsed.request_id).toBe('req-1');
    expect(parsed.extra).toBe(1);
    expect(parsed.level).toBe('info');
    spy.mockRestore();
  });

  it('redacts long token-like strings (>=40 chars)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const token = 'abcdef'.repeat(8); // 48 chars
    new Logger().info(`saw token ${token}`);
    const arg = spy.mock.calls[0]?.[0] as string;
    expect(arg).not.toContain(token);
    expect(arg).toMatch(/<redacted:token:abcdef>/);
    spy.mockRestore();
  });

  it('preserves UUIDs (36 chars) so request_id stays traceable', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const uuid = '12345678-1234-1234-1234-123456789012';
    new Logger({ request_id: uuid }).info('hi');
    const arg = spy.mock.calls[0]?.[0] as string;
    expect(arg).toContain(uuid);
    spy.mockRestore();
  });

  it('respects minLevel', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    new Logger({}, 'warn').info('skipped');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('child appends fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    new Logger({ a: 1 }).child({ b: 2 }).info('m', { c: 3 });
    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(parsed.a).toBe(1);
    expect(parsed.b).toBe(2);
    expect(parsed.c).toBe(3);
    spy.mockRestore();
  });
});
