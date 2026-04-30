/**
 * ProvisionRunner DO — alarm-driven step machine that replaces Cloudflare
 * Workflows under the free-tier substitution.
 *
 * Lifecycle:
 *   start(params) → persists initial state, sets immediate alarm.
 *   alarm()       → reads cursor, looks up step in STEP_FNS, runs.
 *                   on success: persists step:NAME result, advances cursor,
 *                   re-arms alarm immediately to run next step.
 *                   on retryable error: backs off (1s/2s/4s/8s/16s, max 5).
 *                   on NonRetryableError: status=failed, transitions
 *                   PR env to failed, fires compensating teardown.
 *
 * Idempotency: each step's result is cached in DO storage by name; if
 * `alarm()` is re-entered after the runner already advanced past a step,
 * the prior result is read from storage and re-used (no double API calls).
 */
import { DurableObject } from 'cloudflare:workers';
import { CodedError, NonRetryableError } from '@raft/shared-types';
import type { Env } from '../env.ts';
import { Logger } from '../lib/logger.ts';
import { appendAudit } from '../lib/db/auditLog.ts';
import { getPrEnvironment } from '../lib/db/prEnvironments.ts';
import { ulid } from '../lib/ids.ts';
import type { PrEnvironment } from './pr-environment.ts';
import type { PrEnvState } from '../lib/db/types.ts';
import {
  type ProvisionRunnerState,
  BACKOFF_MS,
  MAX_ATTEMPTS,
  STEP_ORDER,
  currentStep,
} from '../runner/provision/state.ts';
import { STEP_FNS, type StepContext } from '../runner/provision/steps.ts';

const STATE_KEY = 'state';
const stepKey = (name: string): string => `step:${name}`;

export class ProvisionRunner extends DurableObject<Env> {
  async start(state: ProvisionRunnerState): Promise<void> {
    // Drop cached results for steps whose output is bound to the headSha or
    // a transient external (the customer's bundle upload). KEEP
    // `provision-resources` cached: D1/KV/Queue have deterministic names,
    // re-creating them every redeploy would 400. The resources are
    // intentionally reused across redeploys of the same PR.
    //
    // SYNCHRONIZE-RACE NOTE: a synchronize event for a NEW headSha lands
    // while the alarm is mid-step. DO runtime serialises RPC + alarm so
    // there's no concurrent execution; the in-flight alarm finishes its
    // step under the OLD state, then start() overwrites state with a fresh
    // cursor=0 + cleared SHA-bound caches, and the next alarm runs the new
    // SHA from scratch. Only fields below need clearing.
    // fork-base-db is intentionally OMITTED — re-forking on every redeploy
    // would re-import SQL on top of an already-seeded DB (destructive: rows
    // duplicate, schema migrations may conflict). Fork is a one-shot per
    // PR env, like resource creation.
    const SHA_DEPENDENT_STEPS = ['load-config', 'await-bundle', 'rewrite-bundle', 'upload-script', 'route-and-comment'] as const;
    for (const name of SHA_DEPENDENT_STEPS) {
      await this.ctx.storage.delete(stepKey(name));
    }
    const fresh: ProvisionRunnerState = {
      ...state,
      status: 'running',
      startedAt: Date.now(),
      // Reset per-step timings so the latency chart reflects this run, not the prior one.
      stepTimings: {},
    };
    await this.ctx.storage.put(STATE_KEY, fresh);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async getStateSnapshot(): Promise<ProvisionRunnerState | null> {
    return (await this.ctx.storage.get<ProvisionRunnerState>(STATE_KEY)) ?? null;
  }

  /** Returns the cached results of every step that has run so far. */
  async getStepResults(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const name of STEP_ORDER) {
      const cached = await this.ctx.storage.get<unknown>(stepKey(name));
      if (cached !== undefined) out[name] = cached;
    }
    return out;
  }

  override async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<ProvisionRunnerState>(STATE_KEY);
    if (!state) return;
    if (state.status !== 'running') return;
    // Guard against PR-closed-mid-provision races: if the PR env has been
    // moved to a terminal state by the teardown path, abort gracefully so
    // the runner doesn't keep hammering CF API against deleted resources.
    if (await this.shouldAbortForPrEnvState(state.prEnvId)) {
      await this.markFailed(state, 'aborted: pr_env in terminal state');
      return;
    }
    const step = currentStep(state);
    if (!step) {
      await this.markSucceeded(state);
      return;
    }
    const log = new Logger({
      pr_env_id: state.prEnvId,
      installation_id: state.installationId,
      runner_step: step,
      attempt: state.attempts + 1,
    });
    const cached = await this.ctx.storage.get<unknown>(stepKey(step));
    if (cached !== undefined) {
      await this.advance(state);
      return;
    }
    await this.runStep(state, step, log);
  }

  private async runStep(
    state: ProvisionRunnerState,
    step: (typeof STEP_ORDER)[number],
    log: Logger,
  ): Promise<void> {
    const prior = await this.collectPriorResults();
    const fetcher = globalThis.fetch.bind(globalThis);
    const ctx: StepContext = {
      env: this.env,
      params: state.params,
      prEnvId: state.prEnvId,
      scope: state.scope,
      scriptName: state.scriptName,
      previewHostname: state.previewHostname,
      log,
      fetcher,
      prior,
    };
    // Stamp step start (only on the first attempt — retries reuse the same
    // startedAt so wall-clock duration covers all attempts honestly).
    const timings = state.stepTimings ?? {};
    if (!timings[step]?.startedAt) {
      timings[step] = { ...(timings[step] ?? {}), startedAt: Date.now() };
      await this.ctx.storage.put(STATE_KEY, { ...state, stepTimings: timings });
    }
    try {
      const result: unknown = await STEP_FNS[step](ctx);
      await this.ctx.storage.put(stepKey(step), result);
      // Stamp finishedAt and persist.
      timings[step] = { ...(timings[step] ?? {}), finishedAt: Date.now() };
      const latest = (await this.ctx.storage.get<ProvisionRunnerState>(STATE_KEY)) ?? state;
      await this.ctx.storage.put(STATE_KEY, { ...latest, stepTimings: timings });
      log.info('step_ok', { ms: timings[step]!.finishedAt! - (timings[step]!.startedAt ?? Date.now()) });
      await this.advance({ ...latest, stepTimings: timings });
    } catch (e) {
      await this.handleStepError(state, step, e, log);
    }
  }

  private async collectPriorResults(): Promise<Record<string, unknown>> {
    const prior: Record<string, unknown> = {};
    for (const name of STEP_ORDER) {
      const cached = await this.ctx.storage.get<unknown>(stepKey(name));
      if (cached !== undefined) prior[name] = cached;
    }
    return prior;
  }

  /** Reads the PR env D1 row and returns true if the runner should abort. */
  private async shouldAbortForPrEnvState(prEnvId: string): Promise<boolean> {
    const r = await getPrEnvironment(this.env.DB, prEnvId);
    if (!r.ok || !r.value) return false;
    const terminal: PrEnvState[] = ['tearing_down', 'torn_down', 'failed'];
    return terminal.includes(r.value.state);
  }

  private async advance(state: ProvisionRunnerState): Promise<void> {
    const next: ProvisionRunnerState = {
      ...state,
      cursor: state.cursor + 1,
      attempts: 0,
    };
    if (next.cursor >= STEP_ORDER.length) {
      await this.markSucceeded(next);
      return;
    }
    await this.ctx.storage.put(STATE_KEY, next);
    await this.ctx.storage.setAlarm(Date.now());
  }

  private async handleStepError(
    state: ProvisionRunnerState,
    step: (typeof STEP_ORDER)[number],
    e: unknown,
    log: Logger,
  ): Promise<void> {
    const message = e instanceof Error ? e.message : String(e);
    const errEntry = { step, ts: Date.now(), message, attempt: state.attempts + 1 };
    const updated: ProvisionRunnerState = {
      ...state,
      attempts: state.attempts + 1,
      errorHistory: [...state.errorHistory, errEntry],
    };
    if (e instanceof NonRetryableError) {
      log.error('step_non_retryable', { err: message });
      await this.markFailed(updated, message);
      return;
    }
    if (updated.attempts >= MAX_ATTEMPTS) {
      log.error('step_exhausted', { err: message });
      await this.markFailed(updated, message);
      return;
    }
    const delay = BACKOFF_MS[updated.attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 16000;
    log.warn('step_retry_scheduled', { err: message, delay_ms: delay });
    await this.ctx.storage.put(STATE_KEY, updated);
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  private async markSucceeded(state: ProvisionRunnerState): Promise<void> {
    const final: ProvisionRunnerState = { ...state, status: 'succeeded', finishedAt: Date.now() };
    await this.ctx.storage.put(STATE_KEY, final);
    await this.transitionPrEnv(state.prEnvId, state.installationId, 'ready', 'provision-succeeded');
    await appendAudit(this.env.DB, {
      id: ulid(),
      installationId: state.installationId,
      actor: 'provision-runner',
      action: 'provision.succeeded',
      targetType: 'pr_environment',
      targetId: state.prEnvId,
      metadata: { script: state.scriptName, hostname: state.previewHostname },
    });
  }

  private async transitionPrEnv(
    prEnvId: string,
    installationId: string,
    next: PrEnvState,
    reason: string,
  ): Promise<void> {
    const prStub = this.env.PR_ENV.get(
      this.env.PR_ENV.idFromName(prEnvId),
    ) as DurableObjectStub<PrEnvironment>;
    await prStub.transitionTo(prEnvId, next, { installationId, reason });
  }

  private async markFailed(state: ProvisionRunnerState, reason: string): Promise<void> {
    const final: ProvisionRunnerState = { ...state, status: 'failed', finishedAt: Date.now() };
    await this.ctx.storage.put(STATE_KEY, final);
    await this.transitionPrEnv(state.prEnvId, state.installationId, 'failed', reason);
    await appendAudit(this.env.DB, {
      id: ulid(),
      installationId: state.installationId,
      actor: 'provision-runner',
      action: 'provision.failed',
      targetType: 'pr_environment',
      targetId: state.prEnvId,
      metadata: { reason, attempts: state.attempts },
    });
    // TODO(raft:slice-E) — schedule TeardownRunner with reason='failed' for compensation.
  }
}

const _coded = CodedError;
void _coded;
