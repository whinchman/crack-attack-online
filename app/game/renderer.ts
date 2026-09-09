/*
 * Crack Attack! browser port — original-style Canvas renderer
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {
  AWAKEN_FINAL_DELAY_MS,
  AWAKEN_INITIAL_DELAY_MS,
  AWAKEN_INTERNAL_DELAY_MS,
  AWAKEN_POP_DURATION_MS,
  BOARD_COLUMNS,
  GAME_OVER_BOARD_FADE_MS,
  REWARD_MOTE_PALETTE,
  VISIBLE_ROWS,
  deathSparkVisualAt,
  fallMotionProgress,
  rewardMoteVisualAt,
  rewardSignVisualAt,
  type BlockCell,
  type Cell,
  type DeathSpark,
  type GameSnapshot,
  type GarbageCell,
  type LoseBarState,
  type RewardMote,
  type RewardSign,
  type SparkleStyle,
} from "./engine.ts";
import {
  BlockWebGLLayer,
  moteLightCenterFade,
  type WebGLLightBounds,
  type WebGLPointLight,
} from "./blockWebGL.ts";
import { scoreToBeat } from "./highScore.ts";
import {
  creepRowBlockMaterial,
  countdownVisual,
  createGarbageMesh,
  doubleTriangularFlash,
  gameOverMaskBounds,
  gameOverCenterY,
  garbageShatterVisual,
  levelLightColor,
  levelLightScreenY,
  loseBarToneAt,
  loseBarVisual,
  messagePulseAlpha,
  playfieldVisible,
  retainedGarbageVisual,
  scoreDigitTransition,
  swapMotionTransform,
  swapperVisible,
  type Color3,
  type GarbageMesh,
} from "./renderGeometry.ts";
import {
  ORIGINAL_CAMERA_DISTANCE,
  ORIGINAL_LIGHT_POSITION,
  projectWorldPoint,
  screenCenterToWorld,
  type Vector3,
} from "./worldView.ts";

export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 800;
export const BOARD_X = 340;
export const BOARD_TOP = 38;
export const CELL_SIZE = 62;
export const BOARD_WIDTH = CELL_SIZE * BOARD_COLUMNS;
export const BOARD_HEIGHT = CELL_SIZE * VISIBLE_ROWS;
export const BOARD_BOTTOM = BOARD_TOP + BOARD_HEIGHT;

type Triangle3 = [Vector3, Vector3, Vector3];

export interface MeshFace {
  vertices: [number, number, number];
  normals: [number, number, number];
}

export interface BlockMesh {
  vertices: Vector3[];
  normals: Vector3[];
  faces: MeshFace[];
}

export interface RenderAssets {
  logo: HTMLImageElement | null;
  garbage: Array<HTMLImageElement | null>;
  font: HTMLImageElement | null;
  fontUi: HTMLImageElement | null;
  messageAnyKey: HTMLImageElement | null;
  messageTapScreen: HTMLImageElement | null;
  messagePaused: HTMLImageElement | null;
  messageGameOver: HTMLImageElement | null;
  countdown: Record<"1" | "2" | "3" | "GO!", HTMLImageElement | null>;
  bonusSign: HTMLImageElement | null;
  magnitudeSigns: Array<HTMLImageElement | null>;
  multiplierSigns: Array<HTMLImageElement | null>;
  blockMesh: BlockMesh | null;
}

const BLOCK_COLORS: Color3[] = [
  [0.73, 0, 0.73],
  [0.2, 0.2, 0.8],
  [0, 0.6, 0.05],
  [0.85, 0.85, 0],
  [1, 0.4, 0],
  [0.4, 0.4, 0.4],
];
const CREEP_ROW_BLOCK_MATERIALS = BLOCK_COLORS.map(creepRowBlockMaterial);

const GARBAGE_COLORS: Record<"normal" | "gray", Color3> = {
  normal: [1, 0, 0],
  gray: [0.4, 0.4, 0.4],
};
const HUD_STAR_COLOR: Color3 = [0.4, 0.4, 0.7];
const WHITE_STAR_COLOR: Color3 = [1, 1, 1];

const BLOCK_MESH_SIZE = CELL_SIZE * (42 / 52);
const DYING_FLASH_FRACTION = 12 / 90;
const DYING_ROTATIONS = (1216.8 / 180) * Math.PI;
const WORLD_UNITS_PER_PIXEL = 2 / CELL_SIZE;
const VIEW_CENTER_X = BOARD_X + BOARD_WIDTH / 2;
const VIEW_CENTER_Y = BOARD_BOTTOM - 4 * CELL_SIZE;

let frameCanvas: HTMLCanvasElement | null = null;
let frameContext: CanvasRenderingContext2D | null = null;
let blockWebGLLayer: BlockWebGLLayer | null = null;
let blockWebGLAttempted = false;
const sparkleTextureCache = new Map<string, HTMLCanvasElement>();
const MAX_SPARKLE_TEXTURE_CACHE = 96;
const DEATH_SPARK_SHADOW_THRESHOLD = 72;

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function easeOutCubic(value: number): number {
  return 1 - (1 - value) ** 3;
}

function mixColor(from: Color3, to: Color3, amount: number): Color3 {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

function colorToCss(color: Color3, light = 1, specular = 0): string {
  const red = Math.round(clamp(color[0] * light + specular) * 255);
  const green = Math.round(clamp(color[1] * light + specular) * 255);
  const blue = Math.round(clamp(color[2] * light + specular) * 255);
  return `rgb(${red} ${green} ${blue})`;
}

const DEATH_SPARK_SHADOW_COLORS = BLOCK_COLORS.map((color) => (
  colorToCss(mixColor(color, [1, 1, 1], 0.45))
));

function normalize(vector: Vector3): Vector3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function rotateVector(
  vector: Vector3,
  rotateX: number,
  rotateY: number,
  rotateZ: number,
): Vector3 {
  const [initialX, initialY, initialZ] = vector;
  const cosX = Math.cos(rotateX);
  const sinX = Math.sin(rotateX);
  const yAfterX = initialY * cosX - initialZ * sinX;
  const zAfterX = initialY * sinX + initialZ * cosX;

  const cosY = Math.cos(rotateY);
  const sinY = Math.sin(rotateY);
  const xAfterY = initialX * cosY + zAfterX * sinY;
  const zAfterY = -initialX * sinY + zAfterX * cosY;

  const cosZ = Math.cos(rotateZ);
  const sinZ = Math.sin(rotateZ);
  return [
    xAfterY * cosZ - yAfterX * sinZ,
    xAfterY * sinZ + yAfterX * cosZ,
    zAfterY,
  ];
}

function rotateAroundAxis(vector: Vector3, axis: Vector3, angle: number): Vector3 {
  const [axisX, axisY, axisZ] = normalize(axis);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dot = vector[0] * axisX + vector[1] * axisY + vector[2] * axisZ;
  return [
    vector[0] * cosine
      + (axisY * vector[2] - axisZ * vector[1]) * sine
      + axisX * dot * (1 - cosine),
    vector[1] * cosine
      + (axisZ * vector[0] - axisX * vector[2]) * sine
      + axisY * dot * (1 - cosine),
    vector[2] * cosine
      + (axisX * vector[1] - axisY * vector[0]) * sine
      + axisZ * dot * (1 - cosine),
  ];
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

interface FixedFunctionTone {
  diffuse: Color3;
  specular: Color3;
  level: number;
}

function pointLightTone(
  normal: Vector3,
  point: Vector3,
  lightPosition: Vector3,
): { diffuse: number; specular: number } {
  const lightDirection = normalize(subtract(lightPosition, point));
  // GL_LIGHT_MODEL_LOCAL_VIEWER is false by default in the original, so the
  // fixed-function pipeline uses an infinite viewer along +Z.
  const halfDirection = normalize([
    lightDirection[0],
    lightDirection[1],
    lightDirection[2] + 1,
  ]);
  const light = Math.max(0, normal[0] * lightDirection[0]
    + normal[1] * lightDirection[1]
    + normal[2] * lightDirection[2]);
  const halfLight = Math.max(0, normal[0] * halfDirection[0]
    + normal[1] * halfDirection[1]
    + normal[2] * halfDirection[2]);
  const specular = light > 0 ? 0.5 * Math.pow(halfLight, 10) : 0;
  return { diffuse: light, specular };
}

function fixedFunctionVertexTone(
  normal: Vector3,
  point: Vector3,
  moteLights: WebGLPointLight[] = [],
  lightBounds: WebGLLightBounds = [point[0], point[1], point[0], point[1]],
  quadraticAttenuation = 0,
  headlightLevel = 1,
): FixedFunctionTone {
  const headlight = pointLightTone(normal, point, ORIGINAL_LIGHT_POSITION);
  const diffuse: Color3 = [
    headlight.diffuse * headlightLevel,
    headlight.diffuse * headlightLevel,
    headlight.diffuse * headlightLevel,
  ];
  const specular: Color3 = [
    headlight.specular * headlightLevel,
    headlight.specular * headlightLevel,
    headlight.specular * headlightLevel,
  ];
  const activeLights = moteLights
    .filter((light) => moteLightCenterFade(light.position, lightBounds) > 0)
    .slice(0, 7);

  for (const light of activeLights) {
    const centerFade = moteLightCenterFade(light.position, lightBounds);
    const distanceSquared = (light.position[0] - point[0]) ** 2
      + (light.position[1] - point[1]) ** 2
      + (light.position[2] - point[2]) ** 2;
    const attenuation = 1 / (1 + quadraticAttenuation * distanceSquared);
    const tone = pointLightTone(normal, point, light.position);
    for (let channel = 0; channel < 3; channel += 1) {
      const energy = light.color[channel] * centerFade * attenuation;
      diffuse[channel] += tone.diffuse * energy;
      specular[channel] += tone.specular * energy;
    }
  }

  return {
    diffuse,
    specular,
    level: (
      diffuse[0] + specular[0]
      + diffuse[1] + specular[1]
      + diffuse[2] + specular[2]
    ) / 3,
  };
}

function fixedFunctionColor(
  color: Color3,
  tone: FixedFunctionTone,
  diffuseFloor = 0,
): string {
  const diffuseScale = 1 - diffuseFloor;
  const channels = color.map((channel, index) => clamp(
    channel * (diffuseFloor + tone.diffuse[index] * diffuseScale)
      + tone.specular[index],
  ));
  return `rgb(${channels.map((channel) => Math.round(channel * 255)).join(" ")})`;
}

function averageFixedFunctionTone(tones: FixedFunctionTone[]): FixedFunctionTone {
  const count = Math.max(1, tones.length);
  const diffuse: Color3 = [0, 0, 0];
  const specular: Color3 = [0, 0, 0];
  let level = 0;
  for (const tone of tones) {
    for (let channel = 0; channel < 3; channel += 1) {
      diffuse[channel] += tone.diffuse[channel] / count;
      specular[channel] += tone.specular[channel] / count;
    }
    level += tone.level / count;
  }
  return { diffuse, specular, level };
}

function rewardMotePointLights(snapshot: GameSnapshot, now: number): WebGLPointLight[] {
  const lights: WebGLPointLight[] = [];
  for (const mote of snapshot.rewardMotes) {
    const visual = rewardMoteVisualAt(mote, now);
    if (!visual.active || visual.lightBrightness <= 0) continue;
    const screenX = BOARD_X + visual.x * CELL_SIZE;
    const screenY = BOARD_BOTTOM - visual.y * CELL_SIZE;
    const world = screenCenterToWorld(
      screenX,
      screenY,
      VIEW_CENTER_X,
      VIEW_CENTER_Y,
      WORLD_UNITS_PER_PIXEL,
    );
    lights.push({
      position: [world[0], world[1], -ORIGINAL_CAMERA_DISTANCE + 3],
      color: [
        visual.lightColor[0] * visual.lightBrightness,
        visual.lightColor[1] * visual.lightBrightness,
        visual.lightColor[2] * visual.lightBrightness,
      ],
    });
  }
  return lights;
}

function garbageLightBounds(
  worldCenter: Vector3,
  widthCells: number,
  heightCells: number,
): WebGLLightBounds {
  return [
    worldCenter[0] - (widthCells - 1),
    worldCenter[1] - (heightCells - 1),
    worldCenter[0] + (widthCells - 1),
    worldCenter[1] + (heightCells - 1),
  ];
}

function getBlockWebGLLayer(): BlockWebGLLayer | null {
  if (blockWebGLAttempted) return blockWebGLLayer;
  blockWebGLAttempted = true;
  if (typeof document === "undefined") return null;
  try {
    blockWebGLLayer = new BlockWebGLLayer(
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
      VIEW_CENTER_X,
      VIEW_CENTER_Y,
      1 / WORLD_UNITS_PER_PIXEL,
      ORIGINAL_CAMERA_DISTANCE,
      ORIGINAL_LIGHT_POSITION,
    );
  } catch {
    blockWebGLLayer = null;
  }
  return blockWebGLLayer;
}

export async function loadBlockMesh(source: string): Promise<BlockMesh> {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Unable to load block mesh: ${response.status}`);
  const vertices: Vector3[] = [];
  const normals: Vector3[] = [];
  const faces: MeshFace[] = [];

  for (const rawLine of (await response.text()).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("v ")) {
      const values = line.slice(2).trim().split(/\s+/).map(Number);
      vertices.push([values[0], values[1], values[2]]);
    } else if (line.startsWith("vn ")) {
      const values = line.slice(3).trim().split(/\s+/).map(Number);
      normals.push(normalize([values[0], values[1], values[2]]));
    } else if (line.startsWith("f ")) {
      const points = line.slice(2).trim().split(/\s+/).map((token) => {
        const [vertex, , normal] = token.split("/");
        return { vertex: Number(vertex) - 1, normal: Number(normal) - 1 };
      });
      if (points.length === 3) {
        faces.push({
          vertices: [points[0].vertex, points[1].vertex, points[2].vertex],
          normals: [points[0].normal, points[1].normal, points[2].normal],
        });
      }
    }
  }

  if (vertices.length === 0 || normals.length === 0 || faces.length === 0) {
    throw new Error("The original block mesh was empty or malformed.");
  }
  return { vertices, normals, faces };
}

interface MotionPosition {
  x: number;
  y: number;
  rotateY: number;
  centerZ: number;
}

function motionPosition(
  cell: Cell,
  x: number,
  y: number,
  now: number,
): MotionPosition {
  if (
    cell.animationStarted === undefined
    || cell.animationDuration === undefined
    || now >= cell.animationStarted + cell.animationDuration
  ) return { x, y, rotateY: 0, centerZ: 0 };

  const delay = cell.animationDelay ?? 0;
  const travelDuration = Math.max(1, cell.animationDuration - delay);
  const fromX = cell.animationFromX ?? x;
  const fromY = cell.animationFromY ?? y;
  const verticalFall = fromX === x && fromY > y && cell.state === "idle";
  const rawProgress = verticalFall
    ? fallMotionProgress(cell, x, y, now) ?? 0
    : clamp((now - cell.animationStarted - delay) / travelDuration);
  const horizontalSwap = fromX !== x && fromY === y && cell.state === "idle";
  if (horizontalSwap) {
    // DrawBlocks.cxx rotates both residents 180 degrees around their shared
    // midpoint. The left resident arcs toward the camera while the right one
    // arcs away, so the swap is an orbit/flip rather than a flat translation.
    const transform = swapMotionTransform(fromX, x, rawProgress);
    return {
      x: transform.x,
      y,
      rotateY: transform.rotateY,
      centerZ: transform.centerZ,
    };
  }
  // Original Crack Attack falling advances at a constant per-tick velocity;
  // retain easing for any other non-fall motion.
  const progress = verticalFall ? rawProgress : easeOutCubic(rawProgress);
  return {
    x: fromX + (x - fromX) * progress,
    y: fromY + (y - fromY) * progress,
    rotateY: 0,
    centerZ: 0,
  };
}

function logicalToScreen(x: number, y: number, rise: number): { x: number; y: number } {
  return {
    x: BOARD_X + x * CELL_SIZE,
    y: BOARD_BOTTOM - (y + 1 + rise) * CELL_SIZE,
  };
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2));
}

function drawBackdrop(context: CanvasRenderingContext2D): void {
  context.fillStyle = "#000000";
  context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  const vignette = context.createRadialGradient(560, 480, 120, 480, 420, 620);
  vignette.addColorStop(0, "rgba(18, 16, 38, .12)");
  vignette.addColorStop(0.65, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, .6)");
  context.fillStyle = vignette;
  context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
}

function imageReady(image: HTMLImageElement | null): image is HTMLImageElement {
  return Boolean(image?.complete && image.naturalWidth > 0);
}

function sparkleSample(
  style: SparkleStyle,
  initialX: number,
  initialY: number,
): { luminance: number; alpha: number } {
  const radiusFloor = 0.0001;
  let radius = Math.max(radiusFloor, Math.hypot(initialX, initialY));
  let angle = Math.atan2(initialY, initialX);
  let luminance = 0;
  let extra = 0;
  const starTerm = (power: number, multiplier = 2.5): number => (
    1 - multiplier * Math.abs(
      radius ** power * Math.cos(angle) ** 2
      - radius ** power * Math.sin(angle) ** 2
    )
  );

  if (style === "four") {
    luminance = 0.3
      * (1 - 2.5 * Math.abs(initialX ** 2 - initialY ** 2))
      * Math.exp(-(radius ** 2)) / Math.sqrt(radius);
  } else if (style === "five" || style === "six") {
    angle *= style === "five" ? 5 / 4 : 6 / 4;
    radius *= 1.4;
    luminance = 0.3 * starTerm(2.2) * Math.exp(-(radius ** 2)) / Math.sqrt(radius);
  } else if (style === "special") {
    angle *= 2;
    radius *= 1.4;
    luminance = 0.3 * starTerm(4.2) * Math.exp(-(radius ** 2)) / Math.sqrt(radius);
  } else if (style === "multiplier-one") {
    angle *= 3 / 4;
    radius *= 1.9;
    luminance = 0.3 * starTerm(1.5) * Math.exp(-(radius ** 2)) / Math.sqrt(radius);
    if (radius < 1) {
      angle += Math.PI / 4;
      extra = 0.3 * starTerm(0.7) * Math.exp(-0.3 * (radius ** 2)) / Math.sqrt(radius);
      if (extra > 0) luminance += extra;
      if (luminance > 0.5) luminance *= 0.3 + 0.7 / (0.5 + luminance);
    }
  } else if (style === "multiplier-two") {
    luminance = 0.3
      * (1 - 2.5 * Math.abs(initialX ** 2 - initialY ** 2))
      * Math.exp(-(radius ** 2)) / Math.sqrt(radius);
    angle += Math.PI / 4;
    extra = 0.3 * starTerm(0.7) * Math.exp(-0.1 * (radius ** 2)) / Math.sqrt(radius);
    if (extra > 0) luminance += extra;
    if (luminance > 0.5) luminance *= 0.3 + 0.7 / (0.5 + luminance);
  } else {
    angle += Math.PI / 4;
    extra = 0.3 * (1 - 3.1 * Math.abs(
      radius ** 0.2 * Math.cos(angle) ** 2
      - radius ** 0.2 * Math.sin(angle) ** 2
    )) * Math.exp(-0.1 * (radius ** 2)) / Math.sqrt(radius);
    luminance = Math.max(0, extra);
    luminance += 0.3
      * (1 - 6 * Math.abs(initialX ** 2 - initialY ** 2))
      * Math.exp(-0.4 * (radius ** 2)) / Math.sqrt(2 * radius);
    if (luminance > 0.5) luminance *= 0.3 + 0.7 / (0.5 + luminance);
    extra = 0.15 * Math.exp(-350 * ((radius - 0.9) ** 2))
      * (1.15 + 0.3 * Math.cos(4 * angle));
    luminance = Math.max(luminance, extra);
  }

  luminance = Math.max(0, luminance);
  return {
    luminance,
    alpha: Math.max(0, 4.5 * luminance * Math.sqrt(radius)),
  };
}

function sparkleTexture(style: SparkleStyle, color: Color3): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const key = `${style}:${color.map((channel) => channel.toFixed(3)).join(":")}`;
  const cached = sparkleTextureCache.get(key);
  if (cached) return cached;

  const length = 64;
  const canvas = document.createElement("canvas");
  canvas.width = length;
  canvas.height = length;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = context.createImageData(length, length);
  for (let row = 0; row < length; row += 1) {
    for (let column = 0; column < length; column += 1) {
      const x = column * (2 / (length - 1)) - 1;
      const y = row * (2 / (length - 1)) - 1;
      const sample = sparkleSample(style, x, y);
      const intensity = clamp(sample.luminance * 2.1);
      const whiteCore = clamp((intensity - 0.28) / 0.72) ** 1.35;
      const pixel = (row * length + column) * 4;
      image.data[pixel] = Math.round(255 * clamp(
        color[0] * (0.45 + intensity * 0.55) + (1 - color[0]) * whiteCore,
      ));
      image.data[pixel + 1] = Math.round(255 * clamp(
        color[1] * (0.45 + intensity * 0.55) + (1 - color[1]) * whiteCore,
      ));
      image.data[pixel + 2] = Math.round(255 * clamp(
        color[2] * (0.45 + intensity * 0.55) + (1 - color[2]) * whiteCore,
      ));
      image.data[pixel + 3] = Math.round(255 * clamp(sample.alpha));
    }
  }
  context.putImageData(image, 0, 0);
  if (sparkleTextureCache.size >= MAX_SPARKLE_TEXTURE_CACHE) {
    const oldest = sparkleTextureCache.keys().next().value;
    if (oldest !== undefined) sparkleTextureCache.delete(oldest);
  }
  sparkleTextureCache.set(key, canvas);
  return canvas;
}

export function prepareSparkleTextures(): void {
  for (const color of BLOCK_COLORS) sparkleTexture("four", color);
  sparkleTexture("four", WHITE_STAR_COLOR);
  sparkleTexture("five", HUD_STAR_COLOR);
  for (const [style, colorIndex] of [
    ["four", 0],
    ["five", 0],
    ["six", 0],
    ["special", 4],
    ["multiplier-one", 0],
    ["multiplier-two", 0],
    ["multiplier-three", 0],
    ["multiplier-three", 1],
    ["multiplier-three", 2],
    ["multiplier-three", 3],
  ] as const) sparkleTexture(style, [...REWARD_MOTE_PALETTE[colorIndex]]);
}

function drawSparkle(
  context: CanvasRenderingContext2D,
  style: SparkleStyle,
  color: Color3,
  x: number,
  y: number,
  size: number,
  rotation: number,
  alpha: number,
  shadowBlur: number,
): void {
  const texture = sparkleTexture(style, color);
  if (!texture || alpha <= 0 || size <= 0) return;
  context.save();
  context.translate(x, y);
  context.rotate(rotation);
  context.globalAlpha = clamp(alpha);
  context.shadowColor = colorToCss(mixColor(color, [1, 1, 1], 0.45));
  context.shadowBlur = shadowBlur;
  context.drawImage(texture, -size / 2, -size / 2, size, size);
  context.restore();
}

function drawLogo(context: CanvasRenderingContext2D, assets: RenderAssets): void {
  if (imageReady(assets.logo)) {
    context.drawImage(assets.logo, 52, 34, 252, 252);
    return;
  }
  context.fillStyle = "#d7d7ff";
  context.font = "900 46px Georgia, serif";
  context.fillText("CRACK", 68, 105);
  context.fillText("ATTACK!", 68, 160);
}

function drawOutlinedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color = "#7470e7",
): void {
  context.save();
  context.font = `800 ${size}px Georgia, "Times New Roman", serif`;
  context.lineJoin = "round";
  context.lineWidth = Math.max(1.5, size * 0.09);
  context.strokeStyle = color;
  context.fillStyle = "#020207";
  context.strokeText(text, x, y);
  context.fillText(text, x, y);
  context.restore();
}

function drawSpriteText(
  context: CanvasRenderingContext2D,
  assets: RenderAssets,
  text: string,
  x: number,
  y: number,
  size: number,
): void {
  if (!imageReady(assets.font)) {
    drawOutlinedText(context, text, x, y + size, size * 0.8);
    return;
  }
  let cursor = x;
  for (const character of text) {
    const sourceIndex = character === ":" ? 10 : Number(character);
    if (!Number.isFinite(sourceIndex)) {
      cursor += size * 0.55;
      continue;
    }
    context.drawImage(assets.font, sourceIndex * 32, 0, 32, 32, cursor, y, size, size);
    cursor += size * (5 / 6);
  }
}

function measureSpriteText(text: string, size: number): number {
  if (text.length === 0) return 0;
  return size + (text.length - 1) * size * (5 / 6);
}

const UI_FONT_GLYPHS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ:";
const UI_FONT_WIDTHS = [
  20, 12, 17, 14, 16, 15, 16, 19, 17, 16,
  28, 20, 17, 20, 18, 20, 20, 19, 11, 17, 19, 17, 30,
  20, 20, 21, 22, 22, 16, 21, 20, 20, 30, 25, 22, 19,
  12,
] as const;

function measureUiText(text: string, height: number): number {
  const scale = height / 32;
  return [...text].reduce((width, character) => {
    if (character === " ") return width + 10 * scale;
    const index = UI_FONT_GLYPHS.indexOf(character.toUpperCase());
    return width + (index >= 0 ? UI_FONT_WIDTHS[index] * scale : 0);
  }, 0);
}

function drawUiText(
  context: CanvasRenderingContext2D,
  assets: RenderAssets,
  text: string,
  x: number,
  y: number,
  height: number,
): void {
  if (!imageReady(assets.fontUi)) {
    context.save();
    context.fillStyle = "#ffffff";
    context.font = `700 ${height * 0.74}px Georgia, "Times New Roman", serif`;
    context.fillText(text, x, y + height * 0.8);
    context.restore();
    return;
  }
  const scale = height / 32;
  let cursor = x;
  for (const character of text) {
    if (character === " ") {
      cursor += 10 * scale;
      continue;
    }
    const index = UI_FONT_GLYPHS.indexOf(character.toUpperCase());
    if (index < 0) continue;
    context.drawImage(
      assets.fontUi,
      index * 32,
      0,
      32,
      32,
      cursor,
      y,
      height,
      height,
    );
    cursor += UI_FONT_WIDTHS[index] * scale;
  }
}

function drawCenteredUiText(
  context: CanvasRenderingContext2D,
  assets: RenderAssets,
  text: string,
  centerX: number,
  y: number,
  height: number,
): void {
  drawUiText(context, assets, text, centerX - measureUiText(text, height) / 2, y, height);
}

function drawLoseBar(context: CanvasRenderingContext2D, state: LoseBarState): void {
  const x = 74;
  const y = 526;
  const width = 216;
  const height = 22;
  const visual = loseBarVisual(state);

  context.save();
  roundedRect(context, x, y, width, height, height / 2);
  context.clip();

  for (let row = 0; row < height; row += 1) {
    const tone = loseBarToneAt(row / (height - 1));
    const leading = colorToCss(visual.leading, tone.light, tone.specular);
    const trailing = colorToCss(visual.trailing, tone.light, tone.specular);
    if (visual.progress <= 0) {
      context.fillStyle = trailing;
    } else if (visual.progress >= 1) {
      context.fillStyle = leading;
    } else {
      const blendHalfWidth = 0.14;
      const transitionStart = clamp(visual.progress - blendHalfWidth);
      const transitionEnd = clamp(visual.progress + blendHalfWidth);
      const horizontal = context.createLinearGradient(x, y, x + width, y);
      horizontal.addColorStop(0, leading);
      horizontal.addColorStop(transitionStart, leading);
      horizontal.addColorStop(transitionEnd, trailing);
      horizontal.addColorStop(1, trailing);
      context.fillStyle = horizontal;
    }
    context.fillRect(x, y + row, width, 1.05);
  }

  context.save();
  context.translate(x + width - 8, y + height * 0.32);
  context.scale(0.62, 1);
  const capHighlight = context.createRadialGradient(0, 0, 0, 0, 0, 12);
  capHighlight.addColorStop(0, "rgba(255, 255, 255, .76)");
  capHighlight.addColorStop(0.3, "rgba(255, 255, 255, .52)");
  capHighlight.addColorStop(1, "rgba(255, 255, 255, 0)");
  context.fillStyle = capHighlight;
  context.fillRect(-12, -12, 24, 24);
  context.restore();
  context.restore();
}

function drawHud(
  context: CanvasRenderingContext2D,
  snapshot: GameSnapshot,
  assets: RenderAssets,
): void {
  drawLoseBar(context, snapshot.loseBar);
  const hudCenterX = 182;
  const score = scoreDigitTransition(
    snapshot.displayScore,
    snapshot.previousDisplayScore,
    snapshot.scoreFadeProgress,
  );
  const scoreSize = 44;
  drawSparkle(
    context,
    "five",
    HUD_STAR_COLOR,
    hudCenterX,
    610,
    50,
    snapshot.hudStarRotation,
    snapshot.hudStarAlpha,
    4,
  );
  const scoreX = hudCenterX - measureSpriteText(score.current, scoreSize) / 2;
  const digitAdvance = scoreSize * (5 / 6);
  for (let index = 0; index < score.current.length; index += 1) {
    const currentDigit = score.current[index];
    const previousDigit = score.previous[index];
    const x = scoreX + index * digitAdvance;
    if (currentDigit === previousDigit || score.progress >= 1) {
      drawSpriteText(context, assets, currentDigit, x, 670, scoreSize);
      continue;
    }
    if (score.progress < 1) {
      context.save();
      context.globalAlpha = 1 - score.progress;
      drawSpriteText(context, assets, previousDigit, x, 670, scoreSize);
      context.restore();
    }
    if (score.progress > 0) {
      context.save();
      context.globalAlpha = score.progress;
      drawSpriteText(context, assets, currentDigit, x, 670, scoreSize);
      context.restore();
    }
  }

  context.fillStyle = "rgba(116, 112, 223, .52)";
  context.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.fillText("ARROWS  MOVE", 78, 744);
  context.fillText("SPACE   SWAP", 78, 763);
  context.fillText("ENTER   RAISE", 78, 782);
}

function drawLevelTriangle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  direction: 1 | -1,
  color: Color3,
  flashing: boolean,
): void {
  const cssColor = colorToCss(color);
  context.save();
  context.translate(x, y);
  context.shadowColor = cssColor;
  context.shadowBlur = flashing ? 12 : 5;
  context.fillStyle = cssColor;
  context.beginPath();
  context.moveTo(direction * 11, 0);
  context.lineTo(direction * -8, -7);
  context.lineTo(direction * -5, 7);
  context.closePath();
  context.fill();
  context.restore();
}

function drawLevelLights(context: CanvasRenderingContext2D, snapshot: GameSnapshot): void {
  for (let index = 0; index < VISIBLE_ROWS; index += 1) {
    const level = VISIBLE_ROWS - 1 - index;
    const y = levelLightScreenY(level, BOARD_BOTTOM, CELL_SIZE);
    const impactFlash = snapshot.levelLightImpactFlashes[level] ?? 0;
    const color = levelLightColor(
      snapshot.levelLightBlends[level] ?? 0,
      snapshot.dangerFlashAlarm,
      impactFlash,
    );
    const flashing = snapshot.dangerFlashAlarm >= 0 || impactFlash > 0;
    drawLevelTriangle(context, 18, y, 1, color, flashing);
    drawLevelTriangle(context, 782, y, -1, color, flashing);
  }
}

/** Mirrors the original's LL_OPPONENT_LIGHTS column on the right of the board. */
export function drawOpponentLights(
  context: CanvasRenderingContext2D,
  snapshot: GameSnapshot,
): void {
  const bits = snapshot.opponentLevelLights ?? 0;
  if (bits === 0) return;
  const lampWidth = 14;
  const lampHeight = Math.floor(CELL_SIZE * 0.5);
  const x = BOARD_X + BOARD_WIDTH + 18;
  for (let row = 0; row < VISIBLE_ROWS; row += 1) {
    if ((bits & (1 << row)) === 0) continue;
    const danger = row >= VISIBLE_ROWS - 3;
    context.fillStyle = danger ? "#FF0000" : "#3333CC";
    const y = BOARD_BOTTOM - (row + 1) * CELL_SIZE + (CELL_SIZE - lampHeight) / 2;
    context.fillRect(x, y, lampWidth, lampHeight);
  }
}

interface RenderedFace {
  points: Vector3[];
  normal: Vector3;
  vertexNormals?: Vector3[];
  depth: number;
}

interface MeshRenderOptions {
  rotateX?: number;
  rotateY?: number;
  rotateZ?: number;
  spinAxis?: Vector3;
  spinAngle?: number;
  scale?: number;
  centerZ?: number;
  moteLights?: WebGLPointLight[];
  headlightLevel?: number;
}

function drawWorldMeshCube(
  context: CanvasRenderingContext2D,
  mesh: BlockMesh,
  color: Color3,
  centerX: number,
  centerY: number,
  options: MeshRenderOptions = {},
): void {
  const transformDirection = (vector: Vector3): Vector3 => {
    const spun = options.spinAxis && options.spinAngle
      ? rotateAroundAxis(vector, options.spinAxis, options.spinAngle)
      : vector;
    return rotateVector(
      spun,
      options.rotateX ?? 0,
      options.rotateY ?? 0,
      options.rotateZ ?? 0,
    );
  };
  const worldCenter = screenCenterToWorld(
    centerX,
    centerY,
    VIEW_CENTER_X,
    VIEW_CENTER_Y,
    WORLD_UNITS_PER_PIXEL,
  );
  worldCenter[2] += options.centerZ ?? 0;
  const scale = options.scale ?? 1;
  const lightBounds: WebGLLightBounds = [
    worldCenter[0],
    worldCenter[1],
    worldCenter[0],
    worldCenter[1],
  ];
  const transformedVertices = mesh.vertices.map((vertex) => {
    const transformed = transformDirection(vertex);
    return [
      worldCenter[0] + transformed[0] * scale,
      worldCenter[1] + transformed[1] * scale,
      worldCenter[2] + transformed[2] * scale,
    ] as Vector3;
  });
  const transformedNormals = mesh.normals.map((normal) =>
    normalize(transformDirection(normal)));

  const faces: RenderedFace[] = [];
  for (const face of mesh.faces) {
    const points = face.vertices.map((index) => transformedVertices[index]);
    const normals = face.normals.map((index) => transformedNormals[index]);
    const faceNormal = normalize(cross(subtract(points[1], points[0]), subtract(points[2], points[0])));
    const faceCenter: Vector3 = [
      (points[0][0] + points[1][0] + points[2][0]) / 3,
      (points[0][1] + points[1][1] + points[2][1]) / 3,
      (points[0][2] + points[1][2] + points[2][2]) / 3,
    ];
    if (
      faceNormal[0] * -faceCenter[0]
      + faceNormal[1] * -faceCenter[1]
      + faceNormal[2] * -faceCenter[2]
      <= 0
    ) continue;
    const normal = normalize([
      (normals[0][0] + normals[1][0] + normals[2][0]) / 3,
      (normals[0][1] + normals[1][1] + normals[2][1]) / 3,
      (normals[0][2] + normals[1][2] + normals[2][2]) / 3,
    ]);
    faces.push({
      points,
      normal,
      vertexNormals: normals,
      depth: (points[0][2] + points[1][2] + points[2][2]) / 3,
    });
  }
  faces.sort((a, b) => a.depth - b.depth);

  for (const face of faces) {
    const projected = face.points.map((point) =>
      projectWorldPoint(point, VIEW_CENTER_X, VIEW_CENTER_Y, WORLD_UNITS_PER_PIXEL));
    const tones = (face.vertexNormals ?? [face.normal]).map((normal, index) =>
      fixedFunctionVertexTone(
        normal,
        face.points[index] ?? face.points[0],
        options.moteLights,
        lightBounds,
        0,
        options.headlightLevel,
      ));
    context.beginPath();
    projected.forEach(([x, y], index) => {
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
    const darkest = tones.reduce(
      (best, tone, index) => tone.level < tones[best].level ? index : best,
      0,
    );
    const brightest = tones.reduce(
      (best, tone, index) => tone.level > tones[best].level ? index : best,
      0,
    );
    if (darkest !== brightest && tones[brightest].level - tones[darkest].level > 0.035) {
      const gradient = context.createLinearGradient(
        projected[darkest][0],
        projected[darkest][1],
        projected[brightest][0],
        projected[brightest][1],
      );
      const middle = averageFixedFunctionTone(tones);
      gradient.addColorStop(0, fixedFunctionColor(color, tones[darkest]));
      gradient.addColorStop(0.52, fixedFunctionColor(color, middle));
      gradient.addColorStop(1, fixedFunctionColor(color, tones[brightest]));
      context.fillStyle = gradient;
    } else {
      context.fillStyle = fixedFunctionColor(color, tones[0]);
    }
    context.fill();
    context.strokeStyle = `rgba(0, 0, 0, ${0.3 * (options.headlightLevel ?? 1)})`;
    context.lineWidth = 0.55;
    context.stroke();
  }
}

function drawFallbackCube(
  context: CanvasRenderingContext2D,
  color: Color3,
  size: number,
  headlightLevel = 1,
): void {
  const half = size / 2;
  const center: [number, number] = [0, 0];
  const facets: Array<{ points: Array<[number, number]>; light: number }> = [
    { points: [[-half, -half], [half, -half], center], light: 1.25 },
    { points: [[half, -half], [half, half], center], light: 0.84 },
    { points: [[half, half], [-half, half], center], light: 0.5 },
    { points: [[-half, half], [-half, -half], center], light: 0.72 },
  ];
  for (const facet of facets) {
    context.beginPath();
    facet.points.forEach(([x, y], index) => index === 0 ? context.moveTo(x, y) : context.lineTo(x, y));
    context.closePath();
    context.fillStyle = colorToCss(color, facet.light * headlightLevel);
    context.fill();
  }
  context.strokeStyle = `rgba(0, 0, 0, ${0.72 * headlightLevel})`;
  context.lineWidth = 1.4;
  context.strokeRect(-half, -half, size, size);
}

interface BlockVisual {
  scale: number;
  alpha: number;
  rotateX: number;
  rotateY: number;
  rotateZ: number;
  spinAxis?: Vector3;
  spinAngle: number;
  color: Color3;
  centerZ?: number;
}

function awakeningRotation(sequence: number, remaining: number): {
  rotateX: number;
  rotateY: number;
} {
  const quarterTurn = Math.PI / 2;
  const eighthTurn = Math.PI / 4;
  switch (sequence & 3) {
    case 0:
      return {
        rotateX: eighthTurn * remaining,
        rotateY: eighthTurn * remaining,
      };
    case 1:
      return {
        rotateX: quarterTurn - eighthTurn * remaining,
        rotateY: eighthTurn * remaining,
      };
    case 2:
      return {
        rotateX: quarterTurn - eighthTurn * remaining,
        rotateY: -eighthTurn * remaining,
      };
    default:
      return {
        rotateX: eighthTurn * remaining,
        rotateY: -eighthTurn * remaining,
      };
  }
}

function blockVisual(
  cell: BlockCell,
  now: number,
  dimmed: boolean,
  motion?: MotionPosition,
): BlockVisual {
  let scale = 1;
  const material = dimmed ? CREEP_ROW_BLOCK_MATERIALS[cell.flavor] : null;
  const alpha = material?.alpha ?? 1;
  let rotateX = 0;
  let rotateY = 0;
  const rotateZ = 0;
  let spinAxis: Vector3 | undefined;
  let spinAngle = 0;
  let color = material?.color ?? BLOCK_COLORS[cell.flavor];

  if (cell.state === "clearing" && cell.clearStarted !== undefined && cell.clearUntil !== undefined) {
    const progress = clamp((now - cell.clearStarted) / (cell.clearUntil - cell.clearStarted));
    if (progress < DYING_FLASH_FRACTION) {
      const flashProgress = progress / DYING_FLASH_FRACTION;
      const flash = doubleTriangularFlash(flashProgress);
      color = mixColor(color, [1, 1, 1], flash);
    } else {
      const tumble = (progress - DYING_FLASH_FRACTION) / (1 - DYING_FLASH_FRACTION);
      const axisAngle = cell.deathSpinAxis
        ?? ((cell.id * 0.754877666) % 1) * Math.PI * 2;
      spinAxis = [Math.cos(axisAngle), Math.sin(axisAngle), 0];
      spinAngle = DYING_ROTATIONS * tumble * tumble;
      scale = 1 - 0.9 * tumble;
    }
  } else if (cell.state === "awakening" && cell.awakenRevealAt !== undefined) {
    const source = GARBAGE_COLORS[cell.awakenSource ?? "normal"];
    const popStarted = cell.awakenRevealAt - AWAKEN_POP_DURATION_MS;
    if (now < popStarted) {
      color = source;
      scale = 0.5;
      rotateX = Math.PI / 4;
      rotateY = Math.PI / 4;
    } else if (now < cell.awakenRevealAt) {
      const progress = clamp((now - popStarted) / AWAKEN_POP_DURATION_MS);
      const rotation = awakeningRotation(
        cell.awakenPopDirection ?? cell.awakenSequence ?? cell.id,
        1 - progress,
      );
      color = mixColor(source, color, progress);
      scale = 0.5 + 0.5 * progress;
      rotateX = rotation.rotateX;
      rotateY = rotation.rotateY;
    }
  }

  return {
    scale,
    alpha,
    rotateX,
    rotateY: rotateY + (motion?.rotateY ?? 0),
    rotateZ,
    spinAxis,
    spinAngle,
    color,
    centerZ: motion?.centerZ ?? 0,
  };
}

function drawBlockVisual(
  context: CanvasRenderingContext2D,
  visual: BlockVisual,
  assets: RenderAssets,
  screenX: number,
  screenY: number,
  shadowBlur: number,
  moteLights: WebGLPointLight[] = [],
  headlightLevel = 1,
): void {
  const {
    scale,
    alpha,
    rotateX,
    rotateY,
    rotateZ,
    spinAxis,
    spinAngle,
    color,
    centerZ = 0,
  } = visual;

  context.save();
  context.globalAlpha = alpha;
  context.shadowColor = colorToCss(color, 1.05 * headlightLevel);
  context.shadowBlur = shadowBlur;
  if (assets.blockMesh) {
    drawWorldMeshCube(
      context,
      assets.blockMesh,
      color,
      screenX + CELL_SIZE / 2,
      screenY + CELL_SIZE / 2,
      {
        rotateX,
        rotateY,
        rotateZ,
        spinAxis,
        spinAngle,
        scale,
        centerZ,
        moteLights,
        headlightLevel,
      },
    );
  } else {
    context.translate(screenX + CELL_SIZE / 2, screenY + CELL_SIZE / 2);
    context.scale(scale, scale);
    context.rotate(rotateZ);
    drawFallbackCube(context, color, BLOCK_MESH_SIZE, headlightLevel);
  }
  context.restore();
}

function drawBlock(
  context: CanvasRenderingContext2D,
  cell: BlockCell,
  assets: RenderAssets,
  screenX: number,
  screenY: number,
  now: number,
  dimmed = false,
  moteLights: WebGLPointLight[] = [],
  motion?: MotionPosition,
  headlightLevel = 1,
): void {
  drawBlockVisual(
    context,
    blockVisual(cell, now, dimmed, motion),
    assets,
    screenX,
    screenY,
    cell.state === "clearing" ? 9 : 4,
    moteLights,
    headlightLevel,
  );
}

function drawBlockVisualToWebGL(
  layer: BlockWebGLLayer,
  visual: BlockVisual,
  screenX: number,
  screenY: number,
): void {
  const centerX = screenX + CELL_SIZE / 2;
  const centerY = screenY + CELL_SIZE / 2;
  layer.draw({
    centerX,
    centerY,
    color: visual.color,
    alpha: visual.alpha,
    scale: visual.scale,
    rotateX: visual.rotateX,
    rotateY: visual.rotateY,
    rotateZ: visual.rotateZ,
    spinAxis: visual.spinAxis,
    spinAngle: visual.spinAngle,
    centerZ: visual.centerZ ?? 0,
  });
}

function drawBlockToWebGL(
  layer: BlockWebGLLayer,
  cell: BlockCell,
  screenX: number,
  screenY: number,
  now: number,
  dimmed: boolean,
  motion?: MotionPosition,
): void {
  drawBlockVisualToWebGL(
    layer,
    blockVisual(cell, now, dimmed, motion),
    screenX,
    screenY,
  );
}

function shatterProxyBlock(cell: GarbageCell): BlockCell {
  const revealAt = (cell.clearStarted ?? 0)
    + AWAKEN_INITIAL_DELAY_MS
    + AWAKEN_INTERNAL_DELAY_MS * (cell.shatterSequence ?? 0);
  return {
    id: cell.id,
    kind: "block",
    flavor: cell.shatterTargetFlavor ?? 0,
    state: "awakening",
    awakenRevealAt: revealAt,
    awakenSource: cell.flavor,
    awakenSequence: cell.shatterSequence,
    awakenPopDirection: cell.shatterPopDirection,
  };
}

function retainedGarbageSectionVisual(
  sourceFlavor: GarbageCell["flavor"],
  revealAt: number,
  sequence: number,
  sectionCompression: number,
  now: number,
): BlockVisual {
  const source = GARBAGE_COLORS[sourceFlavor];
  const target = GARBAGE_COLORS.normal;
  if (sectionCompression > 0) {
    return {
      scale: 1 - 0.5 * sectionCompression,
      alpha: 1,
      rotateX: (Math.PI / 4) * sectionCompression,
      rotateY: (Math.PI / 4) * sectionCompression,
      rotateZ: 0,
      spinAngle: 0,
      color: target,
    };
  }

  const popStarted = revealAt - AWAKEN_POP_DURATION_MS;
  if (now < popStarted) {
    return {
      scale: 0.5,
      alpha: 1,
      rotateX: Math.PI / 4,
      rotateY: Math.PI / 4,
      rotateZ: 0,
      spinAngle: 0,
      color: source,
    };
  }
  if (now < revealAt) {
    const progress = clamp((now - popStarted) / AWAKEN_POP_DURATION_MS);
    const rotation = awakeningRotation(sequence, 1 - progress);
    return {
      scale: 0.5 + 0.5 * progress,
      alpha: 1,
      rotateX: rotation.rotateX,
      rotateY: rotation.rotateY,
      rotateZ: 0,
      spinAngle: 0,
      color: mixColor(source, target, progress),
    };
  }
  return {
    scale: 1,
    alpha: 1,
    rotateX: 0,
    rotateY: 0,
    rotateZ: 0,
    spinAngle: 0,
    color: target,
  };
}

function shatteringRetainedSectionVisual(cell: GarbageCell, now: number): BlockVisual {
  const revealAt = (cell.clearStarted ?? now)
    + AWAKEN_INITIAL_DELAY_MS
    + AWAKEN_INTERNAL_DELAY_MS * (cell.shatterSequence ?? 0);
  return retainedGarbageSectionVisual(
    cell.flavor,
    revealAt,
    cell.shatterPopDirection ?? cell.shatterSequence ?? 0,
    0,
    now,
  );
}

function drawWebGLBlocks(
  context: CanvasRenderingContext2D,
  snapshot: GameSnapshot,
  assets: RenderAssets,
  now: number,
  garbageGroups: GarbageGroupRender[],
  moteLights: WebGLPointLight[],
): boolean {
  if (!assets.blockMesh) return false;
  const layer = getBlockWebGLLayer();
  if (!layer || !layer.isAvailable()) return false;
  try {
    return renderWebGLBlocks(
      context,
      snapshot,
      assets,
      now,
      garbageGroups,
      moteLights,
      layer,
    );
  } catch {
    // Context loss can happen between any two WebGL calls. The Canvas2D path
    // below draws the complete frame until the layer reports a healthy restore.
    return false;
  }
}

function renderWebGLBlocks(
  context: CanvasRenderingContext2D,
  snapshot: GameSnapshot,
  assets: RenderAssets,
  now: number,
  garbageGroups: GarbageGroupRender[],
  moteLights: WebGLPointLight[],
  layer: BlockWebGLLayer,
): boolean {
  if (!assets.blockMesh || !layer.begin(
    assets.blockMesh,
    moteLights,
    snapshot.headlightLevel,
  )) return false;

  snapshot.nextRow.forEach((cell, x) => {
    if (!cell || cell.kind !== "block") return;
    const position = logicalToScreen(
      x,
      -1,
      snapshot.rise + snapshot.impactOffsetRows,
    );
    drawBlockToWebGL(layer, cell, position.x, position.y, now, true);
  });

  for (let y = 0; y < snapshot.board.length; y += 1) {
    for (let x = 0; x < BOARD_COLUMNS; x += 1) {
      const cell = snapshot.board[y][x];
      if (cell?.kind !== "block") continue;
      const motion = motionPosition(cell, x, y, now);
      const position = logicalToScreen(
        motion.x,
        motion.y,
        snapshot.rise + snapshot.impactOffsetRows,
      );
      drawBlockToWebGL(layer, cell, position.x, position.y, now, false, motion);
    }
  }

  // In the original, shattering garbage leaves an array of half-size,
  // pre-rotated cubes inside its shell. The rising clip plane reveals those
  // cubes before each one expands into its final colored block.
  for (const group of garbageGroups) {
    if (group.state === "shattering") {
      for (const { x, y, cell } of group.positions) {
        const motion = motionPosition(cell, x, y, now);
        const position = logicalToScreen(
          motion.x,
          motion.y,
          snapshot.rise + snapshot.impactOffsetRows,
        );
        if (cell.shatterReforms) {
          drawBlockVisualToWebGL(
            layer,
            shatteringRetainedSectionVisual(cell, now),
            position.x,
            position.y,
          );
        } else {
          drawBlockToWebGL(
            layer,
            shatterProxyBlock(cell),
            position.x,
            position.y,
            now,
            false,
          );
        }
      }
    } else if (
      group.state === "awakening"
      && group.awakenReleaseAt !== undefined
    ) {
      const retained = retainedGarbageVisual(
        now,
        group.awakenReleaseAt,
        Math.max(1, new Set(group.positions.map(({ y }) => y)).size),
        AWAKEN_FINAL_DELAY_MS,
      );
      for (const { x, y, cell } of group.positions) {
        const motion = motionPosition(cell, x, y, now);
        const position = logicalToScreen(
          motion.x,
          motion.y,
          snapshot.rise + snapshot.impactOffsetRows,
        );
        drawBlockVisualToWebGL(
          layer,
          retainedGarbageSectionVisual(
            cell.awakenSource ?? "normal",
            cell.awakenRevealAt ?? now,
            cell.awakenPopDirection ?? cell.awakenSequence ?? 0,
            retained.sectionCompression,
            now,
          ),
          position.x,
          position.y,
        );
      }
    }
  }

  for (const group of garbageGroups) {
    const visual = calculateGarbageVisual(group, snapshot, now);
    if (!visual.visible) continue;
    layer.useMesh(visual.mesh);
    layer.draw({
      centerX: visual.centerScreenX,
      centerY: visual.centerScreenY,
      color: visual.color,
      alpha: visual.alpha,
      scale: 1,
      rotateX: 0,
      rotateY: 0,
      rotateZ: 0,
      spinAngle: 0,
      // The original multiplies garbage lighting by a repeating luminance
      // map constrained to 0.85-1.0. Its mean is approximately 0.955.
      materialLight: 0.955,
      clipMinY: visual.clipMinY ?? undefined,
      doubleSided: visual.doubleSided,
      lightBounds: garbageLightBounds(
        visual.worldCenter,
        visual.widthCells,
        visual.heightCells,
      ),
      attenuateMoteLights: true,
    });
  }

  if (!layer.isAvailable()) return false;
  context.drawImage(layer.canvas, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  return true;
}

interface GarbageGroupRender {
  groupId: number;
  flavor: "normal" | "gray";
  texture: number | null;
  decalX?: number;
  decalY?: number;
  state: GarbageCell["state"];
  clearStarted?: number;
  clearUntil?: number;
  awakenRevealAt?: number;
  awakenReleaseAt?: number;
  positions: Array<{ x: number; y: number; cell: GarbageCell }>;
}

interface GarbageVisual {
  mesh: GarbageMesh;
  widthCells: number;
  heightCells: number;
  centerScreenX: number;
  centerScreenY: number;
  worldCenter: Vector3;
  color: Color3;
  alpha: number;
  clipMinY: number | null;
  doubleSided: boolean;
  visible: boolean;
}

function dot(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function averagePoint(points: Vector3[]): Vector3 {
  const total = points.reduce<Vector3>(
    (sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]],
    [0, 0, 0],
  );
  return [total[0] / points.length, total[1] / points.length, total[2] / points.length];
}

function clipLitPolygonAtMinY(
  points: Vector3[],
  normals: Vector3[],
  minY: number,
): { points: Vector3[]; normals: Vector3[] } {
  const clippedPoints: Vector3[] = [];
  const clippedNormals: Vector3[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const currentNormal = normals[index];
    const nextNormal = normals[(index + 1) % normals.length];
    const currentInside = current[1] >= minY;
    const nextInside = next[1] >= minY;

    if (currentInside) {
      clippedPoints.push(current);
      clippedNormals.push(currentNormal);
    }
    if (currentInside === nextInside) continue;

    const amount = (minY - current[1]) / (next[1] - current[1]);
    clippedPoints.push([
      current[0] + (next[0] - current[0]) * amount,
      minY,
      current[2] + (next[2] - current[2]) * amount,
    ]);
    clippedNormals.push(normalize([
      currentNormal[0] + (nextNormal[0] - currentNormal[0]) * amount,
      currentNormal[1] + (nextNormal[1] - currentNormal[1]) * amount,
      currentNormal[2] + (nextNormal[2] - currentNormal[2]) * amount,
    ]));
  }
  return { points: clippedPoints, normals: clippedNormals };
}

function collectGarbage(snapshot: GameSnapshot): GarbageGroupRender[] {
  const groups = new Map<number, GarbageGroupRender>();
  for (let y = 0; y < snapshot.board.length; y += 1) {
    for (let x = 0; x < BOARD_COLUMNS; x += 1) {
      const cell = snapshot.board[y][x];
      if (cell?.kind !== "garbage") continue;
      const group = groups.get(cell.groupId) ?? {
        groupId: cell.groupId,
        flavor: cell.flavor,
        texture: cell.texture,
        decalX: cell.decalX,
        decalY: cell.decalY,
        state: cell.state,
        clearStarted: cell.clearStarted,
        clearUntil: cell.clearUntil,
        awakenRevealAt: cell.awakenRevealAt,
        awakenReleaseAt: cell.awakenReleaseAt,
        positions: [],
      };
      group.positions.push({ x, y, cell });
      groups.set(cell.groupId, group);
    }
  }
  return [...groups.values()];
}

function calculateGarbageVisual(
  group: GarbageGroupRender,
  snapshot: GameSnapshot,
  now: number,
): GarbageVisual {
  const minX = Math.min(...group.positions.map(({ x }) => x));
  const maxX = Math.max(...group.positions.map(({ x }) => x));
  const minY = Math.min(...group.positions.map(({ y }) => y));
  const maxY = Math.max(...group.positions.map(({ y }) => y));
  const anchor = group.positions.find(({ x, y }) => x === minX && y === minY) ?? group.positions[0];
  const motion = motionPosition(anchor.cell, minX, minY, now);
  const widthCells = maxX - minX + 1;
  const heightCells = maxY - minY + 1;

  let alpha = 1;
  let clipMinY: number | null = null;
  let doubleSided = false;
  let visible = true;
  let color = GARBAGE_COLORS[group.flavor];
  if (group.state === "shattering" && group.clearStarted !== undefined && group.clearUntil !== undefined) {
    const progress = clamp((now - group.clearStarted) / (group.clearUntil - group.clearStarted));
    const shatter = garbageShatterVisual(progress, heightCells);
    color = mixColor(color, [1, 1, 1], shatter.flash);
    clipMinY = shatter.clipMinY;
    doubleSided = clipMinY !== null;
  } else if (
    group.state === "awakening"
    && group.awakenReleaseAt !== undefined
  ) {
    const retained = retainedGarbageVisual(
      now,
      group.awakenReleaseAt,
      heightCells,
      AWAKEN_FINAL_DELAY_MS,
    );
    color = GARBAGE_COLORS.normal;
    visible = retained.shellVisible;
    alpha = visible ? 1 : 0;
    clipMinY = retained.shellClipMinY;
    doubleSided = visible;
  }

  const centerScreenX = BOARD_X + (motion.x + widthCells / 2) * CELL_SIZE;
  const centerScreenY = BOARD_BOTTOM
    - (
      motion.y
      + heightCells / 2
      + snapshot.rise
      + snapshot.impactOffsetRows
    ) * CELL_SIZE;
  const worldCenter = screenCenterToWorld(
    centerScreenX,
    centerScreenY,
    VIEW_CENTER_X,
    VIEW_CENTER_Y,
    WORLD_UNITS_PER_PIXEL,
  );
  const mesh = createGarbageMesh(widthCells, heightCells);
  return {
    mesh,
    widthCells,
    heightCells,
    centerScreenX,
    centerScreenY,
    worldCenter,
    color,
    alpha,
    clipMinY,
    doubleSided,
    visible,
  };
}

function drawGarbage(
  context: CanvasRenderingContext2D,
  group: GarbageGroupRender,
  snapshot: GameSnapshot,
  assets: RenderAssets,
  now: number,
  drawBody = true,
  moteLights: WebGLPointLight[] = [],
): void {
  const {
    mesh,
    widthCells,
    heightCells,
    worldCenter,
    color,
    alpha,
    clipMinY,
    doubleSided,
    visible,
  } = calculateGarbageVisual(group, snapshot, now);
  if (!visible) return;
  const renderedFaces: RenderedFace[] = [];
  const clipWorldY = clipMinY === null ? null : worldCenter[1] + clipMinY;
  const lightBounds = garbageLightBounds(worldCenter, widthCells, heightCells);

  if (drawBody) {
    for (const face of mesh.faces) {
      let points = face.points.map((point) => [
        point[0] + worldCenter[0],
        point[1] + worldCenter[1],
        point[2] + worldCenter[2],
      ] as Vector3);
      let normals = face.normals;
      if (clipWorldY !== null) {
        const clipped = clipLitPolygonAtMinY(points, normals, clipWorldY);
        points = clipped.points;
        normals = clipped.normals;
        if (points.length < 3) continue;
      }
      const center = averagePoint(points);
      const viewDirection = normalize([-center[0], -center[1], -center[2]]);
      const facing = dot(face.normal, viewDirection);
      if (!doubleSided && facing <= 0) continue;
      const renderNormal: Vector3 = facing >= 0
        ? face.normal
        : [-face.normal[0], -face.normal[1], -face.normal[2]];
      const renderNormals = facing >= 0
        ? normals
        : normals.map((normal) => (
          [-normal[0], -normal[1], -normal[2]] as Vector3
        ));
      renderedFaces.push({
        points,
        vertexNormals: renderNormals,
        normal: renderNormal,
        depth: center[2],
      });
    }
    renderedFaces.sort((left, right) => left.depth - right.depth);
  }

  context.save();
  context.globalAlpha = alpha;
  context.shadowColor = colorToCss(color, 0.72 * snapshot.headlightLevel);
  context.shadowBlur = 0;
  for (const face of renderedFaces) {
    const projected = face.points.map((point) => projectWorldPoint(
      point,
      VIEW_CENTER_X,
      VIEW_CENTER_Y,
      WORLD_UNITS_PER_PIXEL,
    ));
    const tones = face.points.map((point, index) => fixedFunctionVertexTone(
      face.vertexNormals?.[index] ?? face.normal,
      point,
      moteLights,
      lightBounds,
      0.1,
      snapshot.headlightLevel,
    ));
    context.beginPath();
    projected.forEach(([x, y], index) => {
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
    const darkest = tones.reduce(
      (best, tone, index) => tone.level < tones[best].level ? index : best,
      0,
    );
    const brightest = tones.reduce(
      (best, tone, index) => tone.level > tones[best].level ? index : best,
      0,
    );
    if (darkest !== brightest && tones[brightest].level - tones[darkest].level > 0.025) {
      const gradient = context.createLinearGradient(
        projected[darkest][0],
        projected[darkest][1],
        projected[brightest][0],
        projected[brightest][1],
      );
      const average = averageFixedFunctionTone(tones);
      const diffuseFloor = 0.025 * snapshot.headlightLevel;
      gradient.addColorStop(0, fixedFunctionColor(color, tones[darkest], diffuseFloor));
      gradient.addColorStop(0.5, fixedFunctionColor(color, average, diffuseFloor));
      gradient.addColorStop(1, fixedFunctionColor(color, tones[brightest], diffuseFloor));
      context.fillStyle = gradient;
    } else {
      context.fillStyle = fixedFunctionColor(
        color,
        tones[0],
        0.025 * snapshot.headlightLevel,
      );
    }
    context.fill();
    context.shadowBlur = 0;
    context.strokeStyle = group.flavor === "gray"
      ? `rgba(0, 0, 0, ${0.5 * snapshot.headlightLevel})`
      : `rgba(44, 0, 5, ${0.62 * snapshot.headlightLevel})`;
    context.lineWidth = 0.65;
    context.stroke();
  }

  const texture = group.texture === null ? null : assets.garbage[group.texture];
  if (
    group.decalX !== undefined
    && group.decalY !== undefined
    && imageReady(texture)
  ) {
    const frontRing = mesh.frontRing.map((point) => [
      point[0] + worldCenter[0],
      point[1] + worldCenter[1],
      point[2] + worldCenter[2],
    ] as Vector3);
    const visibleFrontRing = clipWorldY === null
      ? frontRing
      : clipLitPolygonAtMinY(
        frontRing,
        frontRing.map(() => [0, 0, 1] as Vector3),
        clipWorldY,
      ).points;
    if (visibleFrontRing.length >= 3) {
    context.save();
    context.beginPath();
    visibleFrontRing.forEach((point, index) => {
      const [x, y] = projectWorldPoint(
        point,
        VIEW_CENTER_X,
        VIEW_CENTER_Y,
        WORLD_UNITS_PER_PIXEL,
      );
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
    context.clip();
    context.filter = `brightness(${snapshot.headlightLevel})`;
    const imageWorldSize = 4;
    const imageCenterX = worldCenter[0] + 2 * group.decalX + 2 - widthCells;
    const imageCenterY = worldCenter[1] + 2 * group.decalY + 2 - heightCells;
    const frontZ = worldCenter[2] + mesh.frontDepth + 0.002;
    const [imageLeft] = projectWorldPoint(
      [imageCenterX - imageWorldSize / 2, imageCenterY, frontZ],
      VIEW_CENTER_X,
      VIEW_CENTER_Y,
      WORLD_UNITS_PER_PIXEL,
    );
    const [imageRight] = projectWorldPoint(
      [imageCenterX + imageWorldSize / 2, imageCenterY, frontZ],
      VIEW_CENTER_X,
      VIEW_CENTER_Y,
      WORLD_UNITS_PER_PIXEL,
    );
    const [, imageTop] = projectWorldPoint(
      [imageCenterX, imageCenterY + imageWorldSize / 2, frontZ],
      VIEW_CENTER_X,
      VIEW_CENTER_Y,
      WORLD_UNITS_PER_PIXEL,
    );
    const [, imageBottom] = projectWorldPoint(
      [imageCenterX, imageCenterY - imageWorldSize / 2, frontZ],
      VIEW_CENTER_X,
      VIEW_CENTER_Y,
      WORLD_UNITS_PER_PIXEL,
    );
    context.globalAlpha = alpha;
    context.drawImage(
      texture,
      imageLeft,
      imageTop,
      imageRight - imageLeft,
      imageBottom - imageTop,
    );
    context.restore();
    }
  }
  context.restore();
}

// Exact geometry from Crack Attack's obj_swapper.cxx display list. One corner
// is mirrored four ways around the two selected cells, just as in the OpenGL
// renderer.
const SWAPPER_A = 0.1;
const SWAPPER_B = (2 * SWAPPER_A) / 2.414214;
const SWAPPER_C = 0.8;
const SWAPPER_D = 0.1;
const SWAPPER_E = 1;
const SWAPPER_F = 0.4;
const SWAPPER_H = 1;
const SWAPPER_I = 0.1;
const SWAPPER_J = 0.16;
const SWAPPER_S = 1;

function swapperPoint(x: number, y: number, z: number): Vector3 {
  return [x, y, z];
}

function swapperTriangle(a: Vector3, b: Vector3, c: Vector3): Triangle3 {
  return [a, b, c];
}

const SWAPPER_CORNER_TRIANGLES: Triangle3[] = [
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_C, -SWAPPER_E, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_C + SWAPPER_J, -SWAPPER_E, SWAPPER_H + SWAPPER_I),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_C + SWAPPER_D, -SWAPPER_E + SWAPPER_A, SWAPPER_H),
  ),
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_C + SWAPPER_D, -SWAPPER_E + SWAPPER_A, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_C + SWAPPER_J, -SWAPPER_E, SWAPPER_H + SWAPPER_I),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_F, -SWAPPER_E + SWAPPER_A, SWAPPER_H),
  ),
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_F, -SWAPPER_E + SWAPPER_A, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_C + SWAPPER_J, -SWAPPER_E, SWAPPER_H + SWAPPER_I),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_F + SWAPPER_B / 2, -SWAPPER_E, SWAPPER_H + SWAPPER_I),
  ),
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_F, -SWAPPER_E + SWAPPER_A, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_F + SWAPPER_B / 2, -SWAPPER_E, SWAPPER_H + SWAPPER_I),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_A, -SWAPPER_E + SWAPPER_F, SWAPPER_H),
  ),
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_A, -SWAPPER_E + SWAPPER_F, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_F + SWAPPER_B / 2, -SWAPPER_E, SWAPPER_H + SWAPPER_I),
    swapperPoint(SWAPPER_S + SWAPPER_E, -SWAPPER_E + SWAPPER_F - SWAPPER_B / 2, SWAPPER_H + SWAPPER_I),
  ),
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_A, -SWAPPER_E + SWAPPER_F, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E, -SWAPPER_E + SWAPPER_F - SWAPPER_B / 2, SWAPPER_H + SWAPPER_I),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_A, -SWAPPER_E + SWAPPER_C - SWAPPER_D, SWAPPER_H),
  ),
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_A, -SWAPPER_E + SWAPPER_C - SWAPPER_D, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E, -SWAPPER_E + SWAPPER_F - SWAPPER_B / 2, SWAPPER_H + SWAPPER_I),
    swapperPoint(SWAPPER_S + SWAPPER_E, -SWAPPER_E + SWAPPER_C - SWAPPER_J, SWAPPER_H + SWAPPER_I),
  ),
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_A, -SWAPPER_E + SWAPPER_C - SWAPPER_D, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E, -SWAPPER_E + SWAPPER_C - SWAPPER_J, SWAPPER_H + SWAPPER_I),
    swapperPoint(SWAPPER_S + SWAPPER_E, -SWAPPER_E + SWAPPER_C, SWAPPER_H),
  ),
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_C, -SWAPPER_E, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_C + SWAPPER_D, -SWAPPER_E - SWAPPER_A, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_C + SWAPPER_J, -SWAPPER_E, SWAPPER_H + SWAPPER_I),
  ),
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_C + SWAPPER_J, -SWAPPER_E, SWAPPER_H + SWAPPER_I),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_C + SWAPPER_D, -SWAPPER_E - SWAPPER_A, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_F + SWAPPER_B / 2, -SWAPPER_E, SWAPPER_H + SWAPPER_I),
  ),
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_F + SWAPPER_B / 2, -SWAPPER_E, SWAPPER_H + SWAPPER_I),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_C + SWAPPER_D, -SWAPPER_E - SWAPPER_A, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_F + SWAPPER_B, -SWAPPER_E - SWAPPER_A, SWAPPER_H),
  ),
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_F + SWAPPER_B / 2, -SWAPPER_E, SWAPPER_H + SWAPPER_I),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_F + SWAPPER_B, -SWAPPER_E - SWAPPER_A, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E, -SWAPPER_E + SWAPPER_F - SWAPPER_B / 2, SWAPPER_H + SWAPPER_I),
  ),
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E, -SWAPPER_E + SWAPPER_F - SWAPPER_B / 2, SWAPPER_H + SWAPPER_I),
    swapperPoint(SWAPPER_S + SWAPPER_E - SWAPPER_F + SWAPPER_B, -SWAPPER_E - SWAPPER_A, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E + SWAPPER_A, -SWAPPER_E + SWAPPER_F - SWAPPER_B, SWAPPER_H),
  ),
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E, -SWAPPER_E + SWAPPER_F - SWAPPER_B / 2, SWAPPER_H + SWAPPER_I),
    swapperPoint(SWAPPER_S + SWAPPER_E + SWAPPER_A, -SWAPPER_E + SWAPPER_F - SWAPPER_B, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E, -SWAPPER_E + SWAPPER_C - SWAPPER_J, SWAPPER_H + SWAPPER_I),
  ),
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E, -SWAPPER_E + SWAPPER_C - SWAPPER_J, SWAPPER_H + SWAPPER_I),
    swapperPoint(SWAPPER_S + SWAPPER_E + SWAPPER_A, -SWAPPER_E + SWAPPER_F - SWAPPER_B, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E + SWAPPER_A, -SWAPPER_E + SWAPPER_C - SWAPPER_D, SWAPPER_H),
  ),
  swapperTriangle(
    swapperPoint(SWAPPER_S + SWAPPER_E, -SWAPPER_E + SWAPPER_C, SWAPPER_H),
    swapperPoint(SWAPPER_S + SWAPPER_E, -SWAPPER_E + SWAPPER_C - SWAPPER_J, SWAPPER_H + SWAPPER_I),
    swapperPoint(SWAPPER_S + SWAPPER_E + SWAPPER_A, -SWAPPER_E + SWAPPER_C - SWAPPER_D, SWAPPER_H),
  ),
];

function drawSwapperMesh(
  context: CanvasRenderingContext2D,
  rotationY: number,
  doubleSided: boolean,
  centerX: number,
  centerY: number,
  headlightLevel = 1,
): void {
  const faces: RenderedFace[] = [];
  const mirrors: Array<[number, number]> = [[1, 1], [-1, -1], [1, -1], [-1, 1]];
  const depthMirrors = doubleSided ? [1, -1] : [1];
  const worldCenter = screenCenterToWorld(
    centerX,
    centerY,
    VIEW_CENTER_X,
    VIEW_CENTER_Y,
    WORLD_UNITS_PER_PIXEL,
  );

  for (const [mirrorX, mirrorY] of mirrors) {
    for (const mirrorZ of depthMirrors) {
      for (const triangle of SWAPPER_CORNER_TRIANGLES) {
        const points = triangle.map((point) => {
          const mirrored: Vector3 = [
            point[0] * mirrorX,
            point[1] * mirrorY,
            point[2] * mirrorZ,
          ];
          const swapped = rotateVector(mirrored, 0, rotationY, 0);
          return [
            swapped[0] + worldCenter[0],
            swapped[1] + worldCenter[1],
            swapped[2] + worldCenter[2],
          ] as Vector3;
        }) as Triangle3;
        const normal = normalize(cross(subtract(points[1], points[0]), subtract(points[2], points[0])));
        faces.push({
          points,
          normal,
          depth: (points[0][2] + points[1][2] + points[2][2]) / 3,
        });
      }
    }
  }
  faces.sort((left, right) => left.depth - right.depth);

  context.shadowColor = `rgba(255, 255, 255, ${0.9 * headlightLevel})`;
  context.shadowBlur = 2.5;
  for (const face of faces) {
    const center: Vector3 = [
      (face.points[0][0] + face.points[1][0] + face.points[2][0]) / 3,
      (face.points[0][1] + face.points[1][1] + face.points[2][1]) / 3,
      (face.points[0][2] + face.points[1][2] + face.points[2][2]) / 3,
    ];
    const lightDirection = normalize(subtract(ORIGINAL_LIGHT_POSITION, center));
    const viewDirection = normalize([-center[0], -center[1], -center[2]]);
    const facing = face.normal[0] * viewDirection[0]
      + face.normal[1] * viewDirection[1]
      + face.normal[2] * viewDirection[2];
    const normal: Vector3 = facing >= 0
      ? face.normal
      : [-face.normal[0], -face.normal[1], -face.normal[2]];
    const halfDirection = normalize([
      lightDirection[0] + viewDirection[0],
      lightDirection[1] + viewDirection[1],
      lightDirection[2] + viewDirection[2],
    ]);
    const diffuse = Math.max(0, normal[0] * lightDirection[0]
      + normal[1] * lightDirection[1]
      + normal[2] * lightDirection[2]);
    const halfLight = Math.max(0, normal[0] * halfDirection[0]
      + normal[1] * halfDirection[1]
      + normal[2] * halfDirection[2]);
    const light = (0.035 + diffuse) * headlightLevel;
    const specular = 0.5 * Math.pow(halfLight, 10) * headlightLevel;
    context.beginPath();
    face.points.forEach((point, index) => {
      const [x, y] = projectWorldPoint(
        point,
        VIEW_CENTER_X,
        VIEW_CENTER_Y,
        WORLD_UNITS_PER_PIXEL,
      );
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
    context.fillStyle = colorToCss([0.88, 0.89, 0.96], light, specular);
    context.fill();
    context.shadowBlur = 0;
    context.strokeStyle = `rgba(8, 8, 20, ${0.45 * headlightLevel})`;
    context.lineWidth = 0.45;
    context.stroke();
  }
}

function drawCursor(context: CanvasRenderingContext2D, snapshot: GameSnapshot): void {
  if (!swapperVisible(snapshot.status)) return;
  const position = logicalToScreen(
    snapshot.cursorRenderX,
    snapshot.cursorRenderY,
    snapshot.rise + snapshot.impactOffsetRows,
  );
  const centerX = position.x + CELL_SIZE;
  const centerY = position.y + CELL_SIZE / 2;
  drawSwapperMesh(
    context,
    snapshot.swapProgress * Math.PI,
    snapshot.swapProgress > 0,
    centerX,
    centerY,
    snapshot.headlightLevel,
  );
}

function drawDeathSparks(
  context: CanvasRenderingContext2D,
  sparks: DeathSpark[],
  now: number,
): void {
  if (sparks.length === 0) return;
  const detailedShadows = sparks.length <= DEATH_SPARK_SHADOW_THRESHOLD;
  const whiteTexture = sparkleTexture("four", WHITE_STAR_COLOR);

  // Drawing hundreds of stars with save/translate/rotate/restore and a live
  // shadow filter caused the occasional long frame. Keep the same particles,
  // but batch their transforms and disable only the tiny shadow blur at high
  // particle counts. The white pulse is a fixed cached overlay, so it no
  // longer synthesizes a new 64px texture for every shade on every frame.
  context.save();
  for (const spark of sparks) {
    const texture = sparkleTexture("four", BLOCK_COLORS[spark.flavor]);
    if (!texture) continue;
    const visual = deathSparkVisualAt(spark, now);
    const x = BOARD_X + visual.x * CELL_SIZE;
    const y = BOARD_BOTTOM - visual.y * CELL_SIZE;
    const size = CELL_SIZE * 0.2 * spark.size;
    const cosine = Math.cos(visual.rotation);
    const sine = Math.sin(visual.rotation);

    context.setTransform(cosine, sine, -sine, cosine, x, y);
    context.globalAlpha = visual.alpha;
    context.shadowColor = DEATH_SPARK_SHADOW_COLORS[spark.flavor];
    context.shadowBlur = detailedShadows ? 1.5 : 0;
    context.drawImage(texture, -size / 2, -size / 2, size, size);

    if (whiteTexture && visual.pulse > 0) {
      context.globalAlpha = visual.alpha * visual.pulse;
      context.shadowBlur = 0;
      context.drawImage(whiteTexture, -size / 2, -size / 2, size, size);
    }
  }
  context.restore();
}

function drawRewardMote(
  context: CanvasRenderingContext2D,
  mote: RewardMote,
  now: number,
): void {
  const visual = rewardMoteVisualAt(mote, now);
  if (!visual.active) return;
  drawSparkle(
    context,
    mote.style,
    visual.color,
    BOARD_X + visual.x * CELL_SIZE,
    BOARD_BOTTOM - visual.y * CELL_SIZE,
    mote.size * (CELL_SIZE / 5),
    visual.rotation,
    visual.alpha,
    6,
  );
}

function rewardSignImage(
  sign: RewardSign,
  assets: RenderAssets,
): HTMLImageElement | null {
  if (sign.kind === "bonus") return assets.bonusSign;
  if (sign.kind === "magnitude") return assets.magnitudeSigns[sign.value - 4] ?? null;
  return assets.multiplierSigns[sign.value - 2] ?? null;
}

function drawRewardSign(
  context: CanvasRenderingContext2D,
  sign: RewardSign,
  assets: RenderAssets,
  now: number,
): void {
  const image = rewardSignImage(sign, assets);
  if (!imageReady(image)) return;
  const visual = rewardSignVisualAt(sign, now);
  const baseHeight = CELL_SIZE * 0.66;
  const baseWidth = baseHeight * (image.naturalWidth / image.naturalHeight);
  const centerX = BOARD_X + (sign.x + 0.5) * CELL_SIZE + sign.jitterX;
  const centerY = BOARD_BOTTOM - (sign.y + 0.5) * CELL_SIZE
    - sign.jitterY - visual.verticalMovementRows * CELL_SIZE;

  context.save();
  context.globalAlpha = visual.alpha;
  context.translate(centerX, centerY);
  context.scale(visual.scale, visual.scale);
  context.drawImage(image, -baseWidth / 2, -baseHeight / 2, baseWidth, baseHeight);
  context.restore();
}

function drawTransientEffects(
  context: CanvasRenderingContext2D,
  snapshot: GameSnapshot,
  assets: RenderAssets,
): void {
  drawDeathSparks(context, snapshot.deathSparks, snapshot.visualNow);
  for (const mote of snapshot.rewardMotes) {
    drawRewardMote(context, mote, snapshot.visualNow);
  }
  for (const sign of snapshot.rewardSigns) {
    drawRewardSign(context, sign, assets, snapshot.visualNow);
  }
}

function drawCenteredAsset(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement | null,
  width: number,
  height: number,
  centerY = BOARD_TOP + BOARD_HEIGHT / 2,
): void {
  if (!imageReady(image)) return;
  context.drawImage(
    image,
    BOARD_X + BOARD_WIDTH / 2 - width / 2,
    centerY - height / 2,
    width,
    height,
  );
}

function drawCountdownArt(
  context: CanvasRenderingContext2D,
  snapshot: GameSnapshot,
  assets: RenderAssets,
): void {
  if (!snapshot.countdown) return;
  const image = assets.countdown[snapshot.countdown];
  if (!imageReady(image)) return;
  const visual = countdownVisual(snapshot.countdown, snapshot.countdownProgress);
  const centerX = BOARD_X + BOARD_WIDTH / 2;
  let centerY: number;
  let width: number;
  let height: number;

  if (snapshot.countdown === "GO!") {
    centerY = VIEW_CENTER_Y;
    width = CELL_SIZE * visual.scale;
    height = CELL_SIZE * visual.scale * 0.5;
  } else {
    const startY = BOARD_TOP - CELL_SIZE / 2;
    const endY = BOARD_BOTTOM - 4.7 * CELL_SIZE;
    centerY = endY + (startY - endY) * visual.verticalBlend;
    width = CELL_SIZE * visual.scale;
    height = width;
  }

  context.save();
  context.globalAlpha = visual.alpha;
  context.drawImage(image, centerX - width / 2, centerY - height / 2, width, height);
  context.restore();
}

function drawReadyScreen(
  context: CanvasRenderingContext2D,
  snapshot: GameSnapshot,
  assets: RenderAssets,
  highScore: number,
  useTouchPrompt: boolean,
): void {
  const centerX = BOARD_X + BOARD_WIDTH / 2;
  const messageCenterY = VIEW_CENTER_Y - (13 / 6) * CELL_SIZE;
  const pulse = messagePulseAlpha(snapshot.visualNow);
  context.save();
  context.globalAlpha = pulse;
  drawCenteredAsset(
    context,
    useTouchPrompt ? assets.messageTapScreen : assets.messageAnyKey,
    BOARD_WIDTH,
    BOARD_WIDTH / 2,
    messageCenterY,
  );
  context.restore();

  const scoreCenterY = VIEW_CENTER_Y + 1.3 * CELL_SIZE;
  drawCenteredUiText(context, assets, "SCORE TO BEAT:", centerX, scoreCenterY - 52, 30);
  drawCenteredUiText(
    context,
    assets,
    String(scoreToBeat(highScore)),
    centerX,
    scoreCenterY + 3,
    42,
  );
}

function drawGameOverArt(
  context: CanvasRenderingContext2D,
  snapshot: GameSnapshot,
  assets: RenderAssets,
): void {
  if (!imageReady(assets.messageGameOver)) return;
  const centerY = gameOverCenterY(
    snapshot.gameOverElapsedMs,
    BOARD_TOP,
    BOARD_HEIGHT,
    CELL_SIZE / 2,
  );
  const size = CELL_SIZE * 6 * (75 / 64);
  drawCenteredAsset(context, assets.messageGameOver, size, size, centerY);
}

function drawStatusArt(
  context: CanvasRenderingContext2D,
  snapshot: GameSnapshot,
  assets: RenderAssets,
  highScore: number,
  useTouchPrompt: boolean,
): void {
  if (snapshot.countdown) {
    drawCountdownArt(context, snapshot, assets);
  }
  if (snapshot.status === "ready") {
    drawReadyScreen(context, snapshot, assets, highScore, useTouchPrompt);
  } else if (snapshot.status === "paused") {
    context.save();
    context.globalAlpha = messagePulseAlpha(snapshot.pausedElapsedMs);
    drawCenteredAsset(context, assets.messagePaused, BOARD_WIDTH, BOARD_WIDTH / 4);
    context.restore();
  } else if (snapshot.status === "gameover") {
    drawGameOverArt(context, snapshot, assets);
  }
}

export function drawGame(
  context: CanvasRenderingContext2D,
  snapshot: GameSnapshot,
  assets: RenderAssets,
  highScore: number,
  useTouchPrompt = false,
): void {
  if (!frameCanvas && typeof document !== "undefined") {
    frameCanvas = document.createElement("canvas");
    frameCanvas.width = CANVAS_WIDTH;
    frameCanvas.height = CANVAS_HEIGHT;
    frameContext = frameCanvas.getContext("2d");
  }
  const target = frameContext ?? context;
  const effectNow = snapshot.visualNow;
  const boardNow = snapshot.boardVisualNow;
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalAlpha = 1;
  target.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  target.textAlign = "left";
  target.textBaseline = "alphabetic";
  drawBackdrop(target);
  drawLevelLights(target, snapshot);
  drawOpponentLights(target, snapshot);
  drawLogo(target, assets);
  // displayMeta draws the same external candy as live play: the inactive lose
  // bar, four score digits, and the solo record star remain on the key-wait
  // screen alongside Score to Beat.
  drawHud(target, snapshot, assets);
  if (snapshot.status !== "ready") {
    // Displayer::displayPlay omits the grid and swapper while paused, but keeps the
    // external candy, transient effects, and pause message visible.
    if (playfieldVisible(snapshot.status)) {
      target.save();
      target.beginPath();
      target.rect(BOARD_X - 2, BOARD_TOP, BOARD_WIDTH + 4, BOARD_HEIGHT);
      target.clip();

      const garbageGroups = collectGarbage(snapshot);
      const moteLights = rewardMotePointLights(snapshot, effectNow);
      const usedWebGL = drawWebGLBlocks(
        target,
        snapshot,
        assets,
        boardNow,
        garbageGroups,
        moteLights,
      );
      if (!usedWebGL) {
        snapshot.nextRow.forEach((cell, x) => {
          if (!cell || cell.kind !== "block") return;
          const position = logicalToScreen(
            x,
            -1,
            snapshot.rise + snapshot.impactOffsetRows,
          );
          drawBlock(
            target,
            cell,
            assets,
            position.x,
            position.y,
            boardNow,
            true,
            moteLights,
            undefined,
            snapshot.headlightLevel,
          );
        });

        for (const group of garbageGroups) {
          if (group.state === "shattering") {
            for (const { x, y, cell } of group.positions) {
              const motion = motionPosition(cell, x, y, boardNow);
              const position = logicalToScreen(
                motion.x,
                motion.y,
                snapshot.rise + snapshot.impactOffsetRows,
              );
              if (cell.shatterReforms) {
                drawBlockVisual(
                  target,
                  shatteringRetainedSectionVisual(cell, boardNow),
                  assets,
                  position.x,
                  position.y,
                  4,
                  moteLights,
                  snapshot.headlightLevel,
                );
              } else {
                drawBlock(
                  target,
                  shatterProxyBlock(cell),
                  assets,
                  position.x,
                  position.y,
                  boardNow,
                  false,
                  moteLights,
                  undefined,
                  snapshot.headlightLevel,
                );
              }
            }
          } else if (
            group.state === "awakening"
            && group.awakenReleaseAt !== undefined
          ) {
            const retained = retainedGarbageVisual(
              boardNow,
              group.awakenReleaseAt,
              Math.max(1, new Set(group.positions.map(({ y }) => y)).size),
              AWAKEN_FINAL_DELAY_MS,
            );
            for (const { x, y, cell } of group.positions) {
              const motion = motionPosition(cell, x, y, boardNow);
              const position = logicalToScreen(
                motion.x,
                motion.y,
                snapshot.rise + snapshot.impactOffsetRows,
              );
              drawBlockVisual(
                target,
                retainedGarbageSectionVisual(
                  cell.awakenSource ?? "normal",
                  cell.awakenRevealAt ?? boardNow,
                  cell.awakenPopDirection ?? cell.awakenSequence ?? 0,
                  retained.sectionCompression,
                  boardNow,
                ),
                assets,
                position.x,
                position.y,
                4,
                moteLights,
                snapshot.headlightLevel,
              );
            }
          }
        }

        for (let y = 0; y < snapshot.board.length; y += 1) {
          for (let x = 0; x < BOARD_COLUMNS; x += 1) {
            const cell = snapshot.board[y][x];
            if (cell?.kind !== "block") continue;
            const motion = motionPosition(cell, x, y, boardNow);
            const position = logicalToScreen(
              motion.x,
              motion.y,
              snapshot.rise + snapshot.impactOffsetRows,
            );
            drawBlock(
              target,
              cell,
              assets,
              position.x,
              position.y,
              boardNow,
              false,
              moteLights,
              motion,
              snapshot.headlightLevel,
            );
          }
        }
      }

      // Canvas fallback and front decals follow the same far-to-near group order.
      // The normal WebGL path resolves the solids per pixel with the depth buffer.
      const garbagePaintOrder = [...garbageGroups].sort((left, right) => (
        Math.max(...right.positions.map(({ y }) => y))
          - Math.max(...left.positions.map(({ y }) => y))
      ));
      for (const group of garbagePaintOrder) {
        drawGarbage(target, group, snapshot, assets, boardNow, !usedWebGL, moteLights);
      }
      target.restore();

      // The original swapper protrudes slightly beyond the six-column grid at
      // either edge. Draw it after restoring the board clip so its outer claws
      // remain visible instead of being sliced off at x=0 or x=5.
      target.save();
      drawCursor(target, snapshot);
      target.restore();

      if (snapshot.status === "gameover") {
        const mask = gameOverMaskBounds(
          BOARD_X,
          BOARD_TOP,
          BOARD_WIDTH,
          BOARD_HEIGHT,
          CELL_SIZE,
        );
        target.fillStyle = `rgba(0, 0, 0, ${
          clamp(snapshot.gameOverElapsedMs / GAME_OVER_BOARD_FADE_MS)
        })`;
        target.fillRect(mask.x, mask.y, mask.width, mask.height);
      }
    }

    drawTransientEffects(target, snapshot, assets);
  }
  drawStatusArt(target, snapshot, assets, highScore, useTouchPrompt);

  if (frameCanvas && frameContext) {
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    context.drawImage(frameCanvas, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }
}

export function canvasPointToBoard(
  canvasX: number,
  canvasY: number,
  rise: number,
): { x: number; y: number } | null {
  if (
    canvasX < BOARD_X
    || canvasX >= BOARD_X + BOARD_WIDTH
    || canvasY < BOARD_TOP
    || canvasY >= BOARD_BOTTOM
  ) return null;

  const cellX = Math.floor((canvasX - BOARD_X) / CELL_SIZE);
  const logicalY = Math.floor((BOARD_BOTTOM - canvasY) / CELL_SIZE - rise);
  return {
    x: Math.max(0, Math.min(BOARD_COLUMNS - 1, cellX)),
    y: Math.max(0, Math.min(VISIBLE_ROWS - 1, logicalY)),
  };
}
