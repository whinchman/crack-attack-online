import { useCallback, useEffect, useRef, useState } from "react";
import { MatchController } from "./match.ts";
import { Transport } from "./transport.ts";
import type { TransportStatus } from "./transport.ts";
import type { CrackAttackEngine } from "../game/engine.ts";

const ROOM_PATTERN = /^[A-Z2-9]{6}$/;

/** Extract a validated room code from a URL fragment, or null for solo play. */
export function roomCodeFromLocation(href: string): string | null {
  const hash = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
  const match = /(?:^|&)room=([^&]*)/.exec(hash);
  if (!match) return null;
  const code = match[1];
  return ROOM_PATTERN.test(code) ? code : null;
}

/** Build the link to send a friend, replacing any fragment already present. */
export function challengeUrl(href: string, room: string): string {
  const base = href.includes("#") ? href.slice(0, href.indexOf("#")) : href;
  return `${base}#room=${room}`;
}

export type MatchPhase = "solo" | "waiting" | "playing" | "peer-gone" | "over";

export type MatchOutcome = "forfeit" | "ended" | null;

export interface MatchState {
  phase: MatchPhase;
  status: TransportStatus | null;
  room: string | null;
  link: string | null;
  /**
   * Why the match ended. The engine has no winner concept — `forfeitWin()`
   * only stops the simulation — so the outcome narrative lives here.
   */
  outcome: MatchOutcome;
}

export function useMatch(engine: CrackAttackEngine, relayBase: string) {
  const [state, setState] = useState<MatchState>({
    phase: "solo", status: null, room: null, link: null, outcome: null,
  });
  const controllerRef = useRef<MatchController | null>(null);

  useEffect(() => {
    const room = roomCodeFromLocation(window.location.href);
    if (!room) return;

    const transport = new Transport(`${relayBase}/room/${room}`);
    const controller = new MatchController(engine, transport);
    controllerRef.current = controller;

    setState({
      phase: "waiting",
      status: "connecting",
      room,
      link: challengeUrl(window.location.href, room),
      outcome: null,
    });

    transport.onStatus((status) => setState((s) => ({ ...s, status })));
    transport.onMessage((message) => {
      switch (message.t) {
        case "start":
          controller.begin({ seed: message.seed, role: message.role }, performance.now());
          setState((s) => ({ ...s, phase: "playing" }));
          break;
        case "sync":
          controller.onSync(message);
          break;
        case "peer-left":
          setState((s) => ({ ...s, phase: "peer-gone" }));
          break;
        case "peer-back":
          setState((s) => ({ ...s, phase: "playing" }));
          break;
        case "forfeit":
          engine.forfeitWin(performance.now());
          setState((s) => ({ ...s, phase: "over", outcome: "forfeit" }));
          break;
        case "error":
          setState((s) => ({ ...s, phase: "over", outcome: "ended" }));
          break;
      }
    });

    return () => { transport.close(); controllerRef.current = null; };
  }, [engine, relayBase]);

  const clampNow = useCallback((now: number) => {
    return controllerRef.current ? controllerRef.current.tickTo(now) : now;
  }, []);

  return { ...state, clampNow };
}
