import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(projectRoot, "dist-pages");
const htmlPath = resolve(outputRoot, "index.html");

assert.ok(existsSync(htmlPath), "GitHub Pages build must emit index.html");
const html = readFileSync(htmlPath, "utf8");
assert.match(html, /<title>Crack Attack! — Browser Port<\/title>/);

function metaContent(property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = html.match(new RegExp(
    `<meta\\b[^>]*\\bproperty=["']${escaped}["'][^>]*>`,
    "i",
  ))?.[0];
  return tag?.match(/\bcontent=["']([^"']*)["']/i)?.[1] ?? null;
}

// This build is relocatable: `base: "./"` means it runs from any origin and any
// subdirectory. Metadata that names one specific host would be wrong everywhere
// else, and a canonical pointing at another site tells crawlers this page is a
// copy. Assert the relocatable shape instead of a fixed URL.
assert.doesNotMatch(
  html,
  /<link\b[^>]*\brel=["']canonical["']/i,
  "a relocatable build must not claim a canonical host",
);
assert.equal(
  metaContent("og:url"),
  null,
  "og:url must be omitted so scrapers fall back to the URL actually shared",
);
assert.equal(metaContent("og:title"), "Crack Attack! — Browser Port");
assert.equal(metaContent("og:type"), "website");
assert.equal(
  metaContent("og:description"),
  "A browser port of the open-source puzzle game Crack Attack! Play solo, or send a friend a challenge link.",
);
// Relative, so a Discord or Slack preview loads the logo from whatever host is
// actually serving the page rather than hotlinking the upstream fork's copy.
assert.equal(metaContent("og:image"), "./crack-attack-assets/logo.png");
assert.equal(metaContent("og:image:type"), "image/png");
assert.equal(metaContent("og:image:width"), "256");
assert.equal(metaContent("og:image:height"), "256");
assert.equal(metaContent("og:image:alt"), "Crack Attack! game logo");
assert.equal(metaContent("og:site_name"), "Crack Attack! — Browser Port");
assert.equal(metaContent("og:locale"), "en_US");
assert.doesNotMatch(
  html,
  /(?:href|src)=["']\/(?!\/)/,
  "GitHub Pages HTML must not use origin-root asset URLs",
);

for (const asset of [
  "COPYING.txt",
  "crack-attack-assets/block.obj",
  "crack-attack-assets/logo.png",
  "crack-attack-assets/font0_score.png",
  "crack-attack-assets/message_game_over.png",
]) {
  assert.ok(existsSync(resolve(outputRoot, asset)), `Missing Pages asset: ${asset}`);
}

const javaScriptFiles = readdirSync(resolve(outputRoot, "assets"))
  .filter((filename) => filename.endsWith(".js"));
assert.ok(javaScriptFiles.length > 0, "GitHub Pages build must emit a JavaScript bundle");
const javaScript = javaScriptFiles
  .map((filename) => readFileSync(resolve(outputRoot, "assets", filename), "utf8"))
  .join("\n");
assert.match(javaScript, /crack-attack-assets\//);
assert.match(javaScript, /logo\.png/);
assert.doesNotMatch(
  javaScript,
  /["'`]\/crack-attack-assets\//,
  "the game bundle must resolve artwork beneath the Pages project path",
);

console.log("Validated relocatable static artifact (any origin, any subpath).");
