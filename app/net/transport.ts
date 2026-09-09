import { RECONNECT_GRACE_MS, parseServerMessage } from "./protocol.ts";
import type { ClientMessage, ServerMessage } from "./protocol.ts";

export type TransportStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  /** Given up: retrying further cannot help, and the caller should say so. */
  | "failed";
export type SocketFactory = (url: string) => WebSocket;

/**
 * Consecutive failed attempts before we give up, kept deliberately different
 * for the two cases they describe.
 *
 * Never having connected at all means the URL is wrong, the relay is down, or
 * the build shipped without VITE_RELAY_BASE. Retrying that once a second
 * forever tells the player nothing and drains their phone, so give up quickly
 * and let the UI say what happened.
 *
 * Having connected and then dropped is an ordinary blip and deserves patience
 * -- but only up to the relay's own reconnect grace window, since past that
 * the room is reaped and no reconnect can succeed anyway.
 */
export const MAX_INITIAL_ATTEMPTS = 5;
export const MAX_RECONNECT_ATTEMPTS = Math.ceil(RECONNECT_GRACE_MS / 1_000);

/**
 * Cap on messages buffered while the socket is down. Syncs are only useful
 * fresh, and once the transport has given up nothing will ever drain them.
 */
const OUTBOX_LIMIT = 64;

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
  private everOpened = false;
  private failedAttempts = 0;
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
      this.everOpened = true;
      this.failedAttempts = 0;
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
    this.failedAttempts += 1;
    const limit = this.everOpened ? MAX_RECONNECT_ATTEMPTS : MAX_INITIAL_ATTEMPTS;
    if (this.failedAttempts >= limit) {
      // Stop opening sockets entirely. handleDrop cannot fire again because
      // nothing further is opened, so no extra flag is needed to hold this.
      this.setStatus("failed");
      return;
    }
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
    else if (this.outbox.length < OUTBOX_LIMIT) this.outbox.push(raw);
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
