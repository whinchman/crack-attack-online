"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { gameAssetUrl } from "./assetUrl";
import {
  CrackAttackEngine,
  GAME_OVER_RESTART_DELAY_MS,
  type GameEvent,
  type GameSnapshot,
} from "./engine";
import {
  TOUCH_CAPABILITY_QUERY,
  gameKeyboardAction,
  gameOverRestartPrompt,
  hasTouchControls,
} from "./inputPolicy";
import {
  DEFAULT_SCORE_TO_BEAT,
  loadScoreToBeat,
  recordScoreToBeat,
} from "./highScore";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  CELL_SIZE,
  canvasPointToBoard,
  drawGame,
  loadBlockMesh,
  prepareSparkleTextures,
  type RenderAssets,
} from "./renderer";
import {
  consumeThumbpadMotion,
  horizontalSwipePair,
} from "./touchControls";
import { challengeUrl, roomCodeFromLocation, useMatch } from "../net/useMatch.ts";

const ASSET_LOAD_TIMEOUT_MS = 8000;
const RELAY_BASE = import.meta.env.VITE_RELAY_BASE ?? "wss://crack-attack-relay.workers.dev";
const THUMBPAD_STEP_PX = 24;
const THUMBPAD_PUCK_RANGE_PX = 17;
const BOARD_SWIPE_THRESHOLD = CELL_SIZE * 0.42;

const IMAGE_SOURCES = {
  logo: gameAssetUrl("logo.png"),
  garbage: Array.from(
    { length: 6 },
    (_, index) => gameAssetUrl(
      `garbage_flavor_${index.toString().padStart(3, "0")}.png`,
    ),
  ),
  font: gameAssetUrl("font0_score.png"),
  fontUi: gameAssetUrl("font0_ui.png"),
  messageAnyKey: gameAssetUrl("message_anykey.png"),
  messageTapScreen: gameAssetUrl("message_tap_screen.png"),
  messagePaused: gameAssetUrl("message_paused.png"),
  messageGameOver: gameAssetUrl("message_game_over.png"),
  countdown: {
    "1": gameAssetUrl("count_down_1.png"),
    "2": gameAssetUrl("count_down_2.png"),
    "3": gameAssetUrl("count_down_3.png"),
    "GO!": gameAssetUrl("count_down_go.png"),
  },
  bonusSign: gameAssetUrl("sign_bonus.png"),
  magnitudeSigns: Array.from(
    { length: 9 },
    (_, index) => gameAssetUrl(`sign_${index + 4}.png`),
  ),
  multiplierSigns: Array.from(
    { length: 11 },
    (_, index) => gameAssetUrl(`sign_x${index + 2}.png`),
  ),
} as const;

interface AudioRig {
  context: AudioContext;
  enabled: boolean;
}

interface CanvasGesture {
  pointerId: number;
  pointerType: string;
  startCanvasX: number;
  startCanvasY: number;
  startColumn: number;
  startRow: number;
}

type PadDirection = "up" | "right" | "down" | "left";

interface ThumbpadGesture {
  pointerId: number;
  pointerType: string;
  tapDx: number;
  tapDy: number;
  tapDirection: PadDirection | null;
  lastClientX: number;
  lastClientY: number;
  accumulatedX: number;
  accumulatedY: number;
  movedCursor: boolean;
}

interface ThumbpadVisual {
  active: boolean;
  pressedDirection: PadDirection | null;
  x: number;
  y: number;
}

const IDLE_THUMBPAD_VISUAL: ThumbpadVisual = {
  active: false,
  pressedDirection: null,
  x: 0,
  y: 0,
};

function padDirection(value: string | undefined): PadDirection | null {
  if (value === "up" || value === "right" || value === "down" || value === "left") {
    return value;
  }
  return null;
}

function tactileTick(duration = 7): void {
  try {
    navigator.vibrate?.(duration);
  } catch {
    // Haptics are optional and may be denied by browser or device policy.
  }
}

function pointerCanvasCoordinates(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * CANVAS_WIDTH,
    y: ((clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
  };
}

function tone(
  rig: AudioRig,
  frequency: number,
  duration: number,
  volume = 0.035,
  offset = 0,
  type: OscillatorType = "sine",
): void {
  if (!rig.enabled || rig.context.state === "closed") return;
  const start = rig.context.currentTime + offset;
  const oscillator = rig.context.createOscillator();
  const gain = rig.context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(rig.context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playEvent(rig: AudioRig | null, event: GameEvent): void {
  if (!rig?.enabled) return;
  if (event.type === "swap") {
    tone(rig, 240, 0.07, 0.02, 0, "square");
    tone(rig, 310, 0.06, 0.018, 0.045, "square");
  } else if (event.type === "block-land") {
    // The desktop plays one quiet landing sample per block. Closely spaced
    // oscillator voices preserve the weight without clipping a large stack.
    const voices = Math.min(6, event.count);
    for (let index = 0; index < voices; index += 1) {
      tone(rig, 155 + index * 7, 0.055, 0.008, index * 0.006, "triangle");
    }
  } else if (event.type === "clear") {
    const root = event.gray ? 290 : 420;
    const notes = Math.min(6, Math.max(3, event.magnitude));
    for (let index = 0; index < notes; index += 1) {
      tone(rig, root + index * 70, 0.13, 0.026, index * 0.045, "triangle");
    }
  } else if (event.type === "chain") {
    tone(rig, 520 + event.depth * 80, 0.22, 0.04, 0, "sine");
    tone(rig, 780 + event.depth * 100, 0.24, 0.03, 0.09, "triangle");
  } else if (event.type === "garbage-impact") {
    // Sound::play scales the original landing sample by garbage area, capped
    // at ten cells. Keep that relative volume and trigger it on impact—not
    // when the garbage merely enters above the board.
    const impactVolume = Math.min(1, event.area / 10);
    tone(rig, 105, 0.35, 0.055 * impactVolume, 0, "sawtooth");
    tone(rig, 72, 0.42, 0.04 * impactVolume, 0.09, "square");
  } else if (event.type === "awaken") {
    tone(rig, 420 + event.flavor * 58, 0.1, 0.024, 0, "triangle");
    tone(rig, 650 + event.flavor * 52, 0.08, 0.016, 0.035, "sine");
  } else if (event.type === "danger") {
    tone(rig, 165, 0.2, 0.04, 0, "square");
    tone(rig, 165, 0.2, 0.04, 0.28, "square");
  } else if (event.type === "rise") {
    tone(rig, 150, 0.08, 0.016, 0, "triangle");
  } else if (event.type === "countdown-cue") {
    // Sound::play uses volumes 10, 7, 4, and 1 for 3, 2, 1, and GO.
    tone(rig, 540, 0.09, 0.004 * (1 + event.remaining * 3), 0, "square");
  } else if (event.type === "start") {
    tone(rig, 440, 0.12, 0.035, 0, "triangle");
    tone(rig, 660, 0.18, 0.035, 0.11, "triangle");
  } else if (event.type === "gameover") {
    [330, 247, 196, 147].forEach((frequency, index) => {
      tone(rig, frequency, 0.25, 0.035, index * 0.15, "sawtooth");
    });
  }
}

function settleWithin<T>(promise: Promise<T>, timeoutMs = ASSET_LOAD_TIMEOUT_MS): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve(value);
    };
    const timeout = window.setTimeout(() => finish(null), timeoutMs);
    void promise.then((value) => finish(value), () => finish(null));
  });
}

function loadImage(source: string): Promise<HTMLImageElement | null> {
  const loading = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.addEventListener("load", () => {
      void image.decode()
        .catch(() => undefined)
        .then(() => {
          if (image.naturalWidth > 0) resolve(image);
          else reject(new Error(`Image decoded without dimensions: ${source}`));
        });
    }, { once: true });
    image.addEventListener("error", () => reject(new Error(`Unable to load image: ${source}`)), {
      once: true,
    });
    image.src = source;
  });
  return settleWithin(loading);
}

function waitForFonts(): Promise<void> {
  return document.fonts.ready.then(() => undefined, () => undefined);
}

function browserScoreStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Some privacy modes deny even reading the localStorage property. A run
    // should still start and remain fully playable without persistence.
    return null;
  }
}

function paintCanvas(
  canvas: HTMLCanvasElement | null,
  snapshot: GameSnapshot,
  assets: RenderAssets,
  highScore: number,
  useTouchPrompt: boolean,
): void {
  if (!canvas) return;
  const density = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(CANVAS_WIDTH * density);
  const pixelHeight = Math.round(CANVAS_HEIGHT * density);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(density, 0, 0, density, 0, 0);
  drawGame(context, snapshot, assets, highScore, useTouchPrompt);
}

function statusCopy(
  snapshot: GameSnapshot,
  isNewBest: boolean,
  restartReady: boolean,
): string {
  if (snapshot.status === "ready") return "Ready for a new solo run";
  if (snapshot.status === "countdown") return `Starting in ${snapshot.countdown ?? "a moment"}`;
  if (snapshot.status === "paused") return "Game paused";
  if (snapshot.status === "gameover") {
    return `${isNewBest ? "New best score. " : ""}Game over. Score ${snapshot.score}. ${
      restartReady ? "Restart available" : "Restart unlocks shortly"
    }`;
  }
  if (snapshot.dangerActive) return "Danger: clear the top row before time runs out";
  if (snapshot.awakeningCount > 0) return `${snapshot.awakeningCount} garbage blocks are revealing their colors`;
  if (snapshot.incomingCount > 0) return `${snapshot.incomingCount} garbage attack${snapshot.incomingCount === 1 ? "" : "s"} incoming`;
  return `Score ${snapshot.displayScore}`;
}

export default function CrackAttackGame() {
  const roomCode = roomCodeFromLocation(window.location.href);
  const [engine] = useState(() => new CrackAttackEngine({ multiplayer: roomCode !== null }));
  const match = useMatch(engine, RELAY_BASE);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const assetsRef = useRef<RenderAssets>({
    logo: null,
    garbage: [],
    font: null,
    fontUi: null,
    messageAnyKey: null,
    messageTapScreen: null,
    messagePaused: null,
    messageGameOver: null,
    countdown: { "1": null, "2": null, "3": null, "GO!": null },
    bonusSign: null,
    magnitudeSigns: [],
    multiplierSigns: [],
    blockMesh: null,
  });
  const audioRef = useRef<AudioRig | null>(null);
  const assetsReadyRef = useRef(false);
  const useTouchPromptRef = useRef(false);
  const lastUiUpdateRef = useRef(0);
  const lastTapRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const canvasGestureRef = useRef<CanvasGesture | null>(null);
  const thumbpadGestureRef = useRef<ThumbpadGesture | null>(null);
  const suppressThumbpadClickRef = useRef(false);
  const swapPointerRef = useRef<number | null>(null);
  const raisePointerRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<GameSnapshot>(() => engine.getSnapshot(0));
  const lastPublishedRef = useRef({
    status: snapshot.status,
    score: snapshot.score,
    displayScore: snapshot.displayScore,
  });
  const [highScore, setHighScore] = useState(() => (
    typeof window === "undefined"
      ? DEFAULT_SCORE_TO_BEAT
      : loadScoreToBeat(browserScoreStorage())
  ));
  const highScoreRef = useRef(highScore);
  const [isNewBest, setIsNewBest] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [visualReady, setVisualReady] = useState(false);
  const [touchControlsAvailable, setTouchControlsAvailable] = useState(false);
  const [thumbpadVisual, setThumbpadVisual] = useState<ThumbpadVisual>(IDLE_THUMBPAD_VISUAL);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const AudioConstructor = window.AudioContext
        ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioConstructor) {
        try {
          audioRef.current = {
            context: new AudioConstructor(),
            enabled: soundEnabled,
          };
        } catch {
          // Audio is optional; browser/device audio limits must not block play.
          audioRef.current = null;
        }
      }
    }
    if (audioRef.current) {
      audioRef.current.enabled = soundEnabled;
      void audioRef.current.context.resume().catch(() => undefined);
    }
  }, [soundEnabled]);

  useEffect(() => {
    const touchCapabilityMedia = window.matchMedia(TOUCH_CAPABILITY_QUERY);
    const syncReadyPrompt = () => {
      const available = hasTouchControls(
        touchCapabilityMedia.matches,
        navigator.maxTouchPoints ?? 0,
      );
      useTouchPromptRef.current = available;
      setTouchControlsAvailable(available);
    };
    syncReadyPrompt();
    touchCapabilityMedia.addEventListener("change", syncReadyPrompt);
    let active = true;
    let revealFrame = 0;
    void Promise.all([
      loadImage(IMAGE_SOURCES.logo),
      Promise.all(IMAGE_SOURCES.garbage.map((source) => loadImage(source))),
      loadImage(IMAGE_SOURCES.font),
      loadImage(IMAGE_SOURCES.fontUi),
      loadImage(IMAGE_SOURCES.messageAnyKey),
      loadImage(IMAGE_SOURCES.messageTapScreen),
      loadImage(IMAGE_SOURCES.messagePaused),
      loadImage(IMAGE_SOURCES.messageGameOver),
      loadImage(IMAGE_SOURCES.countdown["1"]),
      loadImage(IMAGE_SOURCES.countdown["2"]),
      loadImage(IMAGE_SOURCES.countdown["3"]),
      loadImage(IMAGE_SOURCES.countdown["GO!"]),
      loadImage(IMAGE_SOURCES.bonusSign),
      Promise.all(IMAGE_SOURCES.magnitudeSigns.map((source) => loadImage(source))),
      Promise.all(IMAGE_SOURCES.multiplierSigns.map((source) => loadImage(source))),
      settleWithin(loadBlockMesh(gameAssetUrl("block.obj"))),
      waitForFonts(),
    ]).then(([
      logo,
      garbage,
      font,
      fontUi,
      messageAnyKey,
      messageTapScreen,
      messagePaused,
      messageGameOver,
      countdownOne,
      countdownTwo,
      countdownThree,
      countdownGo,
      bonusSign,
      magnitudeSigns,
      multiplierSigns,
      blockMesh,
    ]) => {
      if (!active) return;
      const assets: RenderAssets = {
        logo,
        garbage,
        font,
        fontUi,
        messageAnyKey,
        messageTapScreen,
        messagePaused,
        messageGameOver,
        countdown: {
          "1": countdownOne,
          "2": countdownTwo,
          "3": countdownThree,
          "GO!": countdownGo,
        },
        bonusSign,
        magnitudeSigns,
        multiplierSigns,
        blockMesh,
      };
      assetsRef.current = assets;
      assetsReadyRef.current = true;
      prepareSparkleTextures();

      // Paint one fully resolved frame before making the game visible. This
      // prevents the Canvas fallbacks from ever reaching the screen while the
      // original logo, bitmap type, and block mesh are still loading.
      const now = performance.now();
      paintCanvas(
        canvasRef.current,
        engine.getSnapshot(now),
        assets,
        highScoreRef.current,
        useTouchPromptRef.current,
      );
      revealFrame = window.requestAnimationFrame(() => {
        if (active) setVisualReady(true);
      });
    });
    return () => {
      active = false;
      touchCapabilityMedia.removeEventListener("change", syncReadyPrompt);
      window.cancelAnimationFrame(revealFrame);
    };
  }, [engine]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.enabled = soundEnabled;
  }, [soundEnabled]);

  useEffect(() => {
    let animationFrame = 0;
    const render = (now: number) => {
      engine.update(match.clampNow(now));
      const current = engine.getSnapshot(now);
      for (const event of engine.drainEvents()) playEvent(audioRef.current, event);

      if (current.status === "gameover" && current.score > highScoreRef.current) {
        const nextScoreToBeat = recordScoreToBeat(
          browserScoreStorage(),
          highScoreRef.current,
          current.score,
        );
        if (nextScoreToBeat > highScoreRef.current) {
          highScoreRef.current = nextScoreToBeat;
          setHighScore(nextScoreToBeat);
          setIsNewBest(true);
        }
      }

      const canvas = canvasRef.current;
      if (assetsReadyRef.current) {
        paintCanvas(
          canvas,
          current,
          assetsRef.current,
          highScoreRef.current,
          useTouchPromptRef.current,
        );
      }

      const lastPublished = lastPublishedRef.current;
      if (now - lastUiUpdateRef.current > 100
        || current.status !== lastPublished.status
        || current.score !== lastPublished.score
        || current.displayScore !== lastPublished.displayScore) {
        lastUiUpdateRef.current = now;
        lastPublishedRef.current = {
          status: current.status,
          score: current.score,
          displayScore: current.displayScore,
        };
        setSnapshot(current);
      }
      animationFrame = window.requestAnimationFrame(render);
    };
    animationFrame = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [engine]);

  const startRun = useCallback(() => {
    ensureAudio();
    const now = performance.now();
    const started = engine.start(now, Date.now());
    if (started) setIsNewBest(false);
    canvasRef.current?.focus();
    setSnapshot(engine.getSnapshot(now));
  }, [engine, ensureAudio]);

  const pauseRun = useCallback(() => {
    const now = performance.now();
    engine.togglePause(now);
    setSnapshot(engine.getSnapshot(now));
    canvasRef.current?.focus();
  }, [engine]);

  const createChallenge = useCallback(async () => {
    setChallengeError(null);
    try {
      const relayHttpBase = RELAY_BASE.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
      const response = await fetch(`${relayHttpBase}/new`);
      if (!response.ok) throw new Error(`relay responded with ${response.status}`);
      const { room } = (await response.json()) as { room: string };
      window.location.href = challengeUrl(window.location.href, room);
      // Assigning a fragment-only href does not by itself trigger a
      // navigation/reload, so the explicit reload() below is required to
      // actually leave solo mode and construct the engine as multiplayer.
      window.location.reload();
    } catch {
      setChallengeError("Couldn't reach the server — try again");
    }
  }, []);

  const copyChallengeLink = useCallback(() => {
    if (!match.link) return;
    navigator.clipboard?.writeText(match.link).then(
      () => {
        setLinkCopied(true);
        window.setTimeout(() => setLinkCopied(false), 2000);
      },
      () => {},
    );
  }, [match.link]);

  const playAgain = useCallback(() => {
    const href = window.location.href;
    const base = href.includes("#") ? href.slice(0, href.indexOf("#")) : href;
    window.location.href = base;
    // As above: the fragment-stripping assignment alone doesn't reload, so
    // the explicit reload() is required to drop back into solo mode.
    window.location.reload();
  }, []);

  const attemptSwap = useCallback((withTactileFeedback = false) => {
    ensureAudio();
    const swapped = engine.swap(performance.now());
    if (swapped && withTactileFeedback) tactileTick(11);
    canvasRef.current?.focus();
    return swapped;
  }, [engine, ensureAudio]);

  const swap = useCallback(() => {
    attemptSwap();
  }, [attemptSwap]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!assetsReadyRef.current) return;
      const now = performance.now();
      const target = event.target;
      if (
        target instanceof Element
        && target.closest("input, textarea, select, button, a, [contenteditable='true']")
      ) return;
      const current = engine.getSnapshot(now);
      const action = gameKeyboardAction({
        status: current.status,
        key: event.key,
        repeat: event.repeat,
        composing: event.isComposing,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        restartReady: current.gameOverElapsedMs >= GAME_OVER_RESTART_DELAY_MS,
      });
      if (!action) {
        const key = event.key.toLowerCase();
        const repeatedMovement = event.repeat
          && (current.status === "playing" || current.status === "countdown")
          && [
            "arrowleft",
            "arrowright",
            "arrowup",
            "arrowdown",
            "a",
            "d",
            "w",
            "s",
          ].includes(key);
        if (repeatedMovement) event.preventDefault();
        return;
      }
      event.preventDefault();

      if (action === "start" || action === "restart") startRun();
      else if (action === "move-left") engine.moveCursor(-1, 0, now);
      else if (action === "move-right") engine.moveCursor(1, 0, now);
      else if (action === "move-up") engine.moveCursor(0, 1, now);
      else if (action === "move-down") engine.moveCursor(0, -1, now);
      else if (action === "swap") swap();
      else if (action === "raise") engine.setRaiseHeld(true);
      else if (action === "pause") pauseRun();
      else if (action === "concede") {
        engine.concede(now);
        setSnapshot(engine.getSnapshot(now));
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === "enter" || key === "l") engine.setRaiseHeld(false);
      if (key === " " || key === "k") engine.releaseCountdownSwap();
    };
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [engine, pauseRun, startRun, swap]);

  useEffect(() => {
    const onVisibility = () => {
      const now = performance.now();
      const status = engine.getSnapshot(now).status;
      if (document.hidden && (status === "playing" || status === "countdown")) {
        engine.togglePause(now);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [engine]);

  useEffect(() => {
    const cancelPointer = (event: PointerEvent) => {
      if (swapPointerRef.current === event.pointerId) {
        swapPointerRef.current = null;
        engine.releaseCountdownSwap();
      }
      if (raisePointerRef.current === event.pointerId) {
        raisePointerRef.current = null;
        engine.setRaiseHeld(false);
      }
      if (thumbpadGestureRef.current?.pointerId === event.pointerId) {
        thumbpadGestureRef.current = null;
        setThumbpadVisual(IDLE_THUMBPAD_VISUAL);
      }
      if (canvasGestureRef.current?.pointerId === event.pointerId) {
        canvasGestureRef.current = null;
      }
    };
    const cancelAllPointers = () => {
      swapPointerRef.current = null;
      raisePointerRef.current = null;
      thumbpadGestureRef.current = null;
      canvasGestureRef.current = null;
      engine.setRaiseHeld(false);
      engine.releaseCountdownSwap();
      setThumbpadVisual(IDLE_THUMBPAD_VISUAL);
    };
    window.addEventListener("pointerup", cancelPointer);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("blur", cancelAllPointers);
    return () => {
      window.removeEventListener("pointerup", cancelPointer);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("blur", cancelAllPointers);
    };
  }, [engine]);

  const handleCanvasPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (canvasGestureRef.current) return;
    ensureAudio();
    const canvasPosition = pointerCanvasCoordinates(
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    const now = performance.now();
    const current = engine.getSnapshot(now);
    const point = canvasPointToBoard(
      canvasPosition.x,
      canvasPosition.y,
      current.rise + current.impactOffsetRows,
    );
    if (!point) return;

    const cursorX = Math.min(4, point.x);
    engine.setCursor(cursorX, point.y, now);
    canvasGestureRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startCanvasX: canvasPosition.x,
      startCanvasY: canvasPosition.y,
      startColumn: point.x,
      startRow: point.y,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a convenience; the gesture can still finish inside the canvas.
    }
    event.currentTarget.focus();
  };

  const handleCanvasPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = canvasGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const canvasPosition = pointerCanvasCoordinates(
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    const pairX = horizontalSwipePair(
      gesture.startColumn,
      canvasPosition.x - gesture.startCanvasX,
      canvasPosition.y - gesture.startCanvasY,
      BOARD_SWIPE_THRESHOLD,
    );
    if (pairX !== null) {
      engine.setCursor(pairX, gesture.startRow, performance.now());
    }
  };

  const handleCanvasPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = canvasGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    canvasGestureRef.current = null;

    const canvasPosition = pointerCanvasCoordinates(
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    const pairX = horizontalSwipePair(
      gesture.startColumn,
      canvasPosition.x - gesture.startCanvasX,
      canvasPosition.y - gesture.startCanvasY,
      BOARD_SWIPE_THRESHOLD,
    );
    const now = performance.now();
    if (pairX !== null) {
      engine.setCursor(pairX, gesture.startRow, now);
      const swapped = engine.swap(now);
      if (swapped && gesture.pointerType !== "mouse") tactileTick(11);
      lastTapRef.current = null;
    } else {
      const cursorX = Math.min(4, gesture.startColumn);
      const previous = lastTapRef.current;
      if (
        previous
        && previous.x === cursorX
        && previous.y === gesture.startRow
        && now - previous.at < 650
      ) {
        engine.setCursor(cursorX, gesture.startRow, now);
        const swapped = engine.swap(now);
        if (swapped && gesture.pointerType !== "mouse") tactileTick(11);
        lastTapRef.current = null;
      } else {
        engine.setCursor(cursorX, gesture.startRow, now);
        lastTapRef.current = { x: cursorX, y: gesture.startRow, at: now };
      }
    }

    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Capture may already have been released by the browser.
    }
    event.currentTarget.focus();
  };

  const handleCanvasPointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (canvasGestureRef.current?.pointerId === event.pointerId) {
      canvasGestureRef.current = null;
    }
  };

  const move = useCallback((dx: number, dy: number) => {
    ensureAudio();
    engine.moveCursor(dx, dy, performance.now());
    canvasRef.current?.focus();
  }, [engine, ensureAudio]);

  const tapMove = useCallback((dx: number, dy: number) => {
    if (suppressThumbpadClickRef.current) return;
    move(dx, dy);
    tactileTick();
  }, [move]);

  const handleThumbpadPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (thumbpadGestureRef.current) return;
    ensureAudio();
    const zone = (event.target as HTMLElement).closest<HTMLElement>("[data-pad-dx]");
    const tapDirection = padDirection(zone?.dataset.padDirection);
    thumbpadGestureRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      tapDx: Number(zone?.dataset.padDx ?? 0),
      tapDy: Number(zone?.dataset.padDy ?? 0),
      tapDirection,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      accumulatedX: 0,
      accumulatedY: 0,
      movedCursor: false,
    };
    setThumbpadVisual({ active: true, pressedDirection: tapDirection, x: 0, y: 0 });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The broad tap zones still work if capture is unavailable.
    }
    event.preventDefault();
  };

  const handleThumbpadPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = thumbpadGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    gesture.accumulatedX += event.clientX - gesture.lastClientX;
    gesture.accumulatedY += event.clientY - gesture.lastClientY;
    gesture.lastClientX = event.clientX;
    gesture.lastClientY = event.clientY;

    const motion = consumeThumbpadMotion(
      gesture.accumulatedX,
      gesture.accumulatedY,
      THUMBPAD_STEP_PX,
    );
    gesture.accumulatedX = motion.remainderX;
    gesture.accumulatedY = motion.remainderY;

    if (motion.steps.length > 0) {
      const now = performance.now();
      for (const step of motion.steps) {
        // Pointer Y increases toward the bottom of the screen, while board Y
        // increases upward.
        engine.moveCursor(step.dx, -step.dy, now);
      }
      gesture.movedCursor = true;
      if (gesture.pointerType !== "mouse") tactileTick();
    }

    setThumbpadVisual({
      active: true,
      pressedDirection: gesture.movedCursor ? null : gesture.tapDirection,
      x: Math.max(
        -THUMBPAD_PUCK_RANGE_PX,
        Math.min(
          THUMBPAD_PUCK_RANGE_PX,
          (gesture.accumulatedX / THUMBPAD_STEP_PX) * THUMBPAD_PUCK_RANGE_PX,
        ),
      ),
      y: Math.max(
        -THUMBPAD_PUCK_RANGE_PX,
        Math.min(
          THUMBPAD_PUCK_RANGE_PX,
          (gesture.accumulatedY / THUMBPAD_STEP_PX) * THUMBPAD_PUCK_RANGE_PX,
        ),
      ),
    });
    event.preventDefault();
  };

  const finishThumbpadGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = thumbpadGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    thumbpadGestureRef.current = null;
    setThumbpadVisual(IDLE_THUMBPAD_VISUAL);
    if (!gesture.movedCursor && (gesture.tapDx !== 0 || gesture.tapDy !== 0)) {
      move(gesture.tapDx, gesture.tapDy);
      if (gesture.pointerType !== "mouse") tactileTick();
    }
    // A browser may dispatch click immediately after pointerup. The pointer
    // gesture already handled both drags and taps, so suppress that duplicate;
    // keyboard-initiated button clicks still go through the normal handler.
    suppressThumbpadClickRef.current = true;
    window.setTimeout(() => {
      suppressThumbpadClickRef.current = false;
    }, 0);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Capture may already have been released by the browser.
    }
    event.preventDefault();
  };

  const cancelThumbpadGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (thumbpadGestureRef.current?.pointerId !== event.pointerId) return;
    thumbpadGestureRef.current = null;
    setThumbpadVisual(IDLE_THUMBPAD_VISUAL);
  };

  const pressRaise = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    ensureAudio();
    raisePointerRef.current = event.pointerId;
    engine.setRaiseHeld(true);
    if (event.pointerType !== "mouse") tactileTick(10);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Holding still works while the pointer remains over the button.
    }
    event.preventDefault();
    canvasRef.current?.focus();
  };

  const releaseRaise = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (raisePointerRef.current !== event.pointerId) return;
    raisePointerRef.current = null;
    engine.setRaiseHeld(false);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Capture may already have been released by the browser.
    }
    event.preventDefault();
  };

  const pressSwap = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (swapPointerRef.current !== null) return;
    swapPointerRef.current = event.pointerId;

    // Handle physical pointers on pointerdown instead of waiting for click.
    // Browsers can defer or suppress a touch-generated click while a different
    // pointer remains captured by the movement pad; pointer events themselves
    // remain independent, so this keeps Swap genuinely multi-touch.
    attemptSwap(event.pointerType !== "mouse");
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Holding still works while the pointer remains over the button.
    }
    event.preventDefault();
  };

  const releaseSwap = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (swapPointerRef.current !== event.pointerId) return;
    swapPointerRef.current = null;
    engine.releaseCountdownSwap();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Capture may already have been released by the browser.
    }
    event.preventDefault();
  };

  const clickSwap = (event: React.MouseEvent<HTMLButtonElement>) => {
    // Pointer activation was already handled above. A detail of zero denotes
    // keyboard or assistive-technology activation, which still needs a click
    // path for the native button to remain accessible.
    if (event.detail === 0) {
      attemptSwap();
      engine.releaseCountdownSwap();
    }
  };

  const toggleSound = (event: React.MouseEvent<HTMLButtonElement>) => {
    setSoundEnabled((enabled) => !enabled);
    // Pointer users expect game keys to work immediately after toggling sound.
    // Keyboard/assistive activation keeps native button focus for accessibility.
    if (event.detail > 0) {
      window.requestAnimationFrame(() => canvasRef.current?.focus());
    }
  };

  const restartPrompt = gameOverRestartPrompt(
    snapshot.gameOverElapsedMs,
    GAME_OVER_RESTART_DELAY_MS,
  );

  return (
    <section
      className="game-experience"
      data-touch-controls={touchControlsAvailable}
      aria-labelledby="game-title"
      aria-busy={!visualReady}
      style={{ visibility: visualReady ? "visible" : "hidden" }}
    >
      <h1 id="game-title" className="sr-only">Crack Attack browser port</h1>

      <div className="port-bar">
        <div>
          <span className="port-kicker">Open-source browser port</span>
          <span className="port-status"><i aria-hidden="true" /> Original-style single player</span>
        </div>
        <div className="port-actions">
          <button type="button" onClick={toggleSound}>
            {soundEnabled ? "Sound on" : "Sound off"}
          </button>
          <button type="button" onClick={pauseRun} disabled={snapshot.status === "ready" || snapshot.status === "gameover"}>
            {snapshot.status === "paused" ? "Resume" : "Pause"}
          </button>
          {match.phase === "solo" && (
            <button type="button" onClick={createChallenge} disabled={snapshot.status !== "ready"}>
              Challenge a friend
            </button>
          )}
        </div>
      </div>

      {challengeError && <p className="keyboard-hint">{challengeError}</p>}

      <div className="game-play-area">
        <div className="game-frame">
          <canvas
            ref={canvasRef}
            className="game-canvas"
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={handleCanvasPointerUp}
            onPointerCancel={handleCanvasPointerCancel}
            onLostPointerCapture={handleCanvasPointerCancel}
            tabIndex={0}
            role="img"
            aria-label="A six-column Crack Attack puzzle board with a movable two-block cursor."
          />

          {snapshot.status === "ready" && (
            <div className="game-overlay">
              <button type="button" className="original-screen-action" onClick={startRun}>
                <span className="sr-only">Start single-player game</span>
              </button>
            </div>
          )}

          {snapshot.status === "paused" && (
            <div className="game-overlay">
              <button type="button" className="original-screen-action" onClick={pauseRun}>
                <span className="sr-only">Resume game</span>
              </button>
            </div>
          )}

          {snapshot.status === "gameover" && (
            <div className="game-overlay">
              <button
                type="button"
                className="original-screen-action"
                onClick={startRun}
                disabled={!restartPrompt.ready}
              >
                <span className="game-over-summary">
                  {isNewBest && <strong>New best</strong>}
                  <span>
                    Final score <b>{snapshot.score.toLocaleString()}</b>
                    <i aria-hidden="true" />
                    Best <b>{highScore.toLocaleString()}</b>
                  </span>
                  <small>{restartPrompt.text}</small>
                </span>
              </button>
            </div>
          )}

          {match.phase === "waiting" && (
            <div className="game-overlay">
              <p>Waiting for your opponent…</p>
              <p className="challenge-link">{match.link}</p>
              <button type="button" className="original-screen-action" onClick={copyChallengeLink}>
                {linkCopied ? "Copied!" : "Copy challenge link"}
              </button>
              <p className="keyboard-hint">Keep this tab open — the link dies if you close it.</p>
            </div>
          )}

          {match.status === "reconnecting" && (match.phase === "playing" || match.phase === "waiting") && (
            <div className="game-overlay game-overlay--passthrough">
              <p>Connection lost — reconnecting…</p>
            </div>
          )}

          {match.phase === "peer-gone" && (
            <div className="game-overlay game-overlay--passthrough">
              <p>Your opponent dropped out.</p>
              <p className="keyboard-hint">Waiting 30 seconds for them to come back…</p>
            </div>
          )}

          {match.phase === "over" && (
            <div className="game-overlay">
              <p>{match.outcome === "forfeit"
                ? "Your opponent didn't come back. You win."
                : "Match over."}</p>
              <button type="button" className="original-screen-action" onClick={playAgain}>
                Play again
              </button>
            </div>
          )}
        </div>

        <div className="game-controls">
          <p className="keyboard-hint">
            <strong>Keyboard controls</strong>
            <span><kbd>Arrow keys</kbd> move</span>
            <span><kbd>Space</kbd> swap</span>
            <span><kbd>Enter</kbd> raise</span>
            <span><kbd>P</kbd> pause</span>
            <span><kbd>Esc</kbd> concede</span>
          </p>

          <p className="touch-hint" id="touch-control-hint">
            <strong>Touch:</strong> swipe blocks sideways, or glide anywhere on the move pad.
          </p>
          <div
            className="touch-console"
            role="group"
            aria-label="On-screen game controls"
            aria-describedby="touch-control-hint"
          >
            <div
              className={`gesture-pad${thumbpadVisual.active ? " is-active" : ""}`}
              onPointerDown={handleThumbpadPointerDown}
              onPointerMove={handleThumbpadPointerMove}
              onPointerUp={finishThumbpadGesture}
              onPointerCancel={cancelThumbpadGesture}
              onLostPointerCapture={cancelThumbpadGesture}
            >
              <span
                className="gesture-pad-puck"
                aria-hidden="true"
                style={{
                  transform: `translate3d(${thumbpadVisual.x}px, ${thumbpadVisual.y}px, 0)`,
                }}
              />
              <span className="gesture-pad-name" aria-hidden="true">Glide</span>
              <button
                type="button"
                className={`pad-zone pad-up${
                  thumbpadVisual.pressedDirection === "up" ? " is-pressed" : ""
                }`}
                data-pad-dx="0"
                data-pad-dy="1"
                data-pad-direction="up"
                aria-label="Move cursor up"
                onClick={() => tapMove(0, 1)}
              ><span aria-hidden="true">▲</span></button>
              <button
                type="button"
                className={`pad-zone pad-right${
                  thumbpadVisual.pressedDirection === "right" ? " is-pressed" : ""
                }`}
                data-pad-dx="1"
                data-pad-dy="0"
                data-pad-direction="right"
                aria-label="Move cursor right"
                onClick={() => tapMove(1, 0)}
              ><span aria-hidden="true">▶</span></button>
              <button
                type="button"
                className={`pad-zone pad-down${
                  thumbpadVisual.pressedDirection === "down" ? " is-pressed" : ""
                }`}
                data-pad-dx="0"
                data-pad-dy="-1"
                data-pad-direction="down"
                aria-label="Move cursor down"
                onClick={() => tapMove(0, -1)}
              ><span aria-hidden="true">▼</span></button>
              <button
                type="button"
                className={`pad-zone pad-left${
                  thumbpadVisual.pressedDirection === "left" ? " is-pressed" : ""
                }`}
                data-pad-dx="-1"
                data-pad-dy="0"
                data-pad-direction="left"
                aria-label="Move cursor left"
                onClick={() => tapMove(-1, 0)}
              ><span aria-hidden="true">◀</span></button>
            </div>
            <button
              type="button"
              className="console-button swap-button"
              onPointerDown={pressSwap}
              onPointerUp={releaseSwap}
              onPointerCancel={releaseSwap}
              onLostPointerCapture={releaseSwap}
              onClick={clickSwap}
            >
              <span>Swap</span>
            </button>
            <button
              type="button"
              className="console-button raise-button"
              onPointerDown={pressRaise}
              onPointerUp={releaseRaise}
              onPointerCancel={releaseRaise}
              onLostPointerCapture={releaseRaise}
            >
              <span>Raise</span>
            </button>
          </div>
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        {statusCopy(snapshot, isNewBest, restartPrompt.ready)}
      </p>
    </section>
  );
}
