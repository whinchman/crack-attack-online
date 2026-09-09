/*
 * Crack Attack! browser port
 * Copyright (C) 2026 OpenAI
 *
 * Gameplay behavior is derived from Crack Attack! 1.1.15-cvs.
 * Crack Attack! is Copyright (C) 2000-2006 by its original contributors.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 2 of the License, or (at your option)
 * any later version.
 */

export const BOARD_COLUMNS = 6;
export const VISIBLE_ROWS = 12;
// The desktop grid keeps 45 logical rows including y=0, the hidden creep row.
// `nextRow` models y=0 separately, leaving 44 rows in the active board.
export const BUFFER_ROWS = 44;
export const NORMAL_FLAVOR_COUNT = 5;
export const GRAY_FLAVOR = 5;
export const AWAKEN_INITIAL_DELAY_MS = 1300;
export const AWAKEN_INTERNAL_DELAY_MS = 300;
export const AWAKEN_FINAL_DELAY_MS = 1000;
export const AWAKEN_POP_DURATION_MS = 240;
export const CURSOR_MOVE_DURATION_MS = 120;
export const COUNTDOWN_SEGMENT_MS = 50 * 20;
export const COUNTDOWN_START_DELAY_MS = 150 * 20;
// CountDownManager plays its cue when each 50-tick message has 30 ticks left.
export const COUNTDOWN_CUE_DELAY_MS = 21 * 20;
// CelebrationManager's loss sign reaches its final resting state after 194
// meta ticks. Until then, the original ignores input that would leave the
// celebration screen.
export const GAME_OVER_RESTART_DELAY_MS = 194 * 20;
// CelebrationManager dims the frozen playfield over 200 meta ticks.
export const GAME_OVER_BOARD_FADE_MS = 200 * 20;
// Crack Attack advances at 50 Hz and keeps dying blocks alive for 90 ticks.
export const BLOCK_CLEAR_DURATION_MS = 90 * 20;
export const DANGER_LOSS_DELAY_MS = 7000;
// Crack Attack 1.1.14 restores the loss alarm to one second whenever dying
// or awakening pieces pause it. This is also the low/high-alert bar boundary.
export const DANGER_ELIMINATION_GRACE_MS = 1000;
export const DANGER_HIGH_ALERT_MS =
  DANGER_LOSS_DELAY_MS - DANGER_ELIMINATION_GRACE_MS;
export const REWARD_SIGN_HOLD_MS = 100 * 20;
export const REWARD_SIGN_FADE_MS = 200 * 20;
export const REWARD_SIGN_LIFETIME_MS = REWARD_SIGN_HOLD_MS + REWARD_SIGN_FADE_MS;
export const REWARD_MOTE_CAPACITY = 40;
// SparkleManager stores velocity in grid-world units per simulation tick.
// Browser particles use rows, and one row is two original world units.
export const DEATH_SPARK_GRAVITY = 0.001 / 2;
export const DEATH_SPARK_DRAG = 0.001;
export const LEVEL_LIGHT_FADE_MS = 3000;
export const LEVEL_LIGHT_IMPACT_FLASH_MS = 20 * 20;
export const LEVEL_LIGHT_DEATH_FLASH_TICKS = 12;
export const GARBAGE_ROW_REFORM_CHANCE = 0.5;
export const GARBAGE_QUEUE_CAPACITY = 8;
export const SWAP_DURATION_MS = 6 * 20;
export const LOSE_BAR_FADE_TICKS = 20;
// The original simulation consumes every elapsed 20 ms tick. Rendering may
// skip frames, but gameplay time is never discarded when a frame is late.
const SIMULATION_STEP_MS = 20;
const CREEP_STEPS_PER_ROW = 60;
// Game::time_step advances throughout the 150-tick opening pause. Creep's
// first speed alarm is therefore already 149 ticks old when play begins.
const CREEP_GAME_CLOCK_OFFSET_MS = COUNTDOWN_START_DELAY_MS - SIMULATION_STEP_MS;
// Original 50 Hz timing: three ticks hanging, then three ticks per row.
const FALL_HANG_MS = 60;
const FALL_ROW_MS = 60;
// Spring.h applies these values once per 50 Hz simulation tick. Spring::y is
// measured in OpenGL world units, where one playfield row is exactly 2 units.
const IMPACT_SPRING_VELOCITY = 0.1;
const IMPACT_GARBAGE_DENSITY = 0.2;
const IMPACT_SPRING_STIFFNESS = 0.1;
const IMPACT_SPRING_DRAG = 0.1;
const WORLD_UNITS_PER_ROW = 2;

/**
 * Crack Attack's Game::sqrt is intentionally a cheap polynomial rather than
 * the standard-library square root. All of its UI fades pass values in [0, 1].
 */
export function sourceSqrtCurve(value: number): number {
  const bounded = Math.max(0, Math.min(1, value));
  return ((27 / 14) - (13 / 14) * bounded) * bounded;
}

export interface SoloHudStarVisual {
  rotation: number;
  alpha: number;
}

/** Reproduce WinRecord's accelerated play spin and lost-star meta animation. */
export function soloHudStarVisual(
  activeTicks: number,
  gameOverTicks: number | null = null,
): SoloHudStarVisual {
  const playTicks = Math.max(0, Math.floor(activeTicks));
  // Game::time_step starts at one. The first active tick therefore contributes
  // 2/150 degrees, through time_step 150, before settling at one degree/tick.
  const rampTicks = Math.min(playTicks, 149);
  let rotationDegrees = (
    ((rampTicks + 1) * (rampTicks + 2)) / 2 - 1
  ) / 150 + Math.max(0, playTicks - 149);
  let alpha = 1;

  if (gameOverTicks !== null) {
    const metaTicks = Math.max(0, Math.floor(gameOverTicks));
    const turningTicks = Math.min(metaTicks, 223);
    rotationDegrees += (
      turningTicks * 224 - (turningTicks * (turningTicks + 1)) / 2
    ) / 225;
    const metaTimeStep = Math.min(225, 1 + metaTicks);
    alpha = 1 - 0.6 * sourceSqrtCurve(metaTimeStep / 225);
  }

  return {
    rotation: rotationDegrees * Math.PI / 180,
    alpha,
  };
}

export type BlockFlavor = 0 | 1 | 2 | 3 | 4 | 5;
export type GameStatus = "ready" | "countdown" | "playing" | "paused" | "gameover";
export type GarbageFlavor = "normal" | "gray";

interface Motion {
  animationFromX?: number;
  animationFromY?: number;
  animationStarted?: number;
  animationDuration?: number;
  animationDelay?: number;
}

export interface BlockCell extends Motion {
  id: number;
  kind: "block";
  flavor: BlockFlavor;
  state: "idle" | "clearing" | "awakening";
  clearStarted?: number;
  clearUntil?: number;
  deathSparkCount?: number;
  deathSpinAxis?: number;
  awakenRevealAt?: number;
  awakenReleaseAt?: number;
  awakenSource?: GarbageFlavor;
  awakenSequence?: number;
  awakenPopDirection?: number;
  awakenNotified?: boolean;
  comboId?: number;
}

export interface GarbageCell extends Motion {
  id: number;
  kind: "garbage";
  groupId: number;
  flavor: GarbageFlavor;
  texture: number | null;
  decalX?: number;
  decalY?: number;
  state: "idle" | "shattering" | "awakening";
  clearStarted?: number;
  clearUntil?: number;
  shatterTargetFlavor?: BlockFlavor;
  shatterSequence?: number;
  shatterPopDirection?: number;
  shatterReforms?: boolean;
  awakenRevealAt?: number;
  awakenReleaseAt?: number;
  awakenSource?: GarbageFlavor;
  awakenSequence?: number;
  awakenPopDirection?: number;
  comboId?: number;
  initialFallUntil?: number;
  initialImpactAt?: number;
}

export type Cell = BlockCell | GarbageCell;
export type Board = Array<Array<Cell | null>>;

export interface Coordinate {
  x: number;
  y: number;
}

export interface MatchPattern {
  coordinates: Coordinate[];
  anchor: Coordinate;
}

export interface MatchResult {
  coordinates: Coordinate[];
  patterns: MatchPattern[];
}

export interface RewardSign {
  id: number;
  kind: "bonus" | "magnitude" | "multiplier";
  value: number;
  gridX: number;
  gridY: number;
  x: number;
  y: number;
  jitterX: number;
  jitterY: number;
  startedAt: number;
  until: number;
}

export type LoseBarPhase =
  | "inactive"
  | "low"
  | "high"
  | "fade-low"
  | "fade-high"
  | "reset-high";

export interface LoseBarState {
  phase: LoseBarPhase;
  progress: number;
  fade: number;
}

export type SparkleStyle =
  | "four"
  | "five"
  | "six"
  | "special"
  | "multiplier-one"
  | "multiplier-two"
  | "multiplier-three";

export interface DeathSpark {
  id: number;
  flavor: BlockFlavor;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  rotation: number;
  angularVelocity: number;
  size: number;
  startedAt: number;
  until: number;
}

export interface DeathSparkVisual {
  x: number;
  y: number;
  rotation: number;
  alpha: number;
  pulse: number;
}

export function deathSparkVisualAt(
  spark: DeathSpark,
  now: number,
): DeathSparkVisual {
  const ageTicks = Math.max(0, now - spark.startedAt) / SIMULATION_STEP_MS;
  const remainingTicks = Math.max(0, spark.until - now) / SIMULATION_STEP_MS;
  const dragFactor = 1 - DEATH_SPARK_DRAG;
  const geometricDistance = DEATH_SPARK_DRAG > 0
    ? (1 - dragFactor ** ageTicks) / DEATH_SPARK_DRAG
    : ageTicks;
  const terminalVelocity = DEATH_SPARK_DRAG > 0
    ? DEATH_SPARK_GRAVITY / DEATH_SPARK_DRAG
    : 0;
  const alpha = remainingTicks < 15 ? remainingTicks / 15 : 1;
  let pulse = 0;
  if (remainingTicks >= 15 && remainingTicks < 21) {
    pulse = (remainingTicks - 15) * 2 / 6;
    if (pulse > 1) pulse = 2 - pulse;
  }
  return {
    x: spark.x + spark.velocityX * geometricDistance,
    y: spark.y
      + (spark.velocityY + terminalVelocity) * geometricDistance
      - terminalVelocity * ageTicks,
    rotation: spark.rotation + spark.angularVelocity * ageTicks,
    alpha,
    pulse,
  };
}

export interface RewardSignVisual {
  alpha: number;
  scale: number;
  verticalMovementRows: number;
}

export function rewardSignVisualAt(
  sign: RewardSign,
  now: number,
): RewardSignVisual {
  const ageMs = Math.max(0, now - sign.startedAt);
  const fade = ageMs <= REWARD_SIGN_HOLD_MS
    ? 1
    : Math.max(
      0,
      Math.min(1, (REWARD_SIGN_LIFETIME_MS - ageMs) / REWARD_SIGN_FADE_MS),
    );
  const expansion = 1 - fade;
  const ageTicks = ageMs / SIMULATION_STEP_MS;
  return {
    alpha: fade ** 2,
    scale: 1 + 4 * expansion ** 2,
    verticalMovementRows: ageTicks <= 100
      ? ageTicks * (ageTicks + 1) * 0.00001
      : 0.101 + (ageTicks - 100) * 0.002,
  };
}

export interface RewardMote {
  id: number;
  style: SparkleStyle;
  colorIndex: number;
  lightColorIndex: number;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  rotation: number;
  initialRotation: number;
  angularVelocity: number;
  size: number;
  inverseMass: number;
  siblingDelayTicks: number;
  startedAt: number;
  launchAt: number;
  until: number;
}

export type RewardMoteColor = [number, number, number];

// SparkleManager.cxx and DrawCandy.cxx use these level tables verbatim. Normal
// magnitude rewards occupy levels 0..2, gray occupies level 3, and multiplier
// rewards begin at level 11.
const REWARD_MOTE_LEVEL_COLORS = [
  0, 0, 0, 4, 5, 6, 7, 8, 9, 10, 11,
  0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 3,
] as const;
const REWARD_MOTE_LEVEL_LIGHT_COLORS = [
  0, 0, 0, 0, 1, 0, 2, 3, 4, 5, 6,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
] as const;
const REWARD_MOTE_LEVEL_STYLES: readonly SparkleStyle[] = [
  "four", "five", "six", "special", "special", "special", "special",
  "special", "special", "special", "special", "multiplier-one",
  "multiplier-two", "multiplier-three", "multiplier-three",
  "multiplier-three", "multiplier-three", "multiplier-three",
  "multiplier-three", "multiplier-three", "multiplier-three",
  "multiplier-three",
];
const REWARD_MOTE_LEVEL_SIZES = [
  2, 2.8, 2.8, 3.4, 3.4, 3.4, 3.4, 3.4, 3.4, 3.4, 3.4,
  4, 2.6, 3.5, 3.7, 3.9, 4.1, 4.3, 4.5, 4.7, 4.9, 5.1,
] as const;
const REWARD_MOTE_LEVEL_INVERSE_MASSES = [
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1 / 1.4, 1 / 1.8, 1 / 2.2, 1 / 2.6,
  1 / 3, 1 / 3.4, 1 / 3.8, 1 / 4.2,
] as const;

export const REWARD_MOTE_PALETTE: readonly RewardMoteColor[] = [
  [1, 0, 0],
  [0.9, 0.4, 0],
  [0.8, 0.8, 0],
  [0.3, 0.3, 1],
  [0.4, 0.4, 0.4],
  [0, 0, 0],
  [0.9, 0.9, 0.9],
  [0.73, 0, 0.73],
  [0.2, 0.2, 0.8],
  [0, 0.6, 0.05],
  [0.85, 0.85, 0],
  [1, 0.4, 0],
];

export const REWARD_MOTE_LIGHT_PALETTE: readonly RewardMoteColor[] = [
  [1, 1, 1],
  [-1, -1, -1],
  [0.8, 0, 0.8],
  [0, 0, 1],
  [0, 1, 0],
  [0.8, 0.8, 0],
  [1, 0.7, 0],
];

export const REWARD_MOTE_HOLD_MS = 90 * SIMULATION_STEP_MS;
export const REWARD_MOTE_SIBLING_DELAY_MS = 25 * SIMULATION_STEP_MS;

export interface RewardMoteDefinition {
  originalLevel: number;
  style: SparkleStyle;
  colorIndex: number;
  lightColorIndex: number;
  size: number;
  inverseMass: number;
}

export interface RewardMoteVisual {
  active: boolean;
  x: number;
  y: number;
  rotation: number;
  alpha: number;
  color: RewardMoteColor;
  lightBrightness: number;
  lightColor: RewardMoteColor;
}

interface RewardMoteState {
  active: boolean;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  rotation: number;
  angularVelocity: number;
  lifeTime: number;
}

export function rewardMoteDefinition(
  kind: "magnitude" | "multiplier",
  level: number,
): RewardMoteDefinition {
  const originalLevel = Math.max(
    0,
    Math.min(REWARD_MOTE_LEVEL_STYLES.length - 1, kind === "multiplier" ? level + 9 : level),
  );
  return {
    originalLevel,
    style: REWARD_MOTE_LEVEL_STYLES[originalLevel],
    colorIndex: REWARD_MOTE_LEVEL_COLORS[originalLevel],
    lightColorIndex: REWARD_MOTE_LEVEL_LIGHT_COLORS[originalLevel],
    size: REWARD_MOTE_LEVEL_SIZES[originalLevel],
    inverseMass: REWARD_MOTE_LEVEL_INVERSE_MASSES[originalLevel],
  };
}

function initialRewardMoteState(mote: RewardMote): RewardMoteState {
  return {
    active: true,
    x: mote.x,
    y: mote.y,
    velocityX: mote.velocityX,
    velocityY: mote.velocityY,
    rotation: mote.rotation,
    angularVelocity: mote.angularVelocity,
    lifeTime: 0,
  };
}

function advanceRewardMote(mote: RewardMote, state: RewardMoteState): RewardMoteState {
  if (!state.active) return state;
  let {
    x,
    y,
    velocityX,
    velocityY,
    rotation,
    angularVelocity,
    lifeTime,
  } = state;

  if (lifeTime >= 0) {
    lifeTime += 1;
    if (lifeTime - mote.siblingDelayTicks < 90) {
      rotation += angularVelocity;
      return {
        active: true,
        x,
        y,
        velocityX,
        velocityY,
        rotation,
        angularVelocity,
        lifeTime,
      };
    }
    lifeTime = -1;
  } else if (mote.colorIndex > 0 && mote.colorIndex < 4) {
    lifeTime -= 1;
  }

  // SparkleManager moves first, then applies its upward force, center spring,
  // drag, and angular spring. One browser row is two original GL units.
  y += velocityY;
  if (y > 16 + mote.size * 0.05) {
    return {
      active: false,
      x,
      y,
      velocityX,
      velocityY,
      rotation,
      angularVelocity,
      lifeTime,
    };
  }
  x += velocityX;
  rotation += angularVelocity;
  velocityY += mote.inverseMass * 0.002 - 0.005 * velocityY;
  velocityX -= mote.inverseMass * 0.005 * (x - BOARD_COLUMNS / 2)
    + 0.005 * velocityX;
  angularVelocity -= mote.inverseMass * 0.0008 * (rotation - mote.initialRotation);

  return {
    active: true,
    x,
    y,
    velocityX,
    velocityY,
    rotation,
    angularVelocity,
    lifeTime,
  };
}

function rewardMoteColor(mote: RewardMote, lifeTime: number): RewardMoteColor {
  const target = REWARD_MOTE_PALETTE[mote.colorIndex] ?? REWARD_MOTE_PALETTE[0];
  if (mote.colorIndex > 0 && mote.colorIndex < 4) {
    const red = REWARD_MOTE_PALETTE[0];
    if (lifeTime >= 0 && lifeTime < 90) return [...red];
    if (lifeTime > -50) {
      const fade = -lifeTime / 50;
      return [
        red[0] + (target[0] - red[0]) * fade,
        red[1] + (target[1] - red[1]) * fade,
        red[2] + (target[2] - red[2]) * fade,
      ];
    }
  }
  return [...target];
}

function rewardMoteStateAt(mote: RewardMote, now: number): RewardMoteState {
  const elapsedTicks = Math.floor(Math.max(0, now - mote.startedAt) / SIMULATION_STEP_MS);
  let state = initialRewardMoteState(mote);
  for (let tick = 0; tick < elapsedTicks && state.active; tick += 1) {
    state = advanceRewardMote(mote, state);
  }
  return state;
}

export function rewardMoteVisualAt(mote: RewardMote, now: number): RewardMoteVisual {
  const state = rewardMoteStateAt(mote, now);
  const alpha = state.lifeTime >= 0 && state.lifeTime < 90 ? state.lifeTime / 90 : 1;
  return {
    active: state.active,
    x: state.x,
    y: state.y,
    rotation: state.rotation,
    alpha,
    color: rewardMoteColor(mote, state.lifeTime),
    lightBrightness: state.active ? 0.4 * alpha : 0,
    lightColor: [...(
      REWARD_MOTE_LIGHT_PALETTE[mote.lightColorIndex]
      ?? REWARD_MOTE_LIGHT_PALETTE[0]
    )],
  };
}

function rewardMoteEndTime(mote: RewardMote): number {
  let state = initialRewardMoteState(mote);
  for (let tick = 1; tick <= 2000; tick += 1) {
    state = advanceRewardMote(mote, state);
    if (!state.active) return mote.startedAt + tick * SIMULATION_STEP_MS;
  }
  return mote.startedAt + 2000 * SIMULATION_STEP_MS;
}

export interface AttackPayload {
  height: number;
  width: number;
  flavor: GarbageFlavor;
  source: "clear" | "chain";
  createdAt: number;
}

export type AttackSink = (attack: AttackPayload) => void;

interface QueuedAttack extends AttackPayload {
  dropAt: number;
}

export type GameEvent =
  | { type: "swap" }
  | { type: "block-land"; count: number }
  | { type: "clear"; magnitude: number; gray: boolean }
  | { type: "chain"; depth: number }
  | { type: "garbage" }
  | { type: "garbage-impact"; area: number }
  | { type: "awaken"; flavor: BlockFlavor; sequence: number }
  | { type: "danger" }
  | { type: "rise" }
  | { type: "countdown-cue"; remaining: 0 | 1 | 2 | 3 }
  | { type: "start" }
  | { type: "gameover" };

export interface GameSnapshot {
  board: Board;
  nextRow: Array<Cell | null>;
  status: GameStatus;
  phase: Phase;
  score: number;
  displayScore: number;
  previousDisplayScore: number;
  scoreFadeProgress: number;
  elapsedMs: number;
  rise: number;
  impactOffsetRows: number;
  cursorX: number;
  cursorY: number;
  cursorRenderX: number;
  cursorRenderY: number;
  swapProgress: number;
  chainDepth: number;
  topOccupiedRow: number;
  levelLightBlends: number[];
  levelLightImpactFlashes: number[];
  dangerActive: boolean;
  dangerFlashAlarm: number;
  dangerMs: number;
  loseBar: LoseBarState;
  incomingCount: number;
  nextIncomingMs: number | null;
  countdown: "1" | "2" | "3" | "GO!" | null;
  countdownProgress: number;
  gameOverElapsedMs: number;
  message: string | null;
  messageUntil: number;
  lastGain: number;
  rewardSigns: RewardSign[];
  deathSparks: DeathSpark[];
  rewardMotes: RewardMote[];
  awakeningCount: number;
  nextAwakeningMs: number | null;
  pausedElapsedMs: number;
  visualNow: number;
  boardVisualNow: number;
  headlightLevel: number;
  hudStarRotation: number;
  hudStarAlpha: number;
  opponentLevelLights: number;
}

type Phase = "idle" | "swapping" | "clearing" | "falling" | "garbage";

interface LevelLightTransition {
  from: number;
  to: number;
  startedAt: number;
  duration: number;
}

interface ComboState {
  id: number;
  createdAt: number;
  multiplier: number;
  baseAccumulatedScore: number;
}

function emptyRow(): Array<Cell | null> {
  return Array.from({ length: BOARD_COLUMNS }, () => null);
}

export function createEmptyBoard(): Board {
  return Array.from({ length: BUFFER_ROWS }, emptyRow);
}

function isMatchable(cell: Cell | null): cell is BlockCell {
  return cell?.kind === "block" && cell.state === "idle";
}

function coordinateKey(x: number, y: number): string {
  return `${x}:${y}`;
}

export function findMatches(board: Board): MatchResult {
  const lines: Coordinate[][] = [];

  for (let y = 0; y < board.length; y += 1) {
    let x = 0;
    while (x < BOARD_COLUMNS) {
      const cell = board[y]?.[x] ?? null;
      if (!isMatchable(cell)) {
        x += 1;
        continue;
      }
      let end = x + 1;
      while (
        end < BOARD_COLUMNS &&
        isMatchable(board[y][end]) &&
        (board[y][end] as BlockCell).flavor === cell.flavor
      ) {
        end += 1;
      }
      if (end - x >= 3) {
        const line: Coordinate[] = [];
        for (let cursor = x; cursor < end; cursor += 1) {
          line.push({ x: cursor, y });
        }
        lines.push(line);
      }
      x = end;
    }
  }

  for (let x = 0; x < BOARD_COLUMNS; x += 1) {
    let y = 0;
    while (y < board.length) {
      const cell = board[y]?.[x] ?? null;
      if (!isMatchable(cell)) {
        y += 1;
        continue;
      }
      let end = y + 1;
      while (
        end < board.length &&
        isMatchable(board[end][x]) &&
        (board[end][x] as BlockCell).flavor === cell.flavor
      ) {
        end += 1;
      }
      if (end - y >= 3) {
        const line: Coordinate[] = [];
        for (let cursor = y; cursor < end; cursor += 1) {
          line.push({ x, y: cursor });
        }
        lines.push(line);
      }
      y = end;
    }
  }

  if (lines.length === 0) return { coordinates: [], patterns: [] };

  // Crack Attack reports an intersecting cross as one elimination, but two
  // independent lines as two eliminations. Late eliminations each advance the
  // combo multiplier, even when they land on the same simulation step.
  const parents = lines.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const unite = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const ownerByCoordinate = new Map<string, number>();
  lines.forEach((line, lineIndex) => {
    for (const coordinate of line) {
      const key = coordinateKey(coordinate.x, coordinate.y);
      const owner = ownerByCoordinate.get(key);
      if (owner === undefined) ownerByCoordinate.set(key, lineIndex);
      else unite(owner, lineIndex);
    }
  });

  const coordinatesByPattern = new Map<number, Map<string, Coordinate>>();
  lines.forEach((line, lineIndex) => {
    const root = find(lineIndex);
    const pattern = coordinatesByPattern.get(root) ?? new Map<string, Coordinate>();
    for (const coordinate of line) {
      pattern.set(coordinateKey(coordinate.x, coordinate.y), coordinate);
    }
    coordinatesByPattern.set(root, pattern);
  });

  const patterns = [...coordinatesByPattern.values()].map((pattern): MatchPattern => {
    const coordinates = [...pattern.values()];
    const meanX = coordinates.reduce((sum, coordinate) => sum + coordinate.x, 0)
      / coordinates.length;
    const meanY = coordinates.reduce((sum, coordinate) => sum + coordinate.y, 0)
      / coordinates.length;
    const anchor = coordinates.reduce((closest, coordinate) => {
      const closestDistance = (closest.x - meanX) ** 2 + (closest.y - meanY) ** 2;
      const distance = (coordinate.x - meanX) ** 2 + (coordinate.y - meanY) ** 2;
      return distance < closestDistance ? coordinate : closest;
    });
    return { coordinates, anchor };
  });
  const coordinates = new Map<string, Coordinate>();
  for (const pattern of patterns) {
    for (const coordinate of pattern.coordinates) {
      coordinates.set(coordinateKey(coordinate.x, coordinate.y), coordinate);
    }
  }
  return { coordinates: [...coordinates.values()], patterns };
}

export function findMatchCoordinates(board: Board): Coordinate[] {
  return findMatches(board).coordinates;
}

export function baseScoreFor(magnitude: number, gray = false): number {
  if (magnitude < 3) return 0;
  const normalValue = magnitude === 3 ? 2 : magnitude;
  return gray ? normalValue * 3 : normalValue;
}

export function creepRowsPerSecond(elapsedMs: number, manualRaise: boolean): number {
  const timerStep = Math.min(2400, 20 + 20 * Math.floor(elapsedMs / 10000));
  if (manualRaise) {
    // Creep::timeStep advances three sub-cells at a time while Raise is held.
    // Once ordinary creep overtakes the initial 1200-step floor, the manual
    // speed continues increasing at three times the normal rate.
    return Math.max(1200, timerStep) / 480;
  }
  return timerStep / 1440;
}

/**
 * Return the current-tick interpolation fraction for an original vertical
 * fall, or null when the motion is not a fall. Crack Attack moves a resident
 * one third of a row on the tick that ends its hang (and immediately for a
 * no-hang fall), then leaves it visually settled for one tick before landing.
 */
export function fallMotionProgress(
  cell: Cell,
  x: number,
  targetY: number,
  now: number,
  includeCurrentStep = true,
): number | null {
  const started = cell.animationStarted;
  const duration = cell.animationDuration;
  const fromX = cell.animationFromX ?? x;
  const fromY = cell.animationFromY ?? targetY;
  if (
    started === undefined
    || duration === undefined
    || fromX !== x
    || fromY <= targetY
    || cell.state !== "idle"
  ) return null;
  if (now >= started + duration) return 1;

  const delay = cell.animationDelay ?? 0;
  if (now < started + delay) return 0;
  const travelDuration = Math.max(1, duration - delay);
  const stepLead = includeCurrentStep ? SIMULATION_STEP_MS : 0;
  return Math.max(
    0,
    Math.min(1, (now - started - delay + stepLead) / travelDuration),
  );
}

export function magnitudeAttacks(
  magnitude: number,
  createdAt: number,
): AttackPayload[] {
  if (magnitude <= 3) return [];
  const widths: number[] = [];

  if (magnitude <= BOARD_COLUMNS) {
    widths.push(magnitude - 1);
  } else if (magnitude < BOARD_COLUMNS * 2 - 1) {
    widths.push(Math.ceil(magnitude / 2), Math.floor(magnitude / 2));
  } else {
    let remainder = magnitude + 3;
    while (remainder > BOARD_COLUMNS - 1) {
      widths.push(BOARD_COLUMNS - 1);
      remainder -= BOARD_COLUMNS - 1;
    }
    if (remainder >= 3) widths.push(remainder);
  }

  return widths.map((width) => ({
    height: 1,
    width,
    flavor: "normal",
    source: "clear",
    createdAt,
  }));
}

export class CrackAttackEngine {
  private board: Board = createEmptyBoard();
  private nextRow: Array<Cell | null> = emptyRow();
  private status: GameStatus = "ready";
  private statusBeforePause: GameStatus = "playing";
  private phase: Phase = "idle";
  private phaseUntil = 0;
  private backgroundSwapStarted = 0;
  private backgroundSwapUntil = 0;
  private backgroundSwapCellIds = new Set<number>();
  private foregroundSwapCellIds = new Set<number>();
  private backgroundFallUntil = 0;
  private lastUpdate: number | null = null;
  private simulationRemainderMs = 0;
  private countdownUntil = 0;
  private countdownCueIndex = 0;
  private gameOverAt = 0;
  private score = 0;
  private displayScore = 0;
  private previousDisplayScore = 0;
  private scoreBacklog = 0;
  private scoreFadeTicks = 0;
  private scoreFadeInitialTicks = 0;
  private elapsedMs = 0;
  private rise = 0;
  private impactSpringY = 0;
  private impactSpringVelocity = 0;
  private cursorX = 2;
  // The desktop swapper starts at grid y=4. Browser row zero represents the
  // desktop's playable y=1 (the hidden creep row is stored separately), so
  // the equivalent initial selection is browser row three.
  private cursorY = 3;
  private cursorFromX = 2;
  private cursorFromY = 3;
  private cursorMoveStarted: number | null = null;
  private cursorCommandLockedUntil = 0;
  private queuedCursorMove: Coordinate | null = null;
  private queuedCursorSwap = false;
  private queuedCursorSwapReadyAt = 0;
  private chainDepth = 0;
  private chainBaseScore = 0;
  private resolvingChain = false;
  private combos = new Map<number, ComboState>();
  private nextComboId = 1;
  private legacyComboId: number | null = null;
  private dangerMs = 0;
  private dangerActive = false;
  private dangerFlashAlarm = -1;
  private loseBarPhase: LoseBarPhase = "inactive";
  private loseBarProgress = 0;
  private loseBarFadeTicks = 0;
  private raiseHeld = false;
  private raiseToRowBoundary = false;
  private creepShiftPending = false;
  private concessionPending = false;
  private queuedAttacks: QueuedAttack[] = [];
  private attackSink: AttackSink | null;
  private outgoingAttacks: AttackPayload[] = [];
  private opponentLights = 0;
  private multiplayer: boolean;
  private randomState: number;
  // BlockManager keeps independent, game-long generation histories for creep
  // rows and garbage-awakened blocks. They intentionally do not inspect the
  // live grid, whose contents may have changed through swaps and eliminations.
  private creepLastFlavor: BlockFlavor = 0;
  private creepSecondLastFlavor: BlockFlavor = 0;
  private creepLastRow: BlockFlavor[] = Array.from(
    { length: BOARD_COLUMNS },
    () => 0,
  );
  private creepSecondLastRow: BlockFlavor[] = Array.from(
    { length: BOARD_COLUMNS },
    () => 0,
  );
  private awakeningLastFlavor: BlockFlavor = 0;
  private awakeningSecondLastFlavor: BlockFlavor = 0;
  private awakeningLastRow: BlockFlavor[] = Array.from(
    { length: BOARD_COLUMNS },
    () => 0,
  );
  private awakeningSecondLastRow: BlockFlavor[] = Array.from(
    { length: BOARD_COLUMNS },
    () => 0,
  );
  // The desktop starts at direction one, then advances before assigning the
  // first awakening cube, producing 2, 3, 4, 1 across successive sections.
  private nextPopDirection = 0;
  private nextId = 1;
  private nextGroupId = 1;
  private events: GameEvent[] = [];
  private message: string | null = null;
  private messageUntil = 0;
  private lastGain = 0;
  private rewardSigns: RewardSign[] = [];
  private deathSparks: DeathSpark[] = [];
  private rewardMotes: RewardMote[] = [];
  private nextEffectId = 1;
  private pausedAt = 0;
  private levelLights: LevelLightTransition[] = Array.from(
    { length: VISIBLE_ROWS },
    () => ({ from: 0, to: 0, startedAt: 0, duration: 0 }),
  );
  private levelLightImpactUntil = Array.from({ length: VISIBLE_ROWS }, () => 0);

  constructor(options: { seed?: number; attackSink?: AttackSink; multiplayer?: boolean } = {}) {
    this.randomState = (options.seed ?? Date.now()) >>> 0 || 0x6d2b79f5;
    this.attackSink = options.attackSink ?? null;
    this.multiplayer = options.multiplayer ?? false;
    this.reset();
  }

  reset(seed?: number): void {
    if (seed !== undefined) this.randomState = seed >>> 0 || 0x6d2b79f5;
    this.board = createEmptyBoard();
    this.status = "ready";
    this.statusBeforePause = "playing";
    this.phase = "idle";
    this.phaseUntil = 0;
    this.backgroundSwapStarted = 0;
    this.backgroundSwapUntil = 0;
    this.backgroundSwapCellIds = new Set<number>();
    this.foregroundSwapCellIds = new Set<number>();
    this.backgroundFallUntil = 0;
    this.lastUpdate = null;
    this.simulationRemainderMs = 0;
    this.countdownUntil = 0;
    this.countdownCueIndex = 0;
    this.gameOverAt = 0;
    this.score = 0;
    this.displayScore = 0;
    this.previousDisplayScore = 0;
    this.scoreBacklog = 0;
    this.scoreFadeTicks = 0;
    this.scoreFadeInitialTicks = 0;
    this.elapsedMs = 0;
    this.rise = 0;
    this.impactSpringY = 0;
    this.impactSpringVelocity = 0;
    this.cursorX = 2;
    this.cursorY = 3;
    this.cursorFromX = 2;
    this.cursorFromY = 3;
    this.cursorMoveStarted = null;
    this.cursorCommandLockedUntil = 0;
    this.queuedCursorMove = null;
    this.queuedCursorSwap = false;
    this.queuedCursorSwapReadyAt = 0;
    this.chainDepth = 0;
    this.chainBaseScore = 0;
    this.resolvingChain = false;
    this.combos = new Map<number, ComboState>();
    this.nextComboId = 1;
    this.legacyComboId = null;
    this.dangerMs = 0;
    this.dangerActive = false;
    this.dangerFlashAlarm = -1;
    this.loseBarPhase = "inactive";
    this.loseBarProgress = 0;
    this.loseBarFadeTicks = 0;
    this.raiseHeld = false;
    this.raiseToRowBoundary = false;
    this.creepShiftPending = false;
    this.concessionPending = false;
    this.queuedAttacks = [];
    this.outgoingAttacks = [];
    this.opponentLights = 0;
    this.creepLastFlavor = 0;
    this.creepSecondLastFlavor = 0;
    this.creepLastRow = Array.from({ length: BOARD_COLUMNS }, () => 0);
    this.creepSecondLastRow = Array.from({ length: BOARD_COLUMNS }, () => 0);
    this.awakeningLastFlavor = 0;
    this.awakeningSecondLastFlavor = 0;
    this.awakeningLastRow = Array.from({ length: BOARD_COLUMNS }, () => 0);
    this.awakeningSecondLastRow = Array.from({ length: BOARD_COLUMNS }, () => 0);
    this.nextPopDirection = 0;
    this.events = [];
    this.message = null;
    this.messageUntil = 0;
    this.lastGain = 0;
    this.rewardSigns = [];
    this.deathSparks = [];
    this.rewardMotes = [];
    this.nextEffectId = 1;
    this.pausedAt = 0;
    this.levelLights = Array.from(
      { length: VISIBLE_ROWS },
      () => ({ from: 0, to: 0, startedAt: 0, duration: 0 }),
    );
    this.levelLightImpactUntil = Array.from({ length: VISIBLE_ROWS }, () => 0);
    this.generateInitialStack();
    this.nextRow = this.generateCreepRow();
  }

  start(now: number, resetSeed?: number): boolean {
    if (this.status !== "ready" && this.status !== "gameover") return false;
    if (this.status === "gameover") {
      if (now - this.gameOverAt < GAME_OVER_RESTART_DELAY_MS) return false;
      const priorLoseBarPhase = this.loseBarPhase;
      const priorLoseBarProgress = this.loseBarProgress;
      const priorLevelLightBlends = this.levelLights.map((_, index) => (
        this.levelLightBlendAt(index, now)
      ));
      this.reset(resetSeed);
      // LoseBar::gameStart keeps the completed game's alert colors through
      // the opening countdown, then fades them over the first 20 play ticks.
      if (priorLoseBarPhase === "high") {
        this.loseBarPhase = "fade-high";
        this.loseBarProgress = priorLoseBarProgress;
        this.loseBarFadeTicks = LOSE_BAR_FADE_TICKS;
      } else if (priorLoseBarPhase === "low") {
        this.loseBarPhase = "fade-low";
        this.loseBarProgress = priorLoseBarProgress;
        this.loseBarFadeTicks = LOSE_BAR_FADE_TICKS;
      }
      // LevelLights::initialize runs once at program launch, not once per
      // game. Preserve the completed game's colors so gameStart can fade only
      // the rows whose new occupancy target differs.
      this.levelLights = priorLevelLightBlends.map((blend) => ({
        from: blend,
        to: blend,
        startedAt: now,
        duration: 0,
      }));
    } else if (resetSeed !== undefined) {
      // The ready screen already owns an initial board so deterministic engine
      // tests can inspect it. A real run may still provide a fresh wall-clock
      // seed, matching the desktop game's time-seeded first game.
      this.reset(resetSeed);
    }
    this.status = "countdown";
    this.countdownUntil = now + COUNTDOWN_START_DELAY_MS;
    this.countdownCueIndex = 0;
    this.lastUpdate = now;
    this.simulationRemainderMs = 0;
    this.syncLevelLights(now);
    return true;
  }

  update(now: number): void {
    if (this.lastUpdate === null) this.lastUpdate = now;
    const previousUpdate = this.lastUpdate;
    this.lastUpdate = now;

    if (this.status === "countdown" || this.status === "playing") {
      this.emitDueCountdownCues(now);
    }

    if (this.status === "countdown") {
      // Swapper keeps receiving movement input during the opening countdown,
      // even though the board simulation has not started yet.
      this.processQueuedCursorCommand(now);
      if (now < this.countdownUntil) return;

      this.status = "playing";
      this.events.push({ type: "start" });

      // CountDownManager reaches zero on a 20 ms tick, and the original runs
      // the first gameplay step on that same tick. Include that boundary tick
      // plus any complete ticks elapsed since it.
      this.simulationRemainderMs += SIMULATION_STEP_MS
        + Math.max(0, now - this.countdownUntil);
    } else {
      if (this.status !== "playing") return;
      this.simulationRemainderMs += Math.max(0, now - previousUpdate);
    }

    // Game::idlePlay retains sub-tick wall time and advances gameplay only in
    // complete 20 ms steps. Rendering remains smooth through absolute-time
    // interpolation, while simulation deadlines stay on the original cadence.
    while (
      this.simulationRemainderMs >= SIMULATION_STEP_MS
      && this.status === "playing"
    ) {
      this.simulationRemainderMs -= SIMULATION_STEP_MS;
      const stepNow = now - this.simulationRemainderMs;
      this.updatePlaying(stepNow, SIMULATION_STEP_MS);
    }
  }

  private emitDueCountdownCues(now: number): void {
    if (this.countdownUntil <= 0) return;
    const countdownStartedAt = this.countdownUntil - COUNTDOWN_START_DELAY_MS;
    while (this.countdownCueIndex < 4) {
      const cueAt = countdownStartedAt
        + COUNTDOWN_CUE_DELAY_MS
        + this.countdownCueIndex * COUNTDOWN_SEGMENT_MS;
      if (now < cueAt) break;
      this.events.push({
        type: "countdown-cue",
        remaining: (3 - this.countdownCueIndex) as 0 | 1 | 2 | 3,
      });
      this.countdownCueIndex += 1;
    }
  }

  private updatePlaying(now: number, delta: number): void {
    this.elapsedMs += delta;
    this.pruneEffects(now);
    this.processQueuedCursorCommand(now);

    // Swaps, falls, clears, and garbage drops all have independent clocks in
    // the original. Advance each due clock so a newly made line never waits
    // for an unrelated breaking animation to finish.
    this.finishBackgroundSwap(now);
    this.finishBackgroundFall(now);
    this.finishDueGarbageFalls(now);
    this.finishDueClears(now);
    this.advancePhase(now);
    this.finishDueClears(now);
    this.announceAwakeningReveals(now);
    this.releaseDueAwakening(now);
    this.refreshPhase(now);
    this.finishDueGarbageImpacts(now);
    if (this.status !== "playing") {
      this.stepDisplayedScore();
      this.stepImpactSpring();
      return;
    }

    const topRow = this.topOccupiedRow(now);
    const inDanger = topRow >= VISIBLE_ROWS - 1;
    const awakening = this.awakeningCount();
    const eliminationActive = this.hasActiveClears() || awakening > 0;

    // LevelLights::timeStep runs before Creep::timeStep. Once a death-flash
    // cycle has started it therefore keeps advancing even while an elimination
    // freezes the loss alarm, and it finishes its current cycle after safety.
    this.stepDangerFlashAlarm(inDanger);

    // Original Creep::timeStep raises a high-alert loss alarm back to
    // GC_LOSS_DELAY_ELIMINATION while any blocks are dying or awakening. Our
    // timer counts upward, so the equivalent operation is a clamp to the
    // purple/red boundary, preserving a full second when play resumes.
    const resetHighAlert = this.dangerActive
      && inDanger
      && eliminationActive
      && this.dangerMs > DANGER_HIGH_ALERT_MS;
    if (resetHighAlert) {
      this.dangerMs = DANGER_HIGH_ALERT_MS;
      if (this.loseBarPhase === "high") {
        this.loseBarPhase = "reset-high";
        this.loseBarFadeTicks = LOSE_BAR_FADE_TICKS;
      }
    }

    let startedDangerThisTick = false;
    if (this.dangerActive && !inDanger) {
      this.dangerActive = false;
      this.dangerMs = 0;
    } else if (this.dangerActive && !eliminationActive) {
      this.dangerMs += delta;
    } else if (!this.dangerActive && inDanger && !eliminationActive) {
      // Creep initializes its countdown on this tick; it does not decrement it
      // until the following tick. LoseBar consequently enters low alert at 0.
      this.dangerActive = true;
      this.dangerMs = 0;
      this.dangerFlashAlarm = LEVEL_LIGHT_DEATH_FLASH_TICKS;
      this.events.push({ type: "danger" });
      startedDangerThisTick = true;
    }
    this.stepLoseBar(this.dangerActive);

    if (this.dangerMs >= DANGER_LOSS_DELAY_MS) {
      // Creep reports the loss in the middle of Game::idlePlay. Score still
      // receives its normal play tick before Score::gameFinish records the
      // result, so at most one queued point can enter the final score here.
      this.stepDisplayedScore();
      this.finishGame(now);
      this.stepImpactSpring();
      return;
    }

    // Creep::timeStep arms a safe-height freeze but still creeps on that first
    // violation tick. It returns early only on later frozen ticks or while
    // blocks are dying/awakening; other animations do not stop the pressure.
    if ((!inDanger || startedDangerThisTick) && !eliminationActive) {
      // Creep samples the physical command only after its early-return checks.
      // A held command therefore carries through a clear or danger freeze, but
      // a press released entirely during one of those phases is ignored.
      if (this.raiseHeld) this.raiseToRowBoundary = true;

      const retriedPendingShift = this.creepShiftPending;
      if (retriedPendingShift) {
        if (this.insertCreepRow(now)) {
          this.creepShiftPending = false;
          this.rise = 0;
          if (this.raiseToRowBoundary && !this.raiseHeld) {
            this.raiseToRowBoundary = false;
          }
        } else {
          // Grid::shiftGridUp leaves the board untouched and parks Creep one
          // sub-step below the boundary so it can retry when space is safe.
          this.rise = (CREEP_STEPS_PER_ROW - 1) / CREEP_STEPS_PER_ROW;
        }
      }

      if (!retriedPendingShift) {
        const manualRaiseActive = this.raiseHeld || this.raiseToRowBoundary;
        const rowsPerSecond = creepRowsPerSecond(
          this.elapsedMs + CREEP_GAME_CLOCK_OFFSET_MS,
          manualRaiseActive,
        );
        const riseDelta = rowsPerSecond * (delta / 1000);

        // Releasing Raise commits the already-started movement through the next
        // complete row. Cap that final step at the wrap point so a quick tap never
        // leaves the stack (or cursor) parked at a fractional manual offset.
        if (this.raiseToRowBoundary && !this.raiseHeld) {
          this.rise = Math.min(1, this.rise + riseDelta);
        } else {
          this.rise += riseDelta;
        }

        while (
          this.rise >= 1
          && this.status === "playing"
          && !this.hasActiveClears()
          && this.awakeningCount() === 0
        ) {
          this.rise -= 1;
          if (!this.insertCreepRow(now)) {
            this.creepShiftPending = true;
            this.rise = (CREEP_STEPS_PER_ROW - 1) / CREEP_STEPS_PER_ROW;
            if (this.raiseToRowBoundary && !this.raiseHeld) {
              this.raiseToRowBoundary = false;
            }
            break;
          }
          if (this.raiseToRowBoundary && !this.raiseHeld) {
            this.raiseToRowBoundary = false;
            this.rise = 0;
          }
        }
      }
    }

    // GarbageGenerator follows Creep and checks every active queue slot on
    // every play tick. Its pieces fall independently of swaps, eliminations,
    // awakening garbage, and other incoming pieces.
    const dueAttacks = this.queuedAttacks.filter((attack) => attack.dropAt <= now);
    if (dueAttacks.length > 0) {
      this.queuedAttacks = this.queuedAttacks.filter((attack) => attack.dropAt > now);
      for (const attack of dueAttacks) {
        if (this.dropGarbage(attack, now)) continue;
        // GarbageGenerator retries on the tick after its 300-tick alarm.
        attack.dropAt = now + (300 + 1) * SIMULATION_STEP_MS;
        this.queuedAttacks.push(attack);
      }
      this.sortAttackQueue();
    }

    this.stepDisplayedScore();

    // Game::timeStep advances Spring after grid motion, Creep, and queued
    // garbage processing. Keep that exact final position in the 20 ms tick.
    this.stepImpactSpring();
    if (this.concessionPending) this.finishGame(now);
  }

  moveCursor(dx: number, dy: number, now = this.lastUpdate ?? 0): void {
    if (this.status !== "playing" && this.status !== "countdown") return;
    this.processQueuedCursorCommand(now);
    if (this.cursorInputLocked(now)) {
      if (!this.queuedCursorSwap) this.queuedCursorMove = { x: dx, y: dy };
      return;
    }
    this.performCursorMove(dx, dy, now);
  }

  setCursor(x: number, y: number, now = this.lastUpdate ?? 0): void {
    if (this.status !== "playing" && this.status !== "countdown") return;
    // Direct board selection is a browser-native affordance rather than an
    // original controller command. It intentionally replaces queued d-pad
    // input and remains immediately swappable for taps and horizontal swipes.
    this.queuedCursorMove = null;
    this.queuedCursorSwap = false;
    this.queuedCursorSwapReadyAt = 0;
    this.cursorCommandLockedUntil = 0;
    this.moveCursorTo(x, y, now);
  }

  swap(now: number): boolean {
    if (this.status === "countdown") {
      // Controller retains a held swap throughout the opening. Swapper sees
      // it on the tick after CountDownManager releases its play lock because
      // Swapper runs immediately before the countdown manager in each tick.
      this.queuedCursorMove = null;
      this.queuedCursorSwap = true;
      this.queuedCursorSwapReadyAt = this.countdownUntil + SIMULATION_STEP_MS;
      return false;
    }
    if (this.status !== "playing") return false;
    this.processQueuedCursorCommand(now);
    if (now < this.cursorCommandLockedUntil) {
      this.queuedCursorMove = null;
      this.queuedCursorSwap = true;
      this.queuedCursorSwapReadyAt = 0;
      return true;
    }
    if (this.swapInputLocked(now)) return false;
    return this.performSwap(now);
  }

  releaseCountdownSwap(): void {
    if (
      this.status === "countdown"
      || (this.status === "paused" && this.statusBeforePause === "countdown")
    ) {
      this.queuedCursorSwap = false;
      this.queuedCursorSwapReadyAt = 0;
    }
  }

  private performSwap(now: number): boolean {
    // Input can arrive between animation frames. Resolve an elapsed
    // background swap before deciding whether the next one is legal.
    this.finishBackgroundSwap(now);
    const duringBackgroundAnimation = this.phase === "clearing"
      || this.phase === "garbage"
      || this.phase === "falling"
      || this.hasActiveClears();
    if (
      this.phase !== "idle"
      && !duringBackgroundAnimation
    ) return false;
    if (now < this.backgroundSwapUntil) return false;
    const x = this.cursorX;
    const y = this.cursorY;
    const leftCell = this.board[y]?.[x] ?? null;
    const rightCell = this.board[y]?.[x + 1] ?? null;
    const leftIsFallReservation = this.isOpenFallReservation(leftCell, x, y, now);
    const rightIsFallReservation = this.isOpenFallReservation(rightCell, x + 1, y, now);
    const left = leftIsFallReservation ? null : leftCell;
    const right = rightIsFallReservation ? null : rightCell;

    if (!left && !right) return false;
    if (left?.kind === "garbage" || right?.kind === "garbage") return false;
    if (left?.state !== undefined && left.state !== "idle") return false;
    if (right?.state !== undefined && right.state !== "idle") return false;
    if (this.cellIsMoving(left, now) || this.cellIsMoving(right, now)) return false;

    // An empty grid location is immutable while a falling resident occupies
    // the row below it or a newly hanging resident occupies the row above it.
    // Gravity's final-cell reservations hide those source rows in this port,
    // so reconstruct the original pre-resident-step grid before swapping.
    if (!left && !this.emptySwapTargetAllowed(x, y, now)) return false;
    if (!right && !this.emptySwapTargetAllowed(x + 1, y, now)) return false;

    // Gravity stores a falling stack in its eventual landing cells while the
    // renderer interpolates it from above. The original leaves those cells
    // available until impact, so let a quick horizontal swap claim one and
    // retarget the falling stack to land on top of the inserted block.
    if (leftIsFallReservation && right && !this.openFallReservation(x, y, now)) {
      return false;
    }
    if (rightIsFallReservation && left && !this.openFallReservation(x + 1, y, now)) {
      return false;
    }

    this.board[y][x] = right;
    this.board[y][x + 1] = left;
    if (right) this.setMotion(right, x + 1, y, now, SWAP_DURATION_MS);
    if (left) this.setMotion(left, x, y, now, SWAP_DURATION_MS);
    const swappedBlockIds = new Set(
      [left, right]
        .flatMap((cell) => cell?.kind === "block" ? [cell.id] : []),
    );
    if (duringBackgroundAnimation) {
      this.backgroundSwapStarted = now;
      this.backgroundSwapUntil = now + SWAP_DURATION_MS;
      this.backgroundSwapCellIds = swappedBlockIds;
    } else {
      this.phase = "swapping";
      this.phaseUntil = now + SWAP_DURATION_MS;
      this.foregroundSwapCellIds = swappedBlockIds;
    }
    this.events.push({ type: "swap" });
    return true;
  }

  setRaiseHeld(held: boolean): void {
    if (held && this.status === "countdown") {
      this.raiseHeld = true;
      return;
    }
    if (held && this.status === "playing") {
      this.raiseHeld = true;
      // Preserve responsive sub-tick browser taps during ordinary play, while
      // matching Creep's early return during eliminations and danger freezes.
      if (
        !this.hasActiveClears()
        && this.awakeningCount() === 0
        && !this.dangerActive
      ) this.raiseToRowBoundary = true;
      return;
    }
    this.raiseHeld = false;
    if (
      this.status === "countdown"
      || (this.status === "paused" && this.statusBeforePause === "countdown")
    ) this.raiseToRowBoundary = false;
  }

  togglePause(now: number): void {
    if (this.status === "playing" || this.status === "countdown") {
      // The desktop controller handles Pause after completing the current
      // simulation tick. Capture any complete wall-clock ticks up to the input
      // moment so pausing between animation frames cannot discard game time.
      this.update(now);
      if (this.status !== "playing" && this.status !== "countdown") return;
      this.statusBeforePause = this.status;
      this.status = "paused";
      this.pausedAt = now;
      // Controller keeps both the physical Raise state and Creep::advance
      // through a pause. A key-up or pointer cancellation while paused still
      // clears raiseHeld, but the already-committed row remains committed.
      return;
    }
    if (this.status === "paused") {
      this.shiftTimers(Math.max(0, now - this.pausedAt));
      this.status = this.statusBeforePause;
      this.lastUpdate = now;
      this.pausedAt = 0;
    }
  }

  concede(now: number): boolean {
    const canConcede = this.status === "playing"
      || (this.status === "paused" && this.statusBeforePause === "playing");
    if (!canConcede) return false;

    if (this.status === "paused") {
      // Preserve the frozen board when ending from Pause. The desktop can
      // concede while paused, but none of its gameplay clocks advance first.
      this.shiftTimers(Math.max(0, now - this.pausedAt));
      this.status = "playing";
      this.lastUpdate = now;
      this.pausedAt = 0;
      this.finishGame(now);
    } else {
      this.update(now);
      if (this.status === "playing") this.concessionPending = true;
    }
    return true;
  }

  receiveAttack(attack: AttackPayload): void {
    if (this.queuedAttacks.length >= GARBAGE_QUEUE_CAPACITY) return;
    // determineDropTime uses 280..319 ticks, and timeStep drops only after
    // that alarm, producing an exact 281..320 tick delay.
    const spread = (281 + Math.floor(this.random() * 40)) * SIMULATION_STEP_MS;
    this.queuedAttacks.push({ ...attack, dropAt: attack.createdAt + spread });
    this.sortAttackQueue();
  }

  /** Buffer an attack for the network layer to drain on its own cadence. */
  queueOutgoingAttack(attack: AttackPayload): void {
    if (this.outgoingAttacks.length >= 8) return;
    this.outgoingAttacks.push(attack);
  }

  /** Take everything queued since the last call. */
  drainOutgoingAttacks(): AttackPayload[] {
    return this.outgoingAttacks.splice(0);
  }

  /** Record the opponent's stack-height bits for rendering. */
  setOpponentLevelLights(bits: number): void {
    this.opponentLights = bits >>> 0;
  }

  /**
   * Summarise our own stack height as one bit per visible row, mirroring the
   * original's level_lights field. Reuses the existing private
   * `topOccupiedRow(now)` helper (engine.ts:3346) rather than re-traversing.
   */
  exportLevelLights(now: number): number {
    const top = this.topOccupiedRow(now);
    let bits = 0;
    for (let row = 0; row < VISIBLE_ROWS; row += 1) {
      if (row <= top) bits |= 1 << row;
    }
    return bits >>> 0;
  }

  /** End the game as a win because the opponent failed to return. */
  forfeitWin(now: number): void {
    this.finishGame(now);
  }

  drainEvents(): GameEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  getSnapshot(now: number): GameSnapshot {
    const visualNow = this.status === "paused" ? this.pausedAt : now;
    // Displayer::displayMeta temporarily restores the final gameplay tick when
    // drawing the board. Candy, score fades, level lights, and the loss message
    // keep advancing on the meta clock, but blocks and the swapper stay frozen.
    const boardVisualNow = this.status === "gameover" ? this.gameOverAt : visualNow;
    let headlightLevel = 1;
    let countdown: GameSnapshot["countdown"] = null;
    let countdownProgress = 0;
    if (this.status === "countdown") {
      const elapsed = Math.max(
        0,
        visualNow - (this.countdownUntil - COUNTDOWN_START_DELAY_MS),
      );
      // LightManager scales both the playfield headlight's diffuse and
      // specular colors by Game::sqrt(elapsed / opening-delay). Reward-mote lights
      // remain independent and are added by the renderer after this level.
      headlightLevel = sourceSqrtCurve(
        Math.min(1, elapsed / COUNTDOWN_START_DELAY_MS),
      );
      if (elapsed < COUNTDOWN_SEGMENT_MS) {
        countdown = "3";
        countdownProgress = elapsed / COUNTDOWN_SEGMENT_MS;
      } else if (elapsed < COUNTDOWN_SEGMENT_MS * 2) {
        countdown = "2";
        countdownProgress = (elapsed - COUNTDOWN_SEGMENT_MS) / COUNTDOWN_SEGMENT_MS;
      } else {
        countdown = "1";
        countdownProgress = (elapsed - COUNTDOWN_SEGMENT_MS * 2)
          / COUNTDOWN_SEGMENT_MS;
      }
    } else if (
      this.status === "playing"
      && this.countdownUntil > 0
      && visualNow < this.countdownUntil + COUNTDOWN_SEGMENT_MS
    ) {
      countdown = "GO!";
      countdownProgress = (visualNow - this.countdownUntil) / COUNTDOWN_SEGMENT_MS;
    }
    if (this.status !== "ready") this.syncLevelLights(visualNow, boardVisualNow);
    const activeMessage = visualNow < this.messageUntil ? this.message : null;
    const awakeningCount = this.awakeningCount();
    const nextAwakeningAt = this.nextAwakeningReleaseAt();
    const cursor = this.cursorVisualPosition(boardVisualNow);
    const scoreFadeTicks = this.scoreFadeTicksAt(visualNow);
    const scoreFadeProgress = this.scoreFadeInitialTicks > 0
      ? 1 - scoreFadeTicks / this.scoreFadeInitialTicks
      : 1;
    const hudStar = this.soloHudStarVisualAt(visualNow);
    return {
      board: this.board,
      nextRow: this.nextRow,
      status: this.status,
      phase: this.phase,
      score: this.score,
      displayScore: this.displayScore,
      previousDisplayScore: this.previousDisplayScore,
      scoreFadeProgress: Math.max(0, Math.min(1, scoreFadeProgress)),
      elapsedMs: this.elapsedMs,
      rise: this.rise,
      impactOffsetRows: this.impactSpringY / WORLD_UNITS_PER_ROW,
      cursorX: this.cursorX,
      cursorY: this.cursorY,
      cursorRenderX: cursor.x,
      cursorRenderY: cursor.y,
      swapProgress: this.phase === "swapping"
        ? Math.max(
          0,
          Math.min(1, 1 - (this.phaseUntil - boardVisualNow) / SWAP_DURATION_MS),
        )
        : boardVisualNow < this.backgroundSwapUntil
          ? Math.max(
            0,
            Math.min(
              1,
              (boardVisualNow - this.backgroundSwapStarted) / SWAP_DURATION_MS,
            ),
          )
          : 0,
      chainDepth: this.chainDepth,
      topOccupiedRow: this.topOccupiedRow(boardVisualNow),
      levelLightBlends: this.levelLights.map((_, index) => (
        this.levelLightBlendAt(index, visualNow)
      )),
      levelLightImpactFlashes: this.levelLightImpactUntil.map((_, index) => (
        this.levelLightImpactFlashAt(index, visualNow)
      )),
      dangerActive: this.dangerActive,
      dangerFlashAlarm: this.dangerFlashAlarmAt(now),
      dangerMs: this.dangerMs,
      loseBar: {
        phase: this.loseBarPhase,
        progress: this.loseBarProgress,
        fade: this.loseBarFadeTicks / LOSE_BAR_FADE_TICKS,
      },
      incomingCount: this.queuedAttacks.length,
      nextIncomingMs: this.queuedAttacks.length
        ? Math.max(0, this.queuedAttacks[0].dropAt - visualNow)
        : null,
      countdown,
      countdownProgress: Math.max(0, Math.min(1, countdownProgress)),
      gameOverElapsedMs: this.status === "gameover"
        ? Math.max(0, visualNow - this.gameOverAt)
        : 0,
      message: activeMessage,
      messageUntil: this.messageUntil,
      lastGain: this.lastGain,
      rewardSigns: this.rewardSigns.filter((sign) => visualNow < sign.until),
      deathSparks: this.deathSparks.filter((spark) => visualNow < spark.until),
      rewardMotes: this.rewardMotes.filter((mote) => visualNow < mote.until),
      awakeningCount,
      nextAwakeningMs: nextAwakeningAt === null ? null : Math.max(0, nextAwakeningAt - visualNow),
      pausedElapsedMs: this.status === "paused" ? Math.max(0, now - this.pausedAt) : 0,
      visualNow,
      boardVisualNow,
      headlightLevel,
      hudStarRotation: hudStar.rotation,
      hudStarAlpha: hudStar.alpha,
      opponentLevelLights: this.opponentLights,
    };
  }

  private advancePhase(now: number): void {
    let guard = 0;
    while (this.phase !== "idle" && now >= this.phaseUntil && guard < 6) {
      guard += 1;
      const completedPhase = this.phase;
      this.phase = "idle";
      this.phaseUntil = 0;
      if (completedPhase === "swapping") {
        this.afterSwap(now);
      } else if (completedPhase === "clearing") {
        this.finishClear(now);
      } else if (completedPhase === "falling") {
        this.afterFall(now);
      } else if (completedPhase === "garbage") {
        this.finishDueGarbageFalls(now);
      }
      this.refreshPhase(now);
    }
  }

  private finishBackgroundSwap(now: number): void {
    if (this.backgroundSwapUntil <= 0 || now < this.backgroundSwapUntil) return;

    const swapCauseCellIds = this.backgroundSwapCellIds;
    this.backgroundSwapStarted = 0;
    this.backgroundSwapUntil = 0;
    this.backgroundSwapCellIds = new Set<number>();

    const fallDuration = this.applyGravity(now);
    if (fallDuration > 0) this.scheduleFall(now, fallDuration);
    else this.resolveMatches(now, swapCauseCellIds);
    this.refreshPhase(now);
  }

  private finishBackgroundFall(now: number): void {
    if (this.backgroundFallUntil <= 0) return;

    const dueCells: Cell[] = [];
    const dueBlockIds = new Set<number>();
    for (let y = 0; y < this.board.length; y += 1) {
      for (let x = 0; x < BOARD_COLUMNS; x += 1) {
        const cell = this.board[y][x];
        const deadline = this.verticalFallDeadline(cell, x, y);
        if (deadline === null || deadline > now) continue;
        dueCells.push(cell as Cell);
        if (cell?.kind === "block") dueBlockIds.add(cell.id);
      }
    }

    const reachedBackgroundDeadline = now >= this.backgroundFallUntil;
    if (dueCells.length === 0 && !reachedBackgroundDeadline) return;
    if (reachedBackgroundDeadline) this.backgroundFallUntil = 0;
    for (const cell of dueCells) this.clearMotion(cell);

    const fallDuration = this.applyGravity(now);
    if (fallDuration > 0) this.scheduleFall(now, fallDuration);
    const landedBlockCount = this.board.reduce((count, row) => (
      count + row.filter((cell) => (
        cell?.kind === "block"
        && dueBlockIds.has(cell.id)
        && !this.cellIsMoving(cell, now)
      )).length
    ), 0);
    if (landedBlockCount > 0) {
      this.events.push({ type: "block-land", count: landedBlockCount });
    }
    this.resolveMatches(now);
    this.refreshPhase(now);
  }

  private finishDueGarbageFalls(now: number): void {
    const landedGroups = this.collectGarbageGroups()
      .filter((group) => group.positions.some(({ cell }) => (
        cell.initialFallUntil !== undefined && cell.initialFallUntil <= now
      )))
      .sort((left, right) => left.minY - right.minY);
    if (landedGroups.length === 0) return;

    for (const group of landedGroups) {
      for (const { cell } of group.positions) {
        cell.initialFallUntil = undefined;
        // If its support disappeared during the fall, applyGravity replaces
        // this provisional impact with the later, retargeted landing time.
        cell.initialImpactAt = now;
      }
    }

    const fallDuration = this.applyGravity(now, true);
    const pendingMotionUntil = Math.max(
      this.backgroundSwapUntil,
      this.backgroundFallUntil,
    );
    if (fallDuration > 0) {
      this.scheduleFall(now, Math.max(fallDuration, pendingMotionUntil - now));
      return;
    }
    if (now < pendingMotionUntil) {
      this.backgroundFallUntil = Math.max(this.backgroundFallUntil, pendingMotionUntil);
      this.refreshPhase(now);
      return;
    }
    this.resolveMatches(now);
    this.refreshPhase(now);
  }

  private finishDueGarbageImpacts(now: number): void {
    const landedGroups = this.collectGarbageGroups()
      .filter((group) => group.positions.some(({ cell }) => (
        cell.initialImpactAt !== undefined && cell.initialImpactAt <= now
      )))
      .sort((left, right) => left.minY - right.minY);
    for (const group of landedGroups) {
      const rows = new Set(group.positions.map(({ y }) => y));
      for (const { cell } of group.positions) cell.initialImpactAt = undefined;
      this.notifyGarbageImpact(
        group.positions.length,
        Math.min(...rows),
        rows.size,
        now,
      );
    }
  }

  private notifyGarbageImpact(
    area: number,
    landingY: number,
    height: number,
    now: number,
  ): void {
    if (area <= 0) return;

    // Exact Spring::notifyImpact behavior from Crack Attack 1.1.15-cvs.
    // A second impact cannot add downward velocity while the board is already
    // moving downward faster than the spring's base impact velocity.
    const deltaVelocity = (IMPACT_SPRING_VELOCITY + this.impactSpringVelocity)
      * area
      * IMPACT_GARBAGE_DENSITY;
    if (deltaVelocity > 0) this.impactSpringVelocity -= deltaVelocity;
    for (let row = landingY; row < landingY + height && row < VISIBLE_ROWS; row += 1) {
      if (row >= 0) this.startLevelLightImpact(row, now);
    }
    this.events.push({ type: "garbage-impact", area });
  }

  private stepImpactSpring(): void {
    // Exact Spring::timeStep ordering: position first, then stiffness + drag.
    this.impactSpringY += this.impactSpringVelocity;
    this.impactSpringVelocity -= IMPACT_SPRING_STIFFNESS * this.impactSpringY
      + IMPACT_SPRING_DRAG * this.impactSpringVelocity;
  }

  private stepLoseBar(inDanger: boolean): void {
    if (
      this.loseBarPhase === "inactive"
      || this.loseBarPhase === "fade-low"
      || this.loseBarPhase === "fade-high"
    ) {
      if (this.loseBarPhase !== "inactive") {
        this.loseBarFadeTicks -= 1;
        if (this.loseBarFadeTicks <= 0) {
          this.loseBarPhase = "inactive";
          this.loseBarFadeTicks = 0;
        }
      }
      if (inDanger) {
        this.loseBarPhase = "low";
        this.loseBarFadeTicks = 0;
      }
    } else if (this.loseBarPhase === "low") {
      if (!inDanger) {
        this.loseBarPhase = "fade-low";
        this.loseBarFadeTicks = LOSE_BAR_FADE_TICKS;
      } else if (this.dangerMs >= DANGER_HIGH_ALERT_MS) {
        this.loseBarPhase = "high";
      }
    } else if (this.loseBarPhase === "high") {
      if (!inDanger) {
        this.loseBarPhase = "fade-high";
        this.loseBarFadeTicks = LOSE_BAR_FADE_TICKS;
      }
    } else if (this.loseBarPhase === "reset-high") {
      this.loseBarFadeTicks -= 1;
      if (this.loseBarFadeTicks <= 0) {
        this.loseBarPhase = "high";
        this.loseBarFadeTicks = 0;
      }
    }

    if (this.loseBarPhase === "low") {
      this.loseBarProgress = Math.max(
        0,
        Math.min(1, this.dangerMs / DANGER_HIGH_ALERT_MS),
      );
    } else if (this.loseBarPhase === "high") {
      this.loseBarProgress = Math.max(
        0,
        Math.min(
          1,
          (this.dangerMs - DANGER_HIGH_ALERT_MS)
            / (DANGER_LOSS_DELAY_MS - DANGER_HIGH_ALERT_MS),
        ),
      );
    } else if (this.loseBarPhase === "inactive") {
      this.loseBarProgress = 0;
    }
  }

  private afterSwap(now: number): void {
    const swapCauseCellIds = this.foregroundSwapCellIds;
    this.foregroundSwapCellIds = new Set<number>();
    const fallDuration = this.applyGravity(now);
    if (fallDuration > 0) {
      this.scheduleFall(now, fallDuration);
    } else {
      this.resolveMatches(now, swapCauseCellIds);
      this.refreshPhase(now);
    }
  }

  private afterFall(now: number): void {
    this.backgroundFallUntil = 0;
    const fallDuration = this.applyGravity(now);
    if (fallDuration > 0) {
      this.scheduleFall(now, fallDuration);
      return;
    }
    this.resolveMatches(now);
    this.refreshPhase(now);
  }

  private startClear(
    matches: Coordinate[],
    chainStep: boolean,
    now: number,
    patterns: MatchPattern[] = [],
  ): void {
    const effectivePatterns = patterns.length > 0
      ? patterns
      : [{ coordinates: matches, anchor: this.anchorFor(matches) }];
    let combo: ComboState;
    let continuation = false;
    if (chainStep && this.resolvingChain) {
      combo = this.legacyComboId === null
        ? this.createCombo(
          now - 1,
          Math.max(1, this.chainDepth),
          this.chainBaseScore,
        )
        : this.combos.get(this.legacyComboId)
          ?? this.createCombo(
            now - 1,
            Math.max(1, this.chainDepth),
            this.chainBaseScore,
          );
      this.legacyComboId = combo.id;
      continuation = true;
    } else {
      combo = this.createCombo(now);
      this.legacyComboId = combo.id;
    }
    this.startClearForCombo(matches, effectivePatterns, combo, continuation, now);
  }

  private startClearForCombo(
    matches: Coordinate[],
    effectivePatterns: MatchPattern[],
    combo: ComboState,
    continuation: boolean,
    now: number,
  ): void {
    const multiplierIncrements = continuation && now !== combo.createdAt
      ? effectivePatterns.length
      : 0;
    const previousDepth = combo.multiplier;
    if (multiplierIncrements > 0) {
      combo.multiplier += multiplierIncrements;
      effectivePatterns.forEach((pattern, index) => {
        const depth = previousDepth + index + 1;
        this.events.push({ type: "chain", depth });
        this.createRewardSign("multiplier", depth, pattern.anchor, now);
        // ComboTabulator creates every multiplier mote without sibling delay.
        this.createRewardMote("multiplier", pattern.anchor, depth, now, 0);
      });
    }

    const clearUntil = now + BLOCK_CLEAR_DURATION_MS;
    let normalMagnitude = 0;
    let grayMagnitude = 0;
    const directGarbage = new Set<number>();

    for (const { x, y } of matches) {
      const cell = this.board[y][x];
      if (!cell || cell.kind !== "block" || cell.state !== "idle") continue;
      cell.state = "clearing";
      cell.clearStarted = now;
      cell.clearUntil = clearUntil;
      cell.comboId = combo.id;
      cell.deathSpinAxis = this.random() * Math.PI * 2;
      if (cell.flavor === GRAY_FLAVOR) grayMagnitude += 1;
      else normalMagnitude += 1;

      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const neighbor = this.board[y + dy]?.[x + dx] ?? null;
        if (neighbor?.kind === "garbage") directGarbage.add(neighbor.groupId);
      }
    }

    // Garbage starts revealing on its own original 65-tick clock; it does not
    // wait for the neighboring block's full 90-tick death animation.
    this.markShatteringGarbage(
      directGarbage,
      now,
      now + AWAKEN_INITIAL_DELAY_MS,
      combo.id,
    );

    // Score::reportElimination gives a mixed elimination its gray value only;
    // colored magnitude is deliberately ignored when special magnitude exists.
    const base = grayMagnitude > 0
      ? baseScoreFor(grayMagnitude, true)
      : baseScoreFor(normalMagnitude);
    const priorBase = combo.baseAccumulatedScore;
    const gain = base * combo.multiplier + priorBase * multiplierIncrements;
    combo.baseAccumulatedScore += base;
    this.score += gain;
    this.scoreBacklog += gain;
    this.lastGain = gain;

    const totalMagnitude = normalMagnitude + grayMagnitude;
    const deathSparkCount = totalMagnitude + combo.multiplier - 1;
    for (const { x, y } of matches) {
      const cell = this.board[y]?.[x] ?? null;
      if (cell?.kind === "block" && cell.state === "clearing") {
        cell.deathSparkCount = deathSparkCount;
      }
    }
    this.events.push({
      type: "clear",
      magnitude: totalMagnitude,
      gray: grayMagnitude > 0,
    });

    const signAnchor = effectivePatterns[effectivePatterns.length - 1].anchor;
    // GarbageGenerator creates the sign before queueing garbage and its mote.
    // That order matters because all three consume the shared random stream.
    let moteSibling = combo.multiplier > 1 ? 1 : 0;
    if (grayMagnitude >= 3) {
      this.createRewardSign("bonus", 0, signAnchor, now);
    }
    for (let n = 0; n < Math.max(0, grayMagnitude - 2); n += 1) {
      this.emitAttack({
        height: 1,
        width: BOARD_COLUMNS,
        flavor: "gray",
        source: "clear",
        createdAt: now,
      });
      this.createRewardMote("magnitude", signAnchor, 3, now, moteSibling++);
    }
    if (normalMagnitude > 3) {
      this.createRewardSign("magnitude", normalMagnitude, signAnchor, now);
    }
    for (const attack of magnitudeAttacks(normalMagnitude, now)) {
      this.emitAttack(attack);
      this.createRewardMote(
        "magnitude",
        signAnchor,
        Math.max(0, Math.min(3, attack.width - 3)),
        now,
        moteSibling++,
      );
    }
    // The original deliberately shows no sign for an ordinary colored match
    // of three; gray matches use the special BONUS sign above.
    this.message = null;
    this.messageUntil = 0;

    this.syncChainSummary(combo);
    this.refreshPhase(now);
  }

  private finishClear(now: number): void {
    const dueBlocks: Array<{ x: number; y: number; cell: BlockCell }> = [];
    const shattering: Array<{ x: number; y: number; cell: GarbageCell }> = [];
    for (let y = 0; y < this.board.length; y += 1) {
      for (let x = 0; x < BOARD_COLUMNS; x += 1) {
        const cell = this.board[y][x];
        if (!cell) continue;
        if (
          cell.kind === "block"
          && cell.state === "clearing"
          && (cell.clearUntil ?? Number.POSITIVE_INFINITY) <= now
        ) {
          dueBlocks.push({ x, y, cell });
        } else if (
          cell.kind === "garbage"
          && cell.state === "shattering"
          && (cell.clearUntil ?? Number.POSITIVE_INFINITY) <= now
        ) {
          shattering.push({ x, y, cell });
        }
      }
    }

    if (dueBlocks.length === 0 && shattering.length === 0) {
      this.refreshPhase(now);
      return;
    }

    for (const { x, y, cell } of dueBlocks) {
          this.createBlockDeathSparks(
            x,
            y,
            cell.flavor,
            cell.deathSparkCount ?? 3,
            now,
          );
          this.board[y][x] = null;
    }

    shattering.sort((a, b) => a.y - b.y || a.x - b.x);
    if (shattering.length > 0) {
      const shatterStarted = Math.min(
        ...shattering.map(({ cell }) => cell.clearStarted ?? now),
      );
      const maxSequence = Math.max(
        shattering.length - 1,
        ...shattering.map(({ cell }, index) => cell.shatterSequence ?? index),
      );
      const releaseAt = shatterStarted
        + AWAKEN_INITIAL_DELAY_MS
        + AWAKEN_INTERNAL_DELAY_MS * maxSequence
        + AWAKEN_FINAL_DELAY_MS;
      const groups = new Map<number, typeof shattering>();
      for (const position of shattering) {
        const positions = groups.get(position.cell.groupId) ?? [];
        positions.push(position);
        groups.set(position.cell.groupId, positions);
      }
      const reformingRows = new Set<string>();
      const prepared = shattering.every(({ cell }) => (
        cell.shatterSequence !== undefined
        && (cell.shatterReforms === true || cell.shatterTargetFlavor !== undefined)
      ));
      if (prepared) {
        for (const { y, cell } of shattering) {
          if (cell.shatterReforms) reformingRows.add(`${cell.groupId}:${y}`);
        }
      } else {
        for (const [groupId, positions] of groups) {
          const minY = Math.min(...positions.map(({ y }) => y));
          const width = new Set(positions.map(({ x }) => x)).size;
          const rows = [...new Set(positions.map(({ y }) => y))].sort((a, b) => a - b);
          for (const y of rows) {
            if (
              width === BOARD_COLUMNS
              && ((y - minY) & 1) === 1
              && this.random() < GARBAGE_ROW_REFORM_CHANCE
            ) reformingRows.add(`${groupId}:${y}`);
          }
        }
      }

      const blockPositions = shattering.filter(({ y, cell }) => (
        !reformingRows.has(`${cell.groupId}:${y}`)
      ));
      const flavors = prepared ? [] : this.generateAwakeningFlavors(blockPositions);
      let flavorIndex = 0;
      const reformedGroupIds = new Map<string, number>();

      shattering.forEach(({ x, y, cell }, fallbackSequence) => {
        const sequence = cell.shatterSequence ?? fallbackSequence;
        const popDirection = cell.shatterPopDirection
          ?? this.generatePopDirection();
        const revealAt = shatterStarted
          + AWAKEN_INITIAL_DELAY_MS
          + AWAKEN_INTERNAL_DELAY_MS * sequence;
        const reformKey = `${cell.groupId}:${y}`;
        if (reformingRows.has(reformKey)) {
          const groupId = reformedGroupIds.get(reformKey) ?? this.nextGroupId++;
          reformedGroupIds.set(reformKey, groupId);
          this.board[y][x] = {
            id: this.nextId++,
            kind: "garbage",
            groupId,
            flavor: "normal",
            // GarbageFlavorImage belongs to the original shattered resident.
            // Its association is released when that shell disappears; a row
            // that reforms as new garbage must not retain or monopolize it.
            texture: null,
            state: "awakening",
            awakenRevealAt: revealAt,
            awakenReleaseAt: releaseAt,
            awakenSource: cell.flavor,
            awakenSequence: sequence,
            awakenPopDirection: popDirection,
            comboId: cell.comboId,
          };
          return;
        }

        const replacement = this.createBlock(
          cell.shatterTargetFlavor ?? flavors[flavorIndex++],
        );
        replacement.state = "awakening";
        replacement.awakenRevealAt = revealAt;
        replacement.awakenReleaseAt = releaseAt;
        replacement.awakenSource = cell.flavor;
        replacement.awakenSequence = sequence;
        replacement.awakenPopDirection = popDirection;
        replacement.awakenNotified = false;
        replacement.comboId = cell.comboId;
        this.board[y][x] = replacement;
      });
    }

    for (const { x, y, cell } of dueBlocks) {
      if (cell.comboId !== undefined) this.propagateComboAbove(x, y, cell.comboId);
    }

    const fallDuration = this.applyGravity(now);
    if (fallDuration > 0) {
      this.scheduleFall(now, fallDuration);
    } else if (now < this.backgroundSwapUntil) {
      this.backgroundFallUntil = Math.max(this.backgroundFallUntil, this.backgroundSwapUntil);
    } else {
      this.resolveMatches(now);
    }
    this.completeDormantCombos(now);
    this.refreshPhase(now);
  }

  private announceAwakeningReveals(now: number): void {
    for (const row of this.board) {
      for (const cell of row) {
        if (
          cell?.kind !== "block"
          || cell.state !== "awakening"
          || cell.awakenNotified
          || cell.awakenRevealAt === undefined
          || now < cell.awakenRevealAt
        ) continue;
        cell.awakenNotified = true;
        this.events.push({
          type: "awaken",
          flavor: cell.flavor,
          sequence: cell.awakenSequence ?? 0,
        });
      }
    }
  }

  private releaseDueAwakening(now: number): void {
    let released = false;
    for (const row of this.board) {
      for (const cell of row) {
        if (
          !cell
          || cell.state !== "awakening"
          || cell.awakenReleaseAt === undefined
          || now < cell.awakenReleaseAt
        ) continue;
        cell.state = "idle";
        released = true;
      }
    }
    if (!released) return;

    const fallDuration = this.applyGravity(now, true);
    if (fallDuration > 0) {
      this.scheduleFall(now, fallDuration);
      return;
    }
    this.resolveMatches(now);
    this.refreshPhase(now);
  }

  private hasAwakening(): boolean {
    return this.awakeningCount() > 0;
  }

  private awakeningCount(): number {
    let count = 0;
    for (const row of this.board) {
      for (const cell of row) {
        if (cell?.state === "awakening") count += 1;
      }
    }
    return count;
  }

  private nextAwakeningReleaseAt(): number | null {
    let next: number | null = null;
    for (const row of this.board) {
      for (const cell of row) {
        if (
          !cell
          || cell.state !== "awakening"
          || cell.awakenReleaseAt === undefined
        ) continue;
        next = next === null ? cell.awakenReleaseAt : Math.min(next, cell.awakenReleaseAt);
      }
    }
    return next;
  }

  private generateAwakeningFlavors(
    positions: Array<{ x: number; y: number; cell: GarbageCell }>,
  ): BlockFlavor[] {
    const result: BlockFlavor[] = [];

    for (const { x } of positions) {
      let flavor: BlockFlavor;
      do {
        flavor = this.randomNormalFlavor();
      } while (this.awakeningFlavorWouldTriple(flavor, x));

      result.push(flavor);
      this.awakeningSecondLastRow[x] = this.awakeningLastRow[x];
      this.awakeningLastRow[x] = flavor;
      this.awakeningSecondLastFlavor = this.awakeningLastFlavor;
      this.awakeningLastFlavor = flavor;
    }
    return result;
  }

  private awakeningFlavorWouldTriple(flavor: BlockFlavor, x: number): boolean {
    return (
      flavor === this.awakeningLastFlavor
      && this.awakeningLastFlavor === this.awakeningSecondLastFlavor
    ) || (
      flavor === this.awakeningLastRow[x]
      && this.awakeningLastRow[x] === this.awakeningSecondLastRow[x]
    );
  }

  private shiftTimers(duration: number): void {
    if (duration <= 0) return;
    const shiftCell = (cell: Cell | null): void => {
      if (!cell) return;
      if (cell.animationStarted !== undefined) cell.animationStarted += duration;
      if (cell.clearStarted !== undefined) cell.clearStarted += duration;
      if (cell.clearUntil !== undefined) cell.clearUntil += duration;
      if (cell.awakenRevealAt !== undefined) cell.awakenRevealAt += duration;
      if (cell.awakenReleaseAt !== undefined) cell.awakenReleaseAt += duration;
      if (cell.kind === "garbage" && cell.initialFallUntil !== undefined) {
        cell.initialFallUntil += duration;
      }
      if (cell.kind === "garbage" && cell.initialImpactAt !== undefined) {
        cell.initialImpactAt += duration;
      }
    };

    for (const row of this.board) for (const cell of row) shiftCell(cell);
    for (const cell of this.nextRow) shiftCell(cell);
    if (this.phaseUntil > 0) this.phaseUntil += duration;
    if (this.backgroundSwapStarted > 0) this.backgroundSwapStarted += duration;
    if (this.backgroundSwapUntil > 0) this.backgroundSwapUntil += duration;
    if (this.backgroundFallUntil > 0) this.backgroundFallUntil += duration;
    if (this.countdownUntil > 0) this.countdownUntil += duration;
    if (this.messageUntil > 0) this.messageUntil += duration;
    if (this.cursorMoveStarted !== null) this.cursorMoveStarted += duration;
    if (this.cursorCommandLockedUntil > 0) this.cursorCommandLockedUntil += duration;
    if (this.queuedCursorSwapReadyAt > 0) this.queuedCursorSwapReadyAt += duration;
    for (const attack of this.queuedAttacks) attack.dropAt += duration;
    for (const sign of this.rewardSigns) {
      sign.startedAt += duration;
      sign.until += duration;
    }
    for (const spark of this.deathSparks) {
      spark.startedAt += duration;
      spark.until += duration;
    }
    for (const mote of this.rewardMotes) {
      mote.startedAt += duration;
      mote.launchAt += duration;
      mote.until += duration;
    }
    for (const light of this.levelLights) {
      if (light.duration > 0) light.startedAt += duration;
    }
    this.levelLightImpactUntil = this.levelLightImpactUntil.map((until) => (
      until > 0 ? until + duration : 0
    ));
  }

  private createCombo(
    createdAt: number,
    multiplier = 1,
    baseAccumulatedScore = 0,
  ): ComboState {
    const combo: ComboState = {
      id: this.nextComboId++,
      createdAt,
      multiplier,
      baseAccumulatedScore,
    };
    this.combos.set(combo.id, combo);
    this.syncChainSummary(combo);
    return combo;
  }

  private syncChainSummary(preferred?: ComboState): void {
    const active = [...this.combos.values()];
    if (active.length === 0) {
      this.resolvingChain = false;
      this.chainDepth = 0;
      this.chainBaseScore = 0;
      return;
    }
    const selected = preferred && this.combos.has(preferred.id)
      ? preferred
      : active.reduce((best, combo) => (
        combo.multiplier > best.multiplier ? combo : best
      ));
    this.resolvingChain = true;
    this.chainDepth = selected.multiplier;
    this.chainBaseScore = selected.baseAccumulatedScore;
  }

  private startDetectedMatches(
    result: MatchResult,
    now: number,
    sharedCauseCellIds?: ReadonlySet<number>,
  ): void {
    if (result.patterns.length === 0) return;
    const grouped = new Map<string, {
      combo: ComboState | null;
      patterns: MatchPattern[];
      coordinates: Map<string, Coordinate>;
    }>();

    result.patterns.forEach((pattern, index) => {
      const comboId = pattern.coordinates
        .map(({ x, y }) => {
          const cell = this.board[y]?.[x] ?? null;
          return cell?.kind === "block" ? cell.comboId : undefined;
        })
        .find((id): id is number => id !== undefined && this.combos.has(id));
      const combo = comboId === undefined ? null : this.combos.get(comboId) ?? null;
      const causedBySharedAction = sharedCauseCellIds !== undefined
        && pattern.coordinates.some(({ x, y }) => {
          const cell = this.board[y]?.[x] ?? null;
          return cell?.kind === "block" && sharedCauseCellIds.has(cell.id);
        });
      // ComboTabulator owns one magnitude tally per simulation tick. Both
      // blocks in a swap, every newly inserted creep block, and every block
      // carrying the same active combo therefore aggregate their same-tick
      // patterns before ComboManager scores or generates garbage.
      const key = combo
        ? `combo:${combo.id}`
        : causedBySharedAction
          ? "shared-action"
          : `new:${index}`;
      const entry = grouped.get(key) ?? {
        combo,
        patterns: [],
        coordinates: new Map<string, Coordinate>(),
      };
      entry.patterns.push(pattern);
      for (const coordinate of pattern.coordinates) {
        entry.coordinates.set(coordinateKey(coordinate.x, coordinate.y), coordinate);
      }
      grouped.set(key, entry);
    });

    for (const entry of grouped.values()) {
      const coordinates = [...entry.coordinates.values()];
      if (entry.combo) {
        this.startClearForCombo(coordinates, entry.patterns, entry.combo, true, now);
      } else {
        const combo = this.createCombo(now);
        this.startClearForCombo(coordinates, entry.patterns, combo, false, now);
      }
    }
  }

  private resolveMatches(now: number, sharedCauseCellIds?: ReadonlySet<number>): void {
    // A falling block is drawn over its destination but has not joined the
    // grid there yet. Hide moving cells from detection so a settled line can
    // clear beside one without accidentally including—or waiting for—it.
    const settledBoard = this.board.map((row) => row.map((cell) => (
      this.cellIsMoving(cell, now) ? null : cell
    )));
    const matches = findMatches(settledBoard);
    const matched = new Set(
      matches.coordinates.map(({ x, y }) => coordinateKey(x, y)),
    );
    const motionPending = now < this.backgroundSwapUntil
      || now < this.backgroundFallUntil;
    if (matches.coordinates.length > 0) {
      this.startDetectedMatches(matches, now, sharedCauseCellIds);
    }

    for (let y = 0; y < this.board.length; y += 1) {
      for (let x = 0; x < BOARD_COLUMNS; x += 1) {
        const cell = this.board[y][x];
        if (!cell || cell.comboId === undefined || cell.state !== "idle") continue;
        if (
          motionPending
          || matched.has(coordinateKey(x, y))
          || this.cellIsMoving(cell, now)
        ) continue;
        delete cell.comboId;
      }
    }
    this.completeDormantCombos(now);
  }

  private propagateComboAbove(x: number, y: number, comboId: number): void {
    for (let cursorY = y + 1; cursorY < this.board.length; cursorY += 1) {
      const cell = this.board[cursorY][x];
      if (!cell || cell.state !== "idle") break;
      cell.comboId = comboId;
    }
  }

  private completeDormantCombos(now: number): void {
    if (this.combos.size === 0) return;
    const involved = new Set<number>();
    for (const row of this.board) {
      for (const cell of row) {
        if (cell?.comboId !== undefined) involved.add(cell.comboId);
      }
    }

    for (const combo of [...this.combos.values()]) {
      if (involved.has(combo.id)) continue;
      if (combo.multiplier > 1) {
        this.emitAttack({
          height: Math.min(11, combo.multiplier - 1),
          width: BOARD_COLUMNS,
          flavor: "normal",
          source: "chain",
          createdAt: now,
        });
      }
      this.combos.delete(combo.id);
      if (this.legacyComboId === combo.id) this.legacyComboId = null;
    }
    this.syncChainSummary();
  }

  private hasActiveClears(): boolean {
    for (const row of this.board) {
      for (const cell of row) {
        if (
          (cell?.kind === "block" && cell.state === "clearing")
          || (cell?.kind === "garbage" && cell.state === "shattering")
        ) return true;
      }
    }
    return false;
  }

  private nextClearDeadline(): number | null {
    let deadline: number | null = null;
    for (const row of this.board) {
      for (const cell of row) {
        const active = (cell?.kind === "block" && cell.state === "clearing")
          || (cell?.kind === "garbage" && cell.state === "shattering");
        if (!active || cell.clearUntil === undefined) continue;
        deadline = deadline === null ? cell.clearUntil : Math.min(deadline, cell.clearUntil);
      }
    }
    return deadline;
  }

  private finishDueClears(now: number): void {
    const deadline = this.nextClearDeadline();
    if (deadline !== null && deadline <= now) this.finishClear(now);
  }

  private scheduleFall(now: number, duration: number): void {
    this.backgroundFallUntil = Math.max(
      this.backgroundFallUntil,
      now + Math.max(1, duration),
    );
    this.refreshPhase(now);
  }

  private refreshPhase(now: number): void {
    // A foreground swap owns its completion callback. Garbage landing clocks
    // remain independent and are represented by the earliest active deadline.
    if (this.phase === "swapping") return;

    const garbageDeadline = this.nextGarbageLandingDeadline();
    if (garbageDeadline !== null) {
      this.phase = "garbage";
      this.phaseUntil = garbageDeadline;
      return;
    }

    const clearDeadline = this.nextClearDeadline();
    if (clearDeadline !== null) {
      this.phase = "clearing";
      this.phaseUntil = clearDeadline;
      return;
    }

    if (this.backgroundFallUntil > now) {
      this.phase = "falling";
      this.phaseUntil = this.backgroundFallUntil;
      return;
    }

    this.phase = "idle";
    this.phaseUntil = 0;
  }

  private applyGravity(now: number, noHang = false): number {
    let longestFall = 0;
    let changed = true;
    let guard = 0;

    while (changed && guard < BUFFER_ROWS) {
      guard += 1;
      changed = false;

      const groups = this.collectGarbageGroups().sort((a, b) => a.minY - b.minY);
      for (const group of groups) {
        const positions = group.positions;
        if (positions.some(({ cell }) => cell.state !== "idle")) continue;
        if (positions.some(({ cell }) => (
          cell.initialFallUntil !== undefined && cell.initialFallUntil > now
        ))) continue;
        const pendingInitialImpact = positions.some(({ cell }) => (
          cell.initialImpactAt !== undefined
        ));
        for (const position of positions) this.board[position.y][position.x] = null;

        let drop = BUFFER_ROWS;
        for (const position of positions) {
          let available = 0;
          for (let y = position.y - 1; y >= 0; y -= 1) {
            if (this.board[y][position.x]) break;
            available += 1;
          }
          drop = Math.min(drop, available);
        }

        let groupFallDuration = 0;
        for (const position of positions) {
          const targetY = position.y - drop;
          this.board[targetY][position.x] = position.cell;
          if (drop > 0) {
            groupFallDuration = Math.max(
              groupFallDuration,
              this.startFallMotion(
                position.cell,
                position.x,
                position.y,
                targetY,
                now,
                noHang,
              ),
            );
          }
        }
        if (drop > 0) {
          if (pendingInitialImpact) {
            for (const position of positions) {
              position.cell.initialImpactAt = now + groupFallDuration;
            }
          }
          longestFall = Math.max(longestFall, groupFallDuration);
          changed = true;
        }
      }

      for (let x = 0; x < BOARD_COLUMNS; x += 1) {
        for (let y = 1; y < this.board.length; y += 1) {
          const cell = this.board[y][x];
          if (!cell || cell.kind !== "block" || cell.state !== "idle") continue;
          if (now < this.backgroundSwapUntil && this.backgroundSwapCellIds.has(cell.id)) continue;
          let targetY = y;
          while (targetY > 0 && this.board[targetY - 1][x] === null) targetY -= 1;
          if (targetY !== y) {
            this.board[targetY][x] = cell;
            this.board[y][x] = null;
            longestFall = Math.max(
              longestFall,
              this.startFallMotion(cell, x, y, targetY, now, noHang),
            );
            changed = true;
          }
        }
      }
    }

    return longestFall;
  }

  private collectGarbageGroups(): Array<{
    groupId: number;
    minY: number;
    positions: Array<Coordinate & { cell: GarbageCell }>;
  }> {
    const groups = new Map<number, Array<Coordinate & { cell: GarbageCell }>>();
    for (let y = 0; y < this.board.length; y += 1) {
      for (let x = 0; x < BOARD_COLUMNS; x += 1) {
        const cell = this.board[y][x];
        if (cell?.kind !== "garbage") continue;
        const group = groups.get(cell.groupId) ?? [];
        group.push({ x, y, cell });
        groups.set(cell.groupId, group);
      }
    }
    return [...groups.entries()].map(([groupId, positions]) => ({
      groupId,
      minY: Math.min(...positions.map((position) => position.y)),
      positions,
    }));
  }

  private nextGarbageLandingDeadline(): number | null {
    let deadline: number | null = null;
    for (const group of this.collectGarbageGroups()) {
      const groupDeadline = group.positions[0]?.cell.initialFallUntil;
      if (groupDeadline === undefined) continue;
      deadline = deadline === null ? groupDeadline : Math.min(deadline, groupDeadline);
    }
    return deadline;
  }

  private markShatteringGarbage(
    direct: Set<number>,
    clearStarted: number,
    clearUntil: number,
    comboId: number,
  ): void {
    if (direct.size === 0) return;
    const groups = this.collectGarbageGroups();
    const groupById = new Map(groups.map((group) => [group.groupId, group]));
    const selected = new Set<number>(
      [...direct].filter((groupId) => (
        groupById.get(groupId)?.positions.every(({ cell }) => (
          cell.state === "idle" && !this.cellIsMoving(cell, clearStarted)
        ))
      )),
    );
    const queue = [...selected];

    while (queue.length) {
      const currentId = queue.shift() as number;
      const current = groupById.get(currentId);
      if (!current) continue;
      const currentFlavor = current.positions[0].cell.flavor;
      const occupied = new Set(
        current.positions.map((position) => coordinateKey(position.x, position.y)),
      );
      for (const candidate of groups) {
        if (selected.has(candidate.groupId)) continue;
        if (candidate.positions.some(({ cell }) => (
          cell.state !== "idle" || this.cellIsMoving(cell, clearStarted)
        ))) continue;
        // Gray shatters through touching gray garbage, while normal and gray
        // never cross-propagate. A direct elimination may seed either flavor.
        if (candidate.positions[0].cell.flavor !== currentFlavor) continue;
        const touching = candidate.positions.some(({ x, y }) =>
          [
            coordinateKey(x - 1, y),
            coordinateKey(x + 1, y),
            coordinateKey(x, y - 1),
            coordinateKey(x, y + 1),
          ].some((key) => occupied.has(key)),
        );
        if (touching) {
          selected.add(candidate.groupId);
          queue.push(candidate.groupId);
        }
      }
    }

    const selectedGroups = groups.filter((group) => selected.has(group.groupId));
    const reformingRows = new Set<string>();
    for (const group of selectedGroups) {
      const minY = Math.min(...group.positions.map(({ y }) => y));
      const width = new Set(group.positions.map(({ x }) => x)).size;
      const rows = [...new Set(group.positions.map(({ y }) => y))]
        .sort((a, b) => a - b);
      for (const y of rows) {
        if (
          width === BOARD_COLUMNS
          && ((y - minY) & 1) === 1
          && this.random() < GARBAGE_ROW_REFORM_CHANCE
        ) reformingRows.add(`${group.groupId}:${y}`);
      }
    }

    const positions = selectedGroups
      .flatMap((group) => group.positions)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const blockPositions = positions.filter(({ y, cell }) => (
      !reformingRows.has(`${cell.groupId}:${y}`)
    ));
    const flavors = this.generateAwakeningFlavors(blockPositions);
    let flavorIndex = 0;

    positions.forEach((position, sequence) => {
      const { cell, y } = position;
      if (cell.state !== "idle") return;
      const reforms = reformingRows.has(`${cell.groupId}:${y}`);
      cell.state = "shattering";
      cell.clearStarted = clearStarted;
      cell.clearUntil = clearUntil;
      cell.comboId = comboId;
      cell.shatterSequence = sequence;
      cell.shatterPopDirection = this.generatePopDirection();
      cell.shatterReforms = reforms;
      if (!reforms) cell.shatterTargetFlavor = flavors[flavorIndex++];
    });
  }

  private insertCreepRow(now: number): boolean {
    // Grid::shiftGridUp refuses the shift before mutating anything when its
    // backing row is occupied. Loss remains governed by the safe-height timer.
    if (this.board[this.board.length - 1]?.some(Boolean)) return false;
    this.board.pop();

    // Grid::shiftGridUp moves active pieces and their animations together.
    // Shifting an interpolation's origin with its logical destination avoids
    // a one-row visual jump when creep wraps during a swap or fall.
    for (let y = 0; y < this.board.length; y += 1) {
      for (let x = 0; x < BOARD_COLUMNS; x += 1) {
        const cell = this.board[y][x];
        if (
          cell
          && this.cellIsMoving(cell, now)
          && cell.animationFromY !== undefined
        ) {
          cell.animationFromY += 1;
        }
      }
    }
    const insertedRow = this.nextRow;
    const insertedBlockIds = new Set(
      insertedRow.flatMap((cell) => cell?.kind === "block" ? [cell.id] : []),
    );
    this.board.unshift(insertedRow);
    // The board and the swapper share the creep offset in the original. When
    // that offset wraps, both logical grid coordinates advance together; it
    // is not a new cursor movement and must not start a glide animation.
    this.cursorY = Math.min(BUFFER_ROWS - 1, this.cursorY + 1);
    this.cursorFromY = Math.min(BUFFER_ROWS - 1, this.cursorFromY + 1);
    this.nextRow = this.generateCreepRow();
    this.events.push({ type: "rise" });

    // Creep creates one ComboTabulator and associates all six row checks with
    // it. Independent lines made by this insertion share one magnitude tally.
    this.resolveMatches(now, insertedBlockIds);
    return true;
  }

  private dropGarbage(attack: QueuedAttack, now: number): boolean {
    const width = Math.max(1, Math.min(BOARD_COLUMNS, attack.width));
    const height = Math.max(1, Math.min(11, attack.height));

    // GarbageManager stages pieces above the current occupied ceiling. The
    // desktop grid advances a falling resident's integer row at the beginning
    // of each three-tick fall segment, so use that row rather than either the
    // browser's eventual landing reservation or its interpolated visual row.
    let occupiedCeiling = -1;
    for (let y = 0; y < this.board.length; y += 1) {
      for (let column = 0; column < BOARD_COLUMNS; column += 1) {
        const cell = this.board[y][column];
        if (!cell) continue;
        const currentY = this.motionGridY(cell, column, y, now);
        occupiedCeiling = Math.max(occupiedCeiling, currentY);
      }
    }
    const sourceBottomY = Math.max(VISIBLE_ROWS + 1, Math.floor(occupiedCeiling) + 1);
    // The original leaves its final grid row empty for the last possible creep.
    if (sourceBottomY + height > BUFFER_ROWS - 1) return false;

    const x = width === BOARD_COLUMNS
      ? 0
      : Math.floor(this.random() * (BOARD_COLUMNS - width + 1));
    let landingY = 0;
    for (let column = x; column < x + width; column += 1) {
      let columnTop = -1;
      for (let y = this.board.length - 1; y >= 0; y -= 1) {
        if (this.board[y][column]) {
          columnTop = y;
          break;
        }
      }
      landingY = Math.max(landingY, columnTop + 1);
    }
    const fallDuration = FALL_HANG_MS
      + Math.max(0, sourceBottomY - landingY) * FALL_ROW_MS;
    const initialFallUntil = now + fallDuration;

    const groupId = this.nextGroupId++;
    let texture: number | null = null;
    let decalX: number | undefined;
    let decalY: number | undefined;
    if (
      height >= 4
      && width >= 4
      && !this.garbageFlavorImageActive()
      && Math.floor(this.random() * 8) !== 0
    ) {
      decalX = 1 + Math.floor(this.random() * (width - 3));
      decalY = Math.floor(this.random() * 4) !== 0
        ? 1
        : 1 + Math.floor(this.random() * (height - 3));
      texture = Math.floor(this.random() * 4);
    }
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const cell: GarbageCell = {
          id: this.nextId++,
          kind: "garbage",
          groupId,
          flavor: attack.flavor,
          texture,
          decalX,
          decalY,
          state: "idle",
          animationFromX: x + column,
          animationFromY: sourceBottomY + row,
          animationStarted: now,
          animationDuration: fallDuration,
          animationDelay: FALL_HANG_MS,
          initialFallUntil,
        };
        this.board[landingY + row][x + column] = cell;
      }
    }
    this.refreshPhase(now);
    this.events.push({ type: "garbage" });
    return true;
  }

  private garbageFlavorImageActive(): boolean {
    return this.board.some((row) => row.some((cell) => (
      cell?.kind === "garbage" && cell.texture !== null
    )));
  }

  private emitAttack(attack: AttackPayload): void {
    if (this.attackSink) this.attackSink(attack);
    else if (this.multiplayer) this.queueOutgoingAttack(attack);
    else this.receiveAttack(attack);
  }

  private generateInitialStack(): void {
    const shortColumn = Math.floor(this.random() * BOARD_COLUMNS);
    // Grid::gameStart builds right-to-left and top-to-bottom, rejecting the
    // color directly above or to the right. Consequently the original board
    // starts without any equal orthogonal pair—not merely without triples.
    for (let x = BOARD_COLUMNS - 1; x >= 0; x -= 1) {
      const height = (x === shortColumn ? 1 : 6) + Math.floor(this.random() * 2);
      for (let y = height - 1; y >= 0; y -= 1) {
        let flavor = this.randomNormalFlavor();
        while (
          (this.board[y + 1]?.[x] as BlockCell | null)?.flavor === flavor
          || (this.board[y]?.[x + 1] as BlockCell | null)?.flavor === flavor
        ) {
          flavor = this.randomNormalFlavor();
        }
        if (y === 1) this.creepSecondLastRow[x] = flavor;
        else if (y === 0) this.creepLastRow[x] = flavor;
        this.board[y][x] = this.createBlock(flavor);
      }
    }
  }

  private generateCreepRow(): Array<Cell | null> {
    const row = emptyRow();
    // Random::chanceIn(3) makes the low third the no-special outcome.
    const specialColumn = this.random() < 1 / 3
      ? -1
      : Math.floor(this.random() * BOARD_COLUMNS);

    // BlockManager::newCreepRow generates right-to-left, and its global color
    // history crosses row boundaries in that same order.
    for (let x = BOARD_COLUMNS - 1; x >= 0; x -= 1) {
      let flavor: BlockFlavor;
      if (
        x === specialColumn
        && !this.creepFlavorWouldTriple(GRAY_FLAVOR, x)
      ) {
        flavor = GRAY_FLAVOR;
      } else {
        do {
          flavor = this.randomNormalFlavor();
        } while (this.creepFlavorWouldTriple(flavor, x));
      }

      row[x] = this.createBlock(flavor);
      this.creepSecondLastRow[x] = this.creepLastRow[x];
      this.creepLastRow[x] = flavor;
      this.creepSecondLastFlavor = this.creepLastFlavor;
      this.creepLastFlavor = flavor;
    }
    return row;
  }

  private creepFlavorWouldTriple(flavor: BlockFlavor, x: number): boolean {
    return (
      flavor === this.creepLastFlavor
      && this.creepLastFlavor === this.creepSecondLastFlavor
    ) || (
      flavor === this.creepLastRow[x]
      && this.creepLastRow[x] === this.creepSecondLastRow[x]
    );
  }

  private generatePopDirection(): number {
    this.nextPopDirection = (this.nextPopDirection + 1) & 3;
    return this.nextPopDirection;
  }

  private createBlock(flavor: BlockFlavor): BlockCell {
    return {
      id: this.nextId++,
      kind: "block",
      flavor,
      state: "idle",
    };
  }

  private randomNormalFlavor(): BlockFlavor {
    return Math.floor(this.random() * NORMAL_FLAVOR_COUNT) as BlockFlavor;
  }

  private random(): number {
    let value = this.randomState;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.randomState = value >>> 0;
    return this.randomState / 0x100000000;
  }

  private setMotion(
    cell: Cell,
    fromX: number,
    fromY: number,
    now: number,
    duration: number,
    delay = 0,
  ): void {
    cell.animationFromX = fromX;
    cell.animationFromY = fromY;
    cell.animationStarted = now;
    cell.animationDuration = duration;
    cell.animationDelay = delay;
  }

  private verticalFallDeadline(
    cell: Cell | null,
    x: number,
    targetY: number,
  ): number | null {
    if (
      cell === null
      || cell.state !== "idle"
      || cell.animationStarted === undefined
      || cell.animationDuration === undefined
      || (cell.animationFromX ?? x) !== x
      || (cell.animationFromY ?? targetY) <= targetY
    ) return null;
    return cell.animationStarted + cell.animationDuration;
  }

  private clearMotion(cell: Cell): void {
    delete cell.animationFromX;
    delete cell.animationFromY;
    delete cell.animationStarted;
    delete cell.animationDuration;
    delete cell.animationDelay;
  }

  private isVerticalFallMotion(
    cell: Cell | null,
    x: number,
    targetY: number,
    now: number,
  ): cell is Cell {
    return cell !== null
      && cell.state === "idle"
      && this.cellIsMoving(cell, now)
      && (cell.animationFromX ?? x) === x
      && (cell.animationFromY ?? targetY) > targetY;
  }

  private startFallMotion(
    cell: Cell,
    x: number,
    logicalFromY: number,
    targetY: number,
    now: number,
    noHang = false,
  ): number {
    const continuing = this.isVerticalFallMotion(cell, x, logicalFromY, now);
    const fromY = continuing
      ? this.motionYAt(cell, logicalFromY, now, false)
      : logicalFromY;
    const delay = continuing || noHang ? 0 : FALL_HANG_MS;
    const duration = Math.max(
      1,
      delay + Math.max(0, fromY - targetY) * FALL_ROW_MS,
    );
    this.setMotion(cell, x, fromY, now, duration, delay);
    return duration;
  }

  private isFallReservation(
    cell: Cell | null,
    x: number,
    y: number,
    now: number,
  ): cell is BlockCell {
    return cell?.kind === "block"
      && this.isVerticalFallMotion(cell, x, y, now);
  }

  private isOpenFallReservation(
    cell: Cell | null,
    x: number,
    y: number,
    now: number,
  ): boolean {
    if (!this.isFallReservation(cell, x, y, now)) return false;
    return this.motionGridY(cell, x, y, now, false) > y;
  }

  private motionYAt(
    cell: Cell,
    targetY: number,
    now: number,
    includeCurrentStep = true,
  ): number {
    if (
      cell.animationStarted === undefined
      || cell.animationDuration === undefined
      || now >= cell.animationStarted + cell.animationDuration
    ) return targetY;
    const raw = fallMotionProgress(
      cell,
      cell.animationFromX ?? 0,
      targetY,
      now,
      includeCurrentStep,
    ) ?? 0;
    const fromY = cell.animationFromY ?? targetY;
    return fromY + (targetY - fromY) * raw;
  }

  private motionGridY(
    cell: Cell,
    x: number,
    targetY: number,
    now: number,
    includeCurrentStep = true,
  ): number {
    if (!this.isVerticalFallMotion(cell, x, targetY, now)) return targetY;

    const started = cell.animationStarted ?? now;
    const delay = cell.animationDelay ?? 0;
    const fromY = cell.animationFromY ?? targetY;
    if (
      now < started + delay
      || (!includeCurrentStep && now <= started + delay)
    ) return Math.max(targetY, Math.ceil(fromY));

    // Block::timeStep and Garbage::timeStep move the resident into the next
    // grid row on the tick that ends the hang, before drawing the first third
    // of that row. fallMotionProgress includes that first current-tick step,
    // so flooring the visible position recovers the resident's exact row.
    return Math.max(
      targetY,
      Math.floor(
        this.motionYAt(cell, targetY, now, includeCurrentStep)
          + Number.EPSILON * 16,
      ),
    );
  }

  private fallingResidentAtGridRow(
    x: number,
    gridY: number,
    now: number,
    hangingOnly: boolean,
  ): boolean {
    if (gridY < 0 || gridY >= this.board.length) return false;
    for (let targetY = 0; targetY < this.board.length; targetY += 1) {
      const cell = this.board[targetY][x];
      if (!this.isVerticalFallMotion(cell, x, targetY, now)) continue;
      if (hangingOnly) {
        const started = cell.animationStarted ?? now;
        const delay = cell.animationDelay ?? 0;
        if (delay <= 0 || now > started + delay) continue;
      }
      if (this.motionGridY(cell, x, targetY, now, false) === gridY) return true;
    }
    return false;
  }

  private emptySwapTargetAllowed(x: number, y: number, now: number): boolean {
    return !this.fallingResidentAtGridRow(x, y - 1, now, false)
      && !this.fallingResidentAtGridRow(x, y + 1, now, true);
  }

  private openFallReservation(x: number, y: number, now: number): boolean {
    const stack: Array<{ y: number; cell: BlockCell; visualY: number }> = [];
    let cursorY = y;
    while (cursorY < this.board.length) {
      const cell = this.board[cursorY][x];
      if (
        cell?.kind !== "block"
        || !this.isFallReservation(cell, x, cursorY, now)
      ) break;
      stack.push({
        y: cursorY,
        cell,
        // Swapper runs before residents advance for this tick. Retarget from
        // the pre-step position; the new motion's current-tick lead then keeps
        // the rendered position continuous.
        visualY: this.motionYAt(cell, cursorY, now, false),
      });
      cursorY += 1;
    }
    if (stack.length === 0) return false;
    if (cursorY >= this.board.length || this.board[cursorY][x] !== null) return false;

    // Once the lowest block has crossed its new landing height, the input was
    // too late—matching the original's narrow timing window.
    if (stack.some((entry) => entry.visualY < entry.y + 1)) return false;

    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const entry = stack[index];
      this.board[entry.y + 1][x] = entry.cell;
      this.board[entry.y][x] = null;
      this.setMotion(
        entry.cell,
        x,
        entry.visualY,
        now,
        Math.max(1, (entry.visualY - (entry.y + 1)) * FALL_ROW_MS),
      );
    }
    this.backgroundFallUntil = this.latestFallDeadline(now);
    return true;
  }

  private latestFallDeadline(now: number): number {
    let deadline = 0;
    for (let y = 0; y < this.board.length; y += 1) {
      for (let x = 0; x < BOARD_COLUMNS; x += 1) {
        const cell = this.board[y][x];
        if (!this.isVerticalFallMotion(cell, x, y, now)) continue;
        deadline = Math.max(
          deadline,
          (cell.animationStarted ?? now) + (cell.animationDuration ?? 0),
        );
      }
    }
    return deadline;
  }

  private cellIsMoving(cell: Cell | null, now: number): boolean {
    return cell?.animationStarted !== undefined
      && cell.animationDuration !== undefined
      && now < cell.animationStarted + cell.animationDuration;
  }

  private cursorVisualPosition(now: number): Coordinate {
    if (this.cursorMoveStarted === null) return { x: this.cursorX, y: this.cursorY };
    const progress = Math.max(
      0,
      Math.min(1, (now - this.cursorMoveStarted) / CURSOR_MOVE_DURATION_MS),
    );
    const eased = 1 - (1 - progress) ** 2;
    return {
      x: this.cursorFromX + (this.cursorX - this.cursorFromX) * eased,
      y: this.cursorFromY + (this.cursorY - this.cursorFromY) * eased,
    };
  }

  private cursorInputLocked(now: number): boolean {
    return now < this.cursorCommandLockedUntil || this.swapInputLocked(now);
  }

  private swapInputLocked(now: number): boolean {
    return (
      (this.phase === "swapping" && now < this.phaseUntil)
      || now < this.backgroundSwapUntil
    );
  }

  private performCursorMove(dx: number, dy: number, now: number): boolean {
    const beforeX = this.cursorX;
    const beforeY = this.cursorY;
    this.moveCursorTo(this.cursorX + dx, this.cursorY + dy, now);
    if (beforeX === this.cursorX && beforeY === this.cursorY) return false;
    this.cursorCommandLockedUntil = now + CURSOR_MOVE_DURATION_MS;
    return true;
  }

  private processQueuedCursorCommand(now: number): void {
    if (this.status !== "playing" && this.status !== "countdown") return;
    if (this.cursorInputLocked(now)) return;

    if (this.queuedCursorSwap) {
      // A held countdown swap remains pending until play begins or its key /
      // pointer is released. Movement can still animate underneath the lock.
      if (
        this.status === "countdown"
        || now < this.queuedCursorSwapReadyAt
      ) return;
      this.queuedCursorSwap = false;
      this.queuedCursorSwapReadyAt = 0;
      this.queuedCursorMove = null;
      if (this.status === "playing") this.performSwap(now);
      return;
    }

    const move = this.queuedCursorMove;
    if (!move) return;
    this.queuedCursorMove = null;
    this.performCursorMove(move.x, move.y, now);
  }

  private stepDisplayedScore(): void {
    if (this.scoreFadeTicks > 0) {
      this.scoreFadeTicks -= 1;
      return;
    }
    if (this.scoreBacklog <= 0) return;

    this.scoreBacklog -= 1;
    this.previousDisplayScore = this.displayScore;
    this.displayScore += 1;
    this.scoreFadeTicks = Math.max(1, 12 - 2 * this.scoreBacklog);
    this.scoreFadeInitialTicks = this.scoreFadeTicks;
  }

  private scoreFadeTicksAt(now: number): number {
    if (this.status !== "gameover") return this.scoreFadeTicks;
    const metaTicks = Math.floor(
      Math.max(0, now - this.gameOverAt) / SIMULATION_STEP_MS,
    );
    return Math.max(0, this.scoreFadeTicks - metaTicks);
  }

  private soloHudStarVisualAt(visualNow: number): SoloHudStarVisual {
    let activeTicks = 0;
    const pausedDuringCountdown = this.status === "paused"
      && this.statusBeforePause === "countdown";
    if (this.status === "countdown" || pausedDuringCountdown) {
      const runStartedAt = this.countdownUntil - COUNTDOWN_START_DELAY_MS;
      activeTicks = Math.floor(
        Math.max(0, visualNow - runStartedAt) / SIMULATION_STEP_MS,
      );
    } else if (this.status !== "ready") {
      // The countdown consumes 149 pre-play ticks; updatePlaying owns the
      // boundary tick and every later active tick in elapsedMs.
      activeTicks = COUNTDOWN_START_DELAY_MS / SIMULATION_STEP_MS - 1
        + Math.floor(this.elapsedMs / SIMULATION_STEP_MS);
    }
    const gameOverTicks = this.status === "gameover"
      ? Math.floor(Math.max(0, visualNow - this.gameOverAt) / SIMULATION_STEP_MS)
      : null;
    return soloHudStarVisual(activeTicks, gameOverTicks);
  }

  private moveCursorTo(x: number, y: number, now: number): void {
    const targetX = Math.max(0, Math.min(BOARD_COLUMNS - 2, Math.floor(x)));
    const targetY = Math.max(0, Math.min(VISIBLE_ROWS - 1, Math.floor(y)));
    if (targetX === this.cursorX && targetY === this.cursorY) return;

    const visual = this.cursorVisualPosition(now);
    this.cursorFromX = visual.x;
    this.cursorFromY = visual.y;
    this.cursorX = targetX;
    this.cursorY = targetY;
    this.cursorMoveStarted = now;
  }

  private topOccupiedRow(now: number): number {
    let topRow = -1;
    for (let y = 0; y < this.board.length; y += 1) {
      for (let x = 0; x < BOARD_COLUMNS; x += 1) {
        const cell = this.board[y][x];
        if (!cell) continue;
        // Grid::top_effective_row ignores an incoming garbage resident until
        // its real impact. A provisional landing can be retargeted when its
        // support vanishes, in which case initialImpactAt carries that state.
        if (
          cell.kind === "garbage"
          && (
            (cell.initialFallUntil !== undefined && now < cell.initialFallUntil)
            || (cell.initialImpactAt !== undefined && now < cell.initialImpactAt)
          )
        ) continue;
        topRow = Math.max(topRow, this.motionGridY(cell, x, y, now));
      }
    }
    return topRow;
  }

  private levelLightBlendAt(index: number, now: number): number {
    const light = this.levelLights[index];
    if (!light || light.duration <= 0) return light?.to ?? 0;
    const progress = Math.max(0, Math.min(1, (now - light.startedAt) / light.duration));
    return light.from + (light.to - light.from) * progress;
  }

  private startLevelLightImpact(index: number, now: number): void {
    const remainingTicks = Math.max(
      0,
      Math.ceil((this.levelLightImpactUntil[index] - now) / SIMULATION_STEP_MS),
    );
    let flashTicks = 20;
    if (remainingTicks > 0) {
      flashTicks = remainingTicks;
      if (remainingTicks < 18) {
        flashTicks = 18 + Math.floor(2 * (1 - remainingTicks / 18));
      }
    }
    this.levelLightImpactUntil[index] = now + flashTicks * SIMULATION_STEP_MS;
  }

  private levelLightImpactFlashAt(index: number, now: number): number {
    const remaining = (this.levelLightImpactUntil[index] - now)
      / LEVEL_LIGHT_IMPACT_FLASH_MS;
    if (remaining <= 0) return 0;
    const linear = remaining > 0.9
      ? (1 - remaining) / 0.1
      : remaining / 0.9;
    return Math.max(0, Math.min(1, linear)) ** 2;
  }

  private stepDangerFlashAlarm(inDanger: boolean): void {
    if (this.dangerFlashAlarm < 0) return;
    if (this.dangerFlashAlarm > 0) {
      this.dangerFlashAlarm -= 1;
      return;
    }
    this.dangerFlashAlarm = inDanger ? LEVEL_LIGHT_DEATH_FLASH_TICKS : -1;
  }

  private dangerFlashAlarmAt(now: number): number {
    if (this.status !== "gameover" || this.dangerFlashAlarm < 0) {
      return this.dangerFlashAlarm;
    }
    // After play ends, the desktop meta loop lets the active flash finish but
    // cannot restart it because the game-play state bit is no longer present.
    const elapsedTicks = Math.floor(Math.max(0, now - this.gameOverAt) / SIMULATION_STEP_MS);
    return Math.max(-1, this.dangerFlashAlarm - elapsedTicks);
  }

  private syncLevelLights(now: number, boardNow = now): void {
    const topRow = this.topOccupiedRow(boardNow);
    for (let level = 0; level < VISIBLE_ROWS; level += 1) {
      const light = this.levelLights[level];
      const target = topRow >= level ? 1 : 0;
      if (light.to === target) continue;
      const current = this.levelLightBlendAt(level, now);
      light.from = current;
      light.to = target;
      light.startedAt = now;
      light.duration = LEVEL_LIGHT_FADE_MS * Math.abs(target - current);
    }
  }

  private sortAttackQueue(): void {
    this.queuedAttacks.sort((a, b) => a.dropAt - b.dropAt);
  }

  private anchorFor(coordinates: Coordinate[]): Coordinate {
    const meanX = coordinates.reduce((sum, coordinate) => sum + coordinate.x, 0)
      / coordinates.length;
    const meanY = coordinates.reduce((sum, coordinate) => sum + coordinate.y, 0)
      / coordinates.length;
    return coordinates.reduce((closest, coordinate) => {
      const closestDistance = (closest.x - meanX) ** 2 + (closest.y - meanY) ** 2;
      const distance = (coordinate.x - meanX) ** 2 + (coordinate.y - meanY) ** 2;
      return distance < closestDistance ? coordinate : closest;
    });
  }

  private createRewardSign(
    kind: RewardSign["kind"],
    value: number,
    anchor: Coordinate,
    now: number,
  ): void {
    if (this.rewardSigns.length >= 25) return;
    const multiplier = kind === "multiplier";
    let gridX = anchor.x + (multiplier ? 1 : 0);
    // SignManager uses the desktop grid's y coordinate, where row zero is the
    // hidden creep row represented separately by `nextRow` in this port.
    let gridY = anchor.y + 1 - (multiplier ? 1 : 0);
    const locationAvailable = (): boolean => (
      gridY > 0
      && gridX > 0
      && gridX < BOARD_COLUMNS
      && !this.rewardSigns.some((sign) => sign.gridX === gridX && sign.gridY === gridY)
    );
    if (!locationAvailable()) {
      if (multiplier) {
        if (gridX > 1) gridX -= 1;
        else gridY += 1;
      } else if (gridX < BOARD_COLUMNS - 1) {
        gridX += 1;
      } else {
        gridY += 1;
      }
    }
    while (!locationAvailable()) gridY += 1;

    const playOffsetRows = this.rise + this.impactSpringY / WORLD_UNITS_PER_ROW;
    this.rewardSigns.push({
      id: this.nextEffectId++,
      kind,
      value: kind === "bonus"
        ? 0
        : Math.max(multiplier ? 2 : 4, Math.min(12, value)),
      gridX,
      gridY,
      // The desktop offsets signs half a cell left and half a cell above the
      // selected grid point, with a +/-0.1-cell random spread (6.2 px here).
      x: gridX - 0.5,
      y: gridY - 0.5 + playOffsetRows,
      jitterX: (this.random() - 0.5) * 12.4,
      jitterY: (this.random() - 0.5) * 12.4,
      startedAt: now,
      until: now + REWARD_SIGN_LIFETIME_MS,
    });
  }

  private createBlockDeathSparks(
    x: number,
    y: number,
    flavor: BlockFlavor,
    count: number,
    now: number,
  ): void {
    const playOffsetRows = this.rise + this.impactSpringY / WORLD_UNITS_PER_ROW;
    for (let index = 0; index < count && this.deathSparks.length < 400; index += 1) {
      const speed = 0.01 + (this.random() + this.random()) * 0.0325;
      const angle = Math.PI / 4 + this.random() * Math.PI / 2;
      const rotation = Math.floor(this.random() * 360) * Math.PI / 180;
      let angularVelocity = (
        1 + (this.random() + this.random()) * 7
      ) * Math.PI / 180;
      if (this.random() < 0.5) angularVelocity = -angularVelocity;
      const sizeRoll = Math.floor(this.random() * 4);
      const size = sizeRoll === 0
        ? 0.4
        : sizeRoll === 1
          ? 0.4 + this.random() * 0.6
          : 1;
      const longLife = this.random() < 1 / 40;
      const lifeTicks = longLife
        ? Math.floor(this.random() * 500) + Math.floor(this.random() * 500) + 700
        : Math.floor(this.random() * 50) + Math.floor(this.random() * 50) + 70;
      this.deathSparks.push({
        id: this.nextEffectId++,
        flavor,
        x: x + 0.5,
        y: y + 0.5 + playOffsetRows,
        velocityX: Math.cos(angle) * speed,
        velocityY: Math.sin(angle) * speed,
        rotation,
        angularVelocity,
        size,
        startedAt: now,
        until: now + lifeTicks * SIMULATION_STEP_MS,
      });
    }
  }

  private createRewardMote(
    kind: "magnitude" | "multiplier",
    anchor: Coordinate,
    level: number,
    now: number,
    sibling: number,
  ): void {
    if (this.rewardMotes.length >= REWARD_MOTE_CAPACITY) return;
    const definition = rewardMoteDefinition(kind, level);
    const playOffsetRows = this.rise + this.impactSpringY / WORLD_UNITS_PER_ROW;
    const sourceX = anchor.x + Math.floor(this.random() * 20) / 20;
    const sourceY = anchor.y + playOffsetRows + Math.floor(this.random() * 20) / 20;
    const speed = (0.18 + this.random() * 0.04) * definition.inverseMass / 2;
    const rotation = Math.floor(this.random() * 360) * Math.PI / 180;
    let angularVelocity = (2 + this.random() * 2)
      * definition.inverseMass * Math.PI / 180;
    if (this.random() < 0.5) angularVelocity = -angularVelocity;
    const siblingDelayTicks = sibling * 25;
    const mote: RewardMote = {
      id: this.nextEffectId++,
      style: definition.style,
      colorIndex: definition.colorIndex,
      lightColorIndex: definition.lightColorIndex,
      x: sourceX,
      y: sourceY,
      velocityX: (anchor.x < BOARD_COLUMNS / 2 ? -1 : 1) * 0.707107 * speed,
      velocityY: -0.707107 * speed,
      rotation,
      initialRotation: rotation,
      angularVelocity,
      size: definition.size,
      inverseMass: definition.inverseMass,
      siblingDelayTicks,
      startedAt: now,
      launchAt: now + REWARD_MOTE_HOLD_MS
        + sibling * REWARD_MOTE_SIBLING_DELAY_MS,
      until: Number.POSITIVE_INFINITY,
    };
    mote.until = rewardMoteEndTime(mote);
    this.rewardMotes.push(mote);
  }

  private pruneEffects(now: number): void {
    this.rewardSigns = this.rewardSigns.filter((sign) => now < sign.until);
    this.deathSparks = this.deathSparks.filter((spark) => now < spark.until);
    this.rewardMotes = this.rewardMotes.filter((mote) => now < mote.until);
  }

  private finishGame(now: number): void {
    if (this.status === "gameover") return;
    this.status = "gameover";
    this.gameOverAt = now;
    this.raiseHeld = false;
    this.raiseToRowBoundary = false;
    this.concessionPending = false;
    // Score::gameFinish records only points that have rolled into Score::score.
    // Pending backlog is deliberately not awarded when play ends.
    this.score = this.displayScore;
    this.scoreBacklog = 0;
    this.queuedCursorMove = null;
    this.queuedCursorSwap = false;
    this.queuedCursorSwapReadyAt = 0;
    this.events.push({ type: "gameover" });
  }
}
