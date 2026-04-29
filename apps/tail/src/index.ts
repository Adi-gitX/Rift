/**
 * raft-tail Worker (PRD amendment A5).
 *
 * Tail consumer bound to every WfP user-Worker. On each batch of trace events,
 * forwards them to the raft-tail-events queue, which the LogTail DO drains
 * to fan out over hibernatable WebSockets to dashboard subscribers.
 *
 * Filled in alongside T11.3.
 */
// Filled in alongside the LogTail DO (Slice F):
//   readonly TAIL_EVENTS: Queue<TailEvent>;
type TailEnv = Record<string, never>;

const handler: ExportedHandler<TailEnv> = {
  async tail(_events, _env, _ctx) {
    // T11.3
  },
};

// eslint-disable-next-line import-x/no-default-export -- Workers entrypoint.
export default handler;
