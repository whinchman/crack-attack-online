import { RoomLogic, type Role } from "./room-logic.ts";
import { RECONNECT_GRACE_MS, parseServerMessage } from "../../app/net/protocol.ts";

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

    if (this.logic.expiredAt(Date.now())) {
      server.accept();
      server.send(JSON.stringify({ t: "error", reason: "missing" }));
      server.close(1008, "room expired");
      return new Response(null, { status: 101, webSocket: client });
    }

    const id = crypto.randomUUID();

    const role = this.logic.addPeer(id);
    if (role === "full") {
      server.accept();
      server.send(JSON.stringify({ t: "error", reason: "full" }));
      server.close(1008, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }

    server.accept();
    this.sockets.set(id, server);
    this.roles.set(id, role);

    server.addEventListener("message", (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : "";
      // Validate before forwarding so a malformed peer cannot poison the other.
      if (!parseServerMessage(raw)) return;
      for (const [otherId, socket] of this.sockets) {
        if (otherId !== id) socket.send(raw);
      }
    });

    const onGone = () => {
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
    };
    server.addEventListener("close", onGone);
    server.addEventListener("error", onGone);

    if (this.logic.paired) {
      if (this.rejoin) {
        // Someone came back inside the grace window.
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

    return new Response(null, { status: 101, webSocket: client });
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
