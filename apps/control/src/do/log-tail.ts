/**
 * LogTail DO — per-PR live-log fan-out (PRD §7.3 + amendment A5).
 *
 *  - Accepts hibernatable WebSocket subscribers via state.acceptWebSocket().
 *  - Maintains a small in-storage ring buffer so late joiners get catch-up.
 *  - `append(event)` is invoked by raft-control's TAIL_EVENTS queue handler.
 *
 * Exposed routes:
 *   GET /ws         → 101 upgrade, subscriber receives ring buffer + live tail
 *   POST /broadcast → append event (used by tail-events queue handler when
 *                     a service binding to the DO method isn't convenient)
 *   GET /tail       → JSON dump of current ring buffer (debugging)
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.ts';

export interface LogEvent {
  ts: number;
  scriptName?: string;
  level?: 'info' | 'warn' | 'error';
  msg?: string;
  meta?: Record<string, unknown>;
}

const BUFFER_KEY = 'buf';
const BUFFER_MAX = 500;

export class LogTail extends DurableObject<Env> {
  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws' && req.headers.get('upgrade') === 'websocket') {
      return this.handleWsUpgrade();
    }
    if (url.pathname === '/broadcast' && req.method === 'POST') {
      const body = (await req.json()) as LogEvent;
      await this.append(body);
      return new Response('ok');
    }
    if (url.pathname === '/tail') {
      const buf = await this.readBuffer();
      return Response.json(buf);
    }
    return new Response('not found', { status: 404 });
  }

  async append(event: LogEvent): Promise<void> {
    const buf = await this.readBuffer();
    buf.push(event);
    while (buf.length > BUFFER_MAX) buf.shift();
    await this.ctx.storage.put(BUFFER_KEY, buf);
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Client disconnected — runtime cleans up via webSocketClose hook.
      }
    }
  }

  override async webSocketMessage(_ws: WebSocket, _msg: string | ArrayBuffer): Promise<void> {
    // No client-to-server traffic in v1.
  }

  override async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    try {
      ws.close();
    } catch {
      // Already closed.
    }
  }

  private async handleWsUpgrade(): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const buf = await this.readBuffer();
    for (const event of buf) {
      try {
        server.send(JSON.stringify(event));
      } catch {
        break;
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private async readBuffer(): Promise<LogEvent[]> {
    return (await this.ctx.storage.get<LogEvent[]>(BUFFER_KEY)) ?? [];
  }
}
