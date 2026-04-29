/**
 * raft-tail Worker (PRD amendment A5).
 *
 * Tail consumer for every per-PR user worker. The control worker registers
 * raft-tail as a `tail_consumers` entry in the script-upload metadata; when
 * the user worker emits trace events, the runtime invokes `tail()` here.
 *
 * We forward each batch (script_name + raw events) to raft-tail-events;
 * the control worker fans them out to LogTail DOs for dashboard streaming.
 */
interface TailEnv {
  readonly TAIL_EVENTS: Queue<{ scriptName: string; events: TraceItem[] }>;
}

const handler: ExportedHandler<TailEnv> = {
  async tail(events, env, _ctx) {
    if (events.length === 0) return;
    // The runtime delivers all events from a single script per invocation,
    // so events[0].scriptName is representative.
    const scriptName = events[0]?.scriptName ?? 'unknown';
    await env.TAIL_EVENTS.send({ scriptName, events });
  },
};

// eslint-disable-next-line import-x/no-default-export -- Workers entrypoint.
export default handler;
