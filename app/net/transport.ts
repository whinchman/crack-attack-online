import { parseServerMessage } from "./protocol.ts";
import type { ClientMessage, ServerMessage } from "./protocol.ts";

export type TransportStatus = "connecting" | "open" | "reconnecting" | "closed";
export type SocketFactory = (url: string) => WebSocket;

/**
 * A WebSocket that reconnects on unexpected close and buffers sends made
 * while it is down. Knows nothing about the game.
 *
 * `reconnectDelayMs` is injected rather than hardcoded so tests can drive
 * reconnection synchronously with a delay of 0.
 *
 * Handlers registered via `onStatus()` receive the current status immediately
 * at registration time. This allows consumers to learn the transport's state
 * without a race.
 */
export class Transport {
  private socket: WebSocket | null = null;
  private status: TransportStatus = "connecting";
  private outbox: string[] = [];
  private messageHandlers: Array<(m: ServerMessage) => void> = [];
  private statusHandlers: Array<(s: TransportStatus) => void> = [];
  private deliberateClose = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private socketGeneration = 0;
  private url: string;
  private factory: SocketFactory;
  private reconnectDelayMs: number;

  constructor(
    url: string,
    factory?: SocketFactory,
    reconnectDelayMs?: number,
  ) {
    this.url = url;
    this.factory = factory || ((u) => new WebSocket(u));
    this.reconnectDelayMs = reconnectDelayMs !== undefined ? reconnectDelayMs : 1_000;
    this.open();
  }

  private setStatus(next: TransportStatus): void {
    this.status = next;
    for (const handler of this.statusHandlers) handler(next);
  }

  private open(): void {
    this.setStatus(this.socket ? "reconnecting" : "connecting");
    const socket = this.factory(this.url);
    this.socket = socket;
    const generation = ++this.socketGeneration;

    socket.onopen = () => {
      if (this.socketGeneration !== generation) return;
      this.setStatus("open");
      for (const queued of this.outbox.splice(0)) socket.send(queued);
    };
    socket.onmessage = (event: MessageEvent) => {
      if (this.socketGeneration !== generation) return;
      const raw = typeof event.data === "string" ? event.data : "";
      const message = parseServerMessage(raw);
      if (!message) return;
      for (const handler of this.messageHandlers) handler(message);
    };
    socket.onclose = () => {
      if (this.socketGeneration !== generation) return;
      this.handleDrop();
    };
    socket.onerror = () => {
      if (this.socketGeneration !== generation) return;
      this.handleDrop();
    };
  }

  private handleDrop(): void {
    if (this.deliberateClose) return;
    if (this.retryTimer !== null) return;
    this.setStatus("reconnecting");
    if (this.reconnectDelayMs === 0) {
      this.open();
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, this.reconnectDelayMs);
  }

  send(message: ClientMessage): void {
    const raw = JSON.stringify(message);
    if (this.socket && this.status === "open") this.socket.send(raw);
    else this.outbox.push(raw);
  }

  onMessage(handler: (m: ServerMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onStatus(handler: (s: TransportStatus) => void): void {
    this.statusHandlers.push(handler);
    handler(this.status);
  }

  close(): void {
    this.deliberateClose = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.socket?.close();
    this.setStatus("closed");
  }
}
