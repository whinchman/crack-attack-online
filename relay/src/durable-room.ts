import { RoomLogic, type Role } from "./room-logic.ts";
import { RECONNECT_GRACE_MS, parseClientMessage } from "../../app/net/protocol.ts";

interface Env {
  ROOM: DurableObjectNamespace;
}

export class Room {
  private logic = new RoomLogic(crypto.getRandomValues(new Uint32Array(1))[0]);
  private sockets = new Map<string, WebSocket>();
  private roles = new Map<string, Role>();
  /** False until the first pairing has sent "start"; true for later rejoins. */
  private rejoin = false;
  private state: DurableObjectState;
  private env: Env;

  // Plain fields assigned in the constructor body, not TS parameter-property
  // shorthand: node --experimental-strip-types only erases types, it doesn't
  // transform parameter properties, so `constructor(private state: ...)`
  // fails to load at runtime under the exact command this project's test
  // scripts use.
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (this.logic.expiredAt(Date.now())) {
      this.reject(server, "missing");
      return new Response(null, { status: 101, webSocket: client });
    }

    // No slot is claimed until the client's `hello` arrives. Only the client
    // can tell a socket-level reconnect (same live page, controller and board
    // intact) from a fresh page load, and that distinction decides whether the
    // room can take this connection at all -- so the decision has to wait for
    // it rather than being made here at connect time.
    let id: string | null = null;

    server.addEventListener("message", (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : "";
      // Validate before acting or forwarding, so a malformed peer can neither
      // poison the other nor claim a slot.
      const message = parseClientMessage(raw);
      if (!message) return;

      if (id === null) {
        // Nothing but the handshake counts before the handshake.
        if (message.t === "hello") id = this.admit(server, message.resume);
        return;
      }
      // `hello` is consumed here and never forwarded; it is not part of the
      // peer-to-peer protocol and the other side would reject it anyway.
      if (message.t !== "sync") return;
      const self = id;
      for (const [otherId, socket] of this.sockets) {
        if (otherId !== self) socket.send(raw);
      }
    });

    const onGone = () => {
      // A socket that never completed its handshake holds nothing to release.
      if (id === null) return;
      this.depart(id);
      id = null;
    };
    server.addEventListener("close", onGone);
    server.addEventListener("error", onGone);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Take a handshaken socket into the room, or turn it away. Returns the peer
   * id on success and null when the socket has been rejected and closed.
   */
  private admit(server: WebSocket, resume: boolean): string | null {
    // Checked before the resume gate below, so a third friend tapping the link
    // during a live match is told the game already has two players rather than
    // that their link has expired.
    if (this.logic.paired) {
      this.reject(server, "full");
      return null;
    }

    // A fresh page cannot resume a match in progress. Peers exchange garbage,
    // a level-light summary and a tick counter -- never board state -- so
    // there is nothing to hand a page that has only just loaded. Turning it
    // away and LEAVING THE ALARM ARMED makes that outcome defined: the player
    // still here wins cleanly by forfeit when the grace window elapses.
    // Accepting it dead-ended both of them instead -- the returner never got
    // "start" and waited forever, while deleteAlarm() on the survivor's side
    // cancelled the forfeit that was their only way out.
    if (!resume && this.logic.wasPaired) {
      this.reject(server, "missing");
      return null;
    }

    const id = crypto.randomUUID();
    const role = this.logic.addPeer(id);
    if (role === "full") {
      this.reject(server, "full");
      return null;
    }

    this.sockets.set(id, server);
    this.roles.set(id, role);

    if (this.logic.paired) {
      if (this.rejoin) {
        // Someone came back inside the grace window, from the same live page.
        void this.state.storage.deleteAlarm();
        for (const [otherId, socket] of this.sockets) {
          if (otherId !== id) socket.send(JSON.stringify({ t: "peer-back" }));
        }
      } else {
        for (const [otherId, socket] of this.sockets) {
          socket.send(JSON.stringify({
            t: "start",
            seed: this.logic.seed,
            role: this.roles.get(otherId),
          }));
        }
        this.rejoin = true;
      }
    }

    return id;
  }

  /** Release a peer's slot and start the grace window if a match was running. */
  private depart(id: string): void {
    this.sockets.delete(id);
    this.roles.delete(id);
    this.logic.removePeer(id, Date.now());
    for (const socket of this.sockets.values()) {
      socket.send(JSON.stringify({ t: "peer-left" }));
    }
    // A match that has actually started gets a grace window, even if both
    // peers happen to drop together; an unclaimed challenge link dies with
    // its host, with no grace.
    if (this.logic.wasPaired) {
      void this.state.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS);
    }
  }

  private reject(server: WebSocket, reason: "missing" | "full"): void {
    server.send(JSON.stringify({ t: "error", reason }));
    server.close(1008, reason === "full" ? "room full" : "room expired");
  }

  /** The grace window expired: whoever is still here wins by forfeit. */
  async alarm(): Promise<void> {
    for (const socket of this.sockets.values()) {
      socket.send(JSON.stringify({ t: "forfeit" }));
      socket.close(1000, "opponent forfeited");
    }
    this.sockets.clear();
  }
}
