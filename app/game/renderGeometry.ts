import type { GameStatus, LoseBarState } from "./engine";

export type Vector3 = [number, number, number];
export type Color3 = [number, number, number];

export function swapMotionTransform(
  fromX: number,
  toX: number,
  progress: number,
): { x: number; rotateY: number; centerZ: number } {
  const midpoint = (fromX + toX) / 2;
  const sourceOffset = fromX - midpoint;
  const angle = Math.PI * Math.max(0, Math.min(1, progress));
  return {
    x: midpoint + sourceOffset * Math.cos(angle),
    rotateY: angle,
    // One browser cell is two original OpenGL world units.
    centerZ: -sourceOffset * 2 * Math.sin(angle),
  };
}

export const LEVEL_LIGHT_BLUE: Color3 = [0.08, 0.1, 1];
export const LEVEL_LIGHT_RED: Color3 = [1, 0.025, 0.055];
const LEVEL_LIGHT_WHITE: Color3 = [1, 1, 1];
// These are the original material colors. The light/specular profile below
// supplies the pale highlight seen across the upper third of the bar.
const LOSE_BAR_BLUE: Color3 = [0, 0, 0.8];
const LOSE_BAR_PURPLE: Color3 = [0.64, 0, 0.64];
const LOSE_BAR_RED: Color3 = [0.8, 0, 0];
const LEVEL_LIGHT_DEATH_FLASH_TICKS = 12;
const MESSAGE_PULSE_PERIOD_MS = 320 * 20;

const LOSE_BAR_TONES = [
  { position: 0, light: 0.44, specular: 0.082 },
  { position: 0.13, light: 0.58, specular: 0.408 },
  { position: 0.3, light: 0.535, specular: 0.474 },
  { position: 0.52, light: 0.66, specular: 0.263 },
  { position: 0.78, light: 0.625, specular: 0.012 },
  { position: 1, light: 0.333, specular: 0 },
] as const;

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

/** Game::sqrt's deliberately inexpensive fade curve. */
export function sourceSqrtCurve(value: number): number {
  const bounded = clamp(value);
  return ((27 / 14) - (13 / 14) * bounded) * bounded;
}

export function doubleTriangularFlash(progress: number): number {
  const phase = clamp(progress) * 4;
  return 1 - Math.abs((phase % 2) - 1);
}

export function messagePulseAlpha(elapsedMs: number): number {
  const cosine = Math.cos(
    (Math.max(0, elapsedMs) / MESSAGE_PULSE_PERIOD_MS) * Math.PI * 2,
  );
  return clamp(0.75 + 0.6 * cosine * cosine);
}

function mixColor(from: Color3, to: Color3, amount: number): Color3 {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

export function playfieldVisible(status: GameStatus): boolean {
  return status !== "ready" && status !== "paused";
}

export function swapperVisible(status: GameStatus): boolean {
  // The loss celebration redraws the final gameplay tick, including Swapper.
  // Pause and the initial key-wait screen are the only states that omit it.
  return status === "countdown" || status === "playing" || status === "gameover";
}

export interface BlockMaterialVisual {
  color: Color3;
  alpha: number;
}

export function creepRowBlockMaterial(color: Color3): BlockMaterialVisual {
  // DrawBlocks.cxx defines creep_colors as 0.25 times each normal block
  // color. The row remains fully opaque; only its diffuse material changes.
  return {
    color: [color[0] * 0.25, color[1] * 0.25, color[2] * 0.25],
    alpha: 1,
  };
}

function subtract(left: Vector3, right: Vector3): Vector3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function dot(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function normalize(vector: Vector3): Vector3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

export function levelLightColor(
  occupancy: boolean | number,
  dangerFlashAlarm: number,
  impactFlash = 0,
): Color3 {
  const blend = clamp(typeof occupancy === "boolean" ? (occupancy ? 1 : 0) : occupancy);
  const redEnergy = sourceSqrtCurve(blend);
  const blueEnergy = sourceSqrtCurve(1 - blend);
  const base: Color3 = [
    LEVEL_LIGHT_RED[0] * redEnergy + LEVEL_LIGHT_BLUE[0] * blueEnergy,
    LEVEL_LIGHT_RED[1] * redEnergy + LEVEL_LIGHT_BLUE[1] * blueEnergy,
    LEVEL_LIGHT_RED[2] * redEnergy + LEVEL_LIGHT_BLUE[2] * blueEnergy,
  ];
  let dangerFlash = 0;
  if (dangerFlashAlarm >= 0) {
    dangerFlash = dangerFlashAlarm * (2 / LEVEL_LIGHT_DEATH_FLASH_TICKS);
    if (dangerFlash > 1) dangerFlash = 2 - dangerFlash;
  }
  const whiteAmount = 1 - (1 - dangerFlash) * (1 - clamp(impactFlash));
  return mixColor(base, LEVEL_LIGHT_WHITE, whiteAmount);
}

export interface CountdownVisual {
  alpha: number;
  scale: number;
  verticalBlend: number;
}

export function countdownVisual(
  label: "1" | "2" | "3" | "GO!",
  progress: number,
): CountdownVisual {
  const elapsed = clamp(progress);
  const lambda = 1 - elapsed;
  if (label === "GO!") {
    return {
      alpha: lambda > 0.8 ? 1 : sourceSqrtCurve(lambda / 0.8),
      scale: 7,
      verticalBlend: 0,
    };
  }
  return {
    alpha: lambda,
    scale: 1 + elapsed * elapsed * 6,
    verticalBlend: lambda * lambda,
  };
}

interface LossBounceState {
  height: number;
  velocity: number;
  bounceCount: number;
}

function advanceLossBounce(state: LossBounceState): LossBounceState {
  if (state.bounceCount === 1) return state;
  let height = state.height + state.velocity;
  let velocity = state.velocity - 0.01 - 0.005 * state.velocity;
  let bounceCount = state.bounceCount;

  if (height < 0) {
    if (bounceCount === 2) {
      return { height: 0, velocity: 0, bounceCount: 1 };
    }
    height = -height;
    if (velocity > -0.1) {
      bounceCount -= 1;
      velocity = -0.1 * bounceCount * velocity;
    } else {
      velocity = -0.5 * velocity;
    }
  }
  return { height, velocity, bounceCount };
}

export function gameOverBounceHeight(elapsedMs: number): number {
  const boundedElapsed = Math.max(0, elapsedMs);
  const fullSteps = Math.floor(boundedElapsed / 20);
  const remainder = (boundedElapsed % 20) / 20;
  let state: LossBounceState = { height: 18, velocity: 0, bounceCount: 6 };
  for (let step = 0; step < fullSteps && state.bounceCount !== 1; step += 1) {
    state = advanceLossBounce(state);
  }
  if (state.bounceCount === 1 || remainder === 0) return state.height;
  const next = advanceLossBounce(state);
  return state.height + (next.height - state.height) * remainder;
}

export function gameOverCenterY(
  elapsedMs: number,
  playfieldTop: number,
  playfieldHeight: number,
  pixelsPerWorldUnit: number,
): number {
  // DrawMessages.cxx settles the loss message halfway up the safe playfield.
  const settledCenterY = playfieldTop + playfieldHeight / 2;
  return settledCenterY - gameOverBounceHeight(elapsedMs) * pixelsPerWorldUnit;
}

export interface GarbageShatterVisual {
  flash: number;
  clipMinY: number | null;
}

export function garbageShatterVisual(
  progress: number,
  heightCells: number,
): GarbageShatterVisual {
  const boundedProgress = clamp(progress);
  const flashFraction = 12 / 65;
  if (boundedProgress < flashFraction) {
    // The original runs two triangular white flashes during its first twelve
    // 50 Hz ticks, then switches to a moving OpenGL clip plane.
    return {
      flash: doubleTriangularFlash(boundedProgress / flashFraction),
      clipMinY: null,
    };
  }

  const clipProgress = (boundedProgress - flashFraction) / (1 - flashFraction);
  const halfHeight = Math.max(1, heightCells);
  return {
    flash: 0,
    clipMinY: -halfHeight + 2 * halfHeight * clipProgress,
  };
}

export interface RetainedGarbageVisual {
  sectionCompression: number;
  shellVisible: boolean;
  shellClipMinY: number | null;
}

export function retainedGarbageVisual(
  now: number,
  releaseAt: number,
  heightCells: number,
  finalDelayMs = 1000,
): RetainedGarbageVisual {
  const duration = Math.max(1, finalDelayMs);
  const remaining = releaseAt - now;
  const sectionCompression = clamp((duration - remaining) / duration);
  const shellDuration = duration / 4;
  if (remaining > shellDuration) {
    return {
      sectionCompression,
      shellVisible: false,
      shellClipMinY: null,
    };
  }

  const halfHeight = Math.max(1, heightCells);
  const shellProgress = clamp((shellDuration - remaining) / shellDuration);
  return {
    sectionCompression,
    shellVisible: true,
    // The original reverses the shatter clip plane: the shell closes from its
    // top edge down over the cubes during the final quarter of the delay.
    shellClipMinY: halfHeight - 2 * halfHeight * shellProgress,
  };
}

export interface GameOverMaskBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function gameOverMaskBounds(
  boardX: number,
  boardTop: number,
  boardWidth: number,
  boardHeight: number,
  cellSize: number,
): GameOverMaskBounds {
  // Garbage depth and the swapper project beyond the nominal six-column
  // rectangle. Cover that complete projected fringe when the board blacks out.
  const margin = cellSize / 2;
  return {
    x: boardX - margin,
    y: boardTop - margin,
    width: boardWidth + margin * 2,
    height: boardHeight + margin * 2,
  };
}

export function levelLightScreenY(
  level: number,
  boardBottom: number,
  cellSize: number,
): number {
  // Crack Attack places light n at the upper boundary of its corresponding
  // occupied row. The browser engine omits the original hidden creep row, so
  // internal level n maps directly to the top edge of internal row n.
  return boardBottom - (level + 1) * cellSize;
}

export interface LoseBarVisual {
  phase: "safe" | "warning" | "critical";
  progress: number;
  leading: Color3;
  trailing: Color3;
}

export function formatSoloScore(score: number): string {
  return Math.max(0, Math.floor(score)).toString().padStart(4, "0").slice(-7);
}

export interface ScoreDigitTransition {
  current: string;
  previous: string;
  progress: number;
}

export function scoreDigitTransition(
  currentScore: number,
  previousScore: number,
  progress: number,
): ScoreDigitTransition {
  let current = formatSoloScore(currentScore);
  let previous = formatSoloScore(previousScore);
  const width = Math.max(current.length, previous.length);
  current = current.padStart(width, "0");
  previous = previous.padStart(width, "0");
  return { current, previous, progress: clamp(progress) };
}

export interface LoseBarTone {
  light: number;
  specular: number;
}

export function loseBarToneAt(verticalPosition: number): LoseBarTone {
  const position = clamp(verticalPosition);
  const upperIndex = LOSE_BAR_TONES.findIndex((tone) => tone.position >= position);
  if (upperIndex <= 0) {
    const tone = LOSE_BAR_TONES[0];
    return { light: tone.light, specular: tone.specular };
  }
  const upper = LOSE_BAR_TONES[upperIndex];
  const lower = LOSE_BAR_TONES[upperIndex - 1];
  const amount = (position - lower.position) / (upper.position - lower.position);
  return {
    light: lower.light + (upper.light - lower.light) * amount,
    specular: lower.specular + (upper.specular - lower.specular) * amount,
  };
}

export function loseBarVisual(
  danger: number | LoseBarState,
  lossDelayMs = 7000,
  highAlertMs = lossDelayMs - 1000,
): LoseBarVisual {
  if (typeof danger !== "number") {
    const progress = clamp(danger.progress);
    const fade = clamp(danger.fade);
    switch (danger.phase) {
      case "low":
        return {
          phase: "warning",
          progress,
          leading: LOSE_BAR_PURPLE,
          trailing: LOSE_BAR_BLUE,
        };
      case "high":
        return {
          phase: "critical",
          progress,
          leading: LOSE_BAR_RED,
          trailing: LOSE_BAR_PURPLE,
        };
      case "fade-low":
        return {
          phase: "warning",
          progress,
          leading: mixColor(LOSE_BAR_BLUE, LOSE_BAR_PURPLE, fade),
          trailing: LOSE_BAR_BLUE,
        };
      case "fade-high":
        return {
          phase: "critical",
          progress,
          leading: mixColor(LOSE_BAR_BLUE, LOSE_BAR_RED, fade),
          trailing: mixColor(LOSE_BAR_BLUE, LOSE_BAR_PURPLE, fade),
        };
      case "reset-high":
        return {
          phase: "critical",
          progress,
          leading: mixColor(LOSE_BAR_PURPLE, LOSE_BAR_RED, fade),
          trailing: LOSE_BAR_PURPLE,
        };
      default:
        return {
          phase: "safe",
          progress: 0,
          leading: LOSE_BAR_BLUE,
          trailing: LOSE_BAR_BLUE,
        };
    }
  }
  const dangerMs = danger;
  const highAlertBoundaryMs = clamp(highAlertMs, 0, lossDelayMs);
  if (dangerMs <= 0) {
    return {
      phase: "safe",
      progress: 0,
      leading: LOSE_BAR_BLUE,
      trailing: LOSE_BAR_BLUE,
    };
  }
  if (dangerMs < highAlertBoundaryMs) {
    return {
      phase: "warning",
      progress: clamp(dangerMs / highAlertBoundaryMs),
      leading: LOSE_BAR_PURPLE,
      trailing: LOSE_BAR_BLUE,
    };
  }
  return {
    phase: "critical",
    progress: clamp(
      (dangerMs - highAlertBoundaryMs) / (lossDelayMs - highAlertBoundaryMs),
    ),
    leading: LOSE_BAR_RED,
    trailing: LOSE_BAR_PURPLE,
  };
}

export interface GarbageMeshFace {
  points: Vector3[];
  normals: Vector3[];
  normal: Vector3;
}

export interface GarbageMesh {
  faces: GarbageMeshFace[];
  frontRing: Vector3[];
  frontDepth: number;
}

function orientedGarbageFace(
  points: Vector3[],
  normals: Vector3[],
  outward: Vector3,
): GarbageMeshFace {
  let ordered = [...points];
  let orderedNormals = [...normals];
  let normal = normalize(cross(subtract(ordered[1], ordered[0]), subtract(ordered[2], ordered[0])));
  if (dot(normal, outward) < 0) {
    ordered = ordered.reverse();
    orderedNormals = orderedNormals.reverse();
    normal = normalize(cross(subtract(ordered[1], ordered[0]), subtract(ordered[2], ordered[0])));
  }
  return { points: ordered, normals: orderedNormals, normal };
}

const GARBAGE_BEVEL = 0.2;
const garbageMeshCache = new Map<string, GarbageMesh>();

export function createGarbageMesh(widthCells: number, heightCells: number): GarbageMesh {
  const width = Math.max(1, Math.round(widthCells));
  const height = Math.max(1, Math.round(heightCells));
  const cacheKey = `${width}x${height}`;
  const cached = garbageMeshCache.get(cacheKey);
  if (cached) return cached;

  // Crack Attack's original garbage display lists use planes at +/-1.0 and
  // begin every bevel at +/-0.8.  The bevel normals transition between the
  // two adjoining axial normals, producing the narrow highlight without the
  // inflated, rounded silhouette of a conventional bevelled box.
  const halfWidth = width;
  const halfHeight = height;
  const halfDepth = 1;
  const innerWidth = halfWidth - GARBAGE_BEVEL;
  const innerHeight = halfHeight - GARBAGE_BEVEL;
  const innerDepth = halfDepth - GARBAGE_BEVEL;
  const faces: GarbageMeshFace[] = [];
  const addFace = (points: Vector3[], normals: Vector3[], outward: Vector3) => {
    faces.push(orientedGarbageFace(points, normals, outward));
  };
  const constantNormals = (normal: Vector3, count = 4): Vector3[] => (
    Array.from({ length: count }, () => normal)
  );

  // Six un-bevelled planes.
  addFace(
    [
      [-innerWidth, -innerHeight, halfDepth],
      [innerWidth, -innerHeight, halfDepth],
      [innerWidth, innerHeight, halfDepth],
      [-innerWidth, innerHeight, halfDepth],
    ],
    constantNormals([0, 0, 1]),
    [0, 0, 1],
  );
  addFace(
    [
      [-innerWidth, -innerHeight, -halfDepth],
      [-innerWidth, innerHeight, -halfDepth],
      [innerWidth, innerHeight, -halfDepth],
      [innerWidth, -innerHeight, -halfDepth],
    ],
    constantNormals([0, 0, -1]),
    [0, 0, -1],
  );
  addFace(
    [
      [-innerWidth, halfHeight, -innerDepth],
      [-innerWidth, halfHeight, innerDepth],
      [innerWidth, halfHeight, innerDepth],
      [innerWidth, halfHeight, -innerDepth],
    ],
    constantNormals([0, 1, 0]),
    [0, 1, 0],
  );
  addFace(
    [
      [-innerWidth, -halfHeight, -innerDepth],
      [innerWidth, -halfHeight, -innerDepth],
      [innerWidth, -halfHeight, innerDepth],
      [-innerWidth, -halfHeight, innerDepth],
    ],
    constantNormals([0, -1, 0]),
    [0, -1, 0],
  );
  addFace(
    [
      [halfWidth, -innerHeight, -innerDepth],
      [halfWidth, innerHeight, -innerDepth],
      [halfWidth, innerHeight, innerDepth],
      [halfWidth, -innerHeight, innerDepth],
    ],
    constantNormals([1, 0, 0]),
    [1, 0, 0],
  );
  addFace(
    [
      [-halfWidth, -innerHeight, -innerDepth],
      [-halfWidth, -innerHeight, innerDepth],
      [-halfWidth, innerHeight, innerDepth],
      [-halfWidth, innerHeight, -innerDepth],
    ],
    constantNormals([-1, 0, 0]),
    [-1, 0, 0],
  );

  // Twelve edge bevels. The per-vertex axial normals are intentional and
  // mirror the original GL triangle strips rather than using one diagonal
  // normal for the entire chamfer.
  for (const sideY of [-1, 1] as const) {
    for (const sideZ of [-1, 1] as const) {
      const normalY: Vector3 = [0, sideY, 0];
      const normalZ: Vector3 = [0, 0, sideZ];
      addFace(
        [
          [-innerWidth, sideY * innerHeight, sideZ * halfDepth],
          [innerWidth, sideY * innerHeight, sideZ * halfDepth],
          [innerWidth, sideY * halfHeight, sideZ * innerDepth],
          [-innerWidth, sideY * halfHeight, sideZ * innerDepth],
        ],
        [normalZ, normalZ, normalY, normalY],
        [0, sideY, sideZ],
      );
    }
  }
  for (const sideX of [-1, 1] as const) {
    for (const sideZ of [-1, 1] as const) {
      const normalX: Vector3 = [sideX, 0, 0];
      const normalZ: Vector3 = [0, 0, sideZ];
      addFace(
        [
          [sideX * innerWidth, -innerHeight, sideZ * halfDepth],
          [sideX * innerWidth, innerHeight, sideZ * halfDepth],
          [sideX * halfWidth, innerHeight, sideZ * innerDepth],
          [sideX * halfWidth, -innerHeight, sideZ * innerDepth],
        ],
        [normalZ, normalZ, normalX, normalX],
        [sideX, 0, sideZ],
      );
    }
  }
  for (const sideX of [-1, 1] as const) {
    for (const sideY of [-1, 1] as const) {
      const normalX: Vector3 = [sideX, 0, 0];
      const normalY: Vector3 = [0, sideY, 0];
      addFace(
        [
          [sideX * halfWidth, sideY * innerHeight, -innerDepth],
          [sideX * halfWidth, sideY * innerHeight, innerDepth],
          [sideX * innerWidth, sideY * halfHeight, innerDepth],
          [sideX * innerWidth, sideY * halfHeight, -innerDepth],
        ],
        [normalX, normalX, normalY, normalY],
        [sideX, sideY, 0],
      );
    }
  }

  // Eight triangular corner caps complete the same hard three-way chamfer.
  for (const sideX of [-1, 1] as const) {
    for (const sideY of [-1, 1] as const) {
      for (const sideZ of [-1, 1] as const) {
        const normalX: Vector3 = [sideX, 0, 0];
        const normalY: Vector3 = [0, sideY, 0];
        const normalZ: Vector3 = [0, 0, sideZ];
        addFace(
          [
            [sideX * innerWidth, sideY * innerHeight, sideZ * halfDepth],
            [sideX * halfWidth, sideY * innerHeight, sideZ * innerDepth],
            [sideX * innerWidth, sideY * halfHeight, sideZ * innerDepth],
          ],
          [normalZ, normalX, normalY],
          [sideX, sideY, sideZ],
        );
      }
    }
  }

  const frontRing: Vector3[] = [
    [-innerWidth, -innerHeight, halfDepth],
    [innerWidth, -innerHeight, halfDepth],
    [innerWidth, innerHeight, halfDepth],
    [-innerWidth, innerHeight, halfDepth],
  ];
  const mesh = { faces, frontRing, frontDepth: halfDepth };
  garbageMeshCache.set(cacheKey, mesh);
  return mesh;
}
