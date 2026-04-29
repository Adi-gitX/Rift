/**
 * LogTail DO — fan-out for live log streaming via hibernatable WebSockets.
 * Slice F implements the WS subscriber + raft-tail-events queue consumer.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.ts';

export class LogTail extends DurableObject<Env> {
  // STUB(raft:slice-F)
}
