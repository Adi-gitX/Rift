/**
 * TeardownRunner DO — alarm-driven destructor (mirrors ProvisionRunner).
 *
 * Idempotency: each step's outcome is cached in DO storage by name; replays
 * (manual re-trigger, cron sweep firing twice) reuse the cached result and
 * never re-call the CF API. Network-level idempotency is also enforced by
 * treating `cf_status_404` as "already gone".
 */
import { DurableObject } from 'cloudflare:workers';
import { CodedError, NonRetryableError } from '@raft/shared-types';
import type { Env } from '../env.ts';
import { Logger } from '../lib/logger.ts';
import { appendAudit } from '../lib/db/auditLog.ts';
import { ulid } from '../lib/ids.ts';
import type { PrEnvironment } from './pr-environment.ts';
import type { PrEnvState } from '../lib/db/types.ts';
import {
  type TeardownRunnerState,
  TEARDOWN_BACKOFF_MS,
  TEARDOWN_MAX_ATTEMPTS,
  TEARDOWN_STEP_ORDER,
  currentTeardownStep,
} from '../runner/teardown/state.ts';
import { TEARDOWN_STEP_FNS, type TeardownStepContext } from '../runner/teardown/steps.ts';

const STATE_KEY = 'state';
const stepKey = (name: string): string => `step:${name}`;

export class TeardownRunner extends DurableObject<Env> {
  async start(state: TeardownRunnerState): Promise<void> {
    const fresh: TeardownRunnerState = { ...state, status: 'running', startedAt: Date.now() };
    await this.ctx.storage.put(STATE_KEY, fresh);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async getStateSnapshot(): Promise<TeardownRunnerState | null> {
    return (await this.ctx.storage.get<TeardownRunnerState>(STATE_KEY)) ?? null;
  }

  async getStepResults(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const name of TEARDOWN_STEP_ORDER) {
      const cached = await this.ctx.storage.get<unknown>(stepKey(name));
      if (cached !== undefined) out[name] = cached;
    }
    return out;
  }

  override async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<TeardownRunnerState>(STATE_KEY);
    if (!state || state.status !== 'running') return;
    const step = currentTeardownStep(state);
    if (!step) {
      await this.markSucceeded(state);
      return;
    }
    const log = new Logger({
      pr_env_id: state.prEnvId,
      installation_id: state.installationId,
      teardown_step: step,
      attempt: state.attempts + 1,
    });
    const cached = await this.ctx.storage.get<unknown>(stepKey(step));
    if (cached !== undefined) {
      log.info('teardown_step_cached_skip');
      await this.advance(state);
      return;
    }
    await this.runStep(state, step, log);
  }

  private async runStep(
    state: TeardownRunnerState,
    step: (typeof TEARDOWN_STEP_ORDER)[number],
    log: Logger,
  ): Promise<void> {
    const ctx: TeardownStepContext = {
      env: this.env,
      prEnvId: state.prEnvId,
      installationId: state.installationId,
      log,
    };
    try {
      if (step === 'mark-tearing-down') {
        await this.transitionPrEnv(state, 'tearing_down');
      }
      const result: unknown = await TEARDOWN_STEP_FNS[step](ctx);
      await this.ctx.storage.put(stepKey(step), result);
      log.info('teardown_step_ok');
      await this.advance(state);
    } catch (e) {
      await this.handleStepError(state, step, e, log);
    }
  }

  private async transitionPrEnv(
    state: TeardownRunnerState,
    next: PrEnvState,
  ): Promise<void> {
    const stub = this.env.PR_ENV.get(
      this.env.PR_ENV.idFromName(state.prEnvId),
    ) as DurableObjectStub<PrEnvironment>;
    await stub.transitionTo(state.prEnvId, next, {
      installationId: state.installationId,
      reason: state.reason,
    });
  }

  private async advance(state: TeardownRunnerState): Promise<void> {
    const next: TeardownRunnerState = { ...state, cursor: state.cursor + 1, attempts: 0 };
    if (next.cursor >= TEARDOWN_STEP_ORDER.length) {
      await this.markSucceeded(next);
      return;
    }
    await this.ctx.storage.put(STATE_KEY, next);
    await this.ctx.storage.setAlarm(Date.now());
  }

  private async handleStepError(
    state: TeardownRunnerState,
    step: (typeof TEARDOWN_STEP_ORDER)[number],
    e: unknown,
    log: Logger,
  ): Promise<void> {
    const message = e instanceof Error ? e.message : String(e);
    const updated: TeardownRunnerState = {
      ...state,
      attempts: state.attempts + 1,
      errorHistory: [
        ...state.errorHistory,
        { step, ts: Date.now(), message, attempt: state.attempts + 1 },
      ],
    };
    if (e instanceof NonRetryableError || updated.attempts >= TEARDOWN_MAX_ATTEMPTS) {
      log.error('teardown_step_giving_up', { err: message });
      await this.markFailed(updated, message);
      return;
    }
    const delay = TEARDOWN_BACKOFF_MS[updated.attempts - 1] ?? 16000;
    log.warn('teardown_step_retry_scheduled', { err: message, delay_ms: delay });
    await this.ctx.storage.put(STATE_KEY, updated);
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  private async markSucceeded(state: TeardownRunnerState): Promise<void> {
    const final: TeardownRunnerState = { ...state, status: 'succeeded', finishedAt: Date.now() };
    await this.ctx.storage.put(STATE_KEY, final);
    await this.transitionPrEnv(state, 'torn_down');
    await appendAudit(this.env.DB, {
      id: ulid(),
      installationId: state.installationId,
      actor: 'teardown-runner',
      action: 'teardown.succeeded',
      targetType: 'pr_environment',
      targetId: state.prEnvId,
      metadata: { reason: state.reason },
    });
  }

  private async markFailed(state: TeardownRunnerState, reason: string): Promise<void> {
    const final: TeardownRunnerState = { ...state, status: 'failed', finishedAt: Date.now() };
    await this.ctx.storage.put(STATE_KEY, final);
    await appendAudit(this.env.DB, {
      id: ulid(),
      installationId: state.installationId,
      actor: 'teardown-runner',
      action: 'teardown.failed',
      targetType: 'pr_environment',
      targetId: state.prEnvId,
      metadata: { reason, attempts: state.attempts },
    });
  }
}

const _coded = CodedError;
void _coded;
