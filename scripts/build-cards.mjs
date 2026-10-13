// Renders every project card in scripts/cards.json to a fixed-width image
// (light + dark), then rewrites the card blocks in README.md.
//
// Why images: GitHub strips CSS, so HTML tables cannot reflow on phones.
// Fixed-width inline images wrap like words instead: three per row on
// desktop, one per row on a phone.
//
// Run from the repo root: node scripts/build-cards.mjs   (needs Google Chrome)

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CARD_WIDTH = 260; // CSS px as shown in the README; rendered at 2x
const PORT = 9334;
const data = JSON.parse(readFileSync(join(ROOT, "scripts/cards.json"), "utf8"));

const THEMES = {
  light: { bg: "#ffffff", border: "#d0d7de", ink: "#1f2328", muted: "#59636e", chip: "rgba(175,184,193,0.2)", link: "#0969da" },
  dark: { bg: "#0d1117", border: "#3d444d", ink: "#f0f6fc", muted: "#9198a1", chip: "rgba(101,108,118,0.2)", link: "#4493f8" },
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const imgUrl = (file) => pathToFileURL(join(ROOT, "assets/projects", file)).href;

function cardHtml(c, group, theme) {
  const shot = theme === "dark" && c.imageDark ? c.imageDark : c.image;
  const body = c.bullets
    ? `<p class="sub">${esc(c.subtitle)}</p><ul>${c.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`
    : `<p>${esc(c.text)}</p>`;
  const footer = group === "client" ? "" : `<div class="go">${esc(c.linkLabel ?? "Live site")} →</div>`;
  return `<div class="card" data-group="${group}" data-slug="${c.slug}">
    <img src="${imgUrl(shot)}">
    <h3>${esc(c.title)}</h3>${body}
    <div class="chips">${c.chips.map((x) => `<code>${esc(x)}</code>`).join("")}</div>
    <div class="spacer"></div>${footer}
  </div>`;
}

function pageHtml(theme) {
  const t = THEMES[theme];
  const cards = Object.entries({ client: data.client, featured: data.featured })
    .flatMap(([group, list]) => list.map((c) => cardHtml(c, group, theme)))
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; background: transparent; }
    body { display: flex; flex-wrap: wrap; gap: 20px; padding: 20px; width: 1000px;
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; color: ${t.ink}; }
    .card { box-sizing: border-box; width: ${CARD_WIDTH}px; display: flex; flex-direction: column;
      background: ${t.bg}; border: 1px solid ${t.border}; border-radius: 8px; padding: 12px; }
    .card img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border-radius: 4px; display: block; }
    h3 { font-size: 18px; font-weight: 600; margin: 12px 0 6px; }
    p { margin: 0 0 10px; }
    .sub { color: ${t.muted}; }
    ul { margin: 0 0 10px; padding-left: 18px; }
    li { margin: 2px 0; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; }
    code { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: ${t.chip};
      border-radius: 6px; padding: 1px 6px; white-space: nowrap; }
    .spacer { flex: 1; min-height: 10px; }
    .go { color: ${t.link}; font-weight: 600; }
  </style>${cards}`;
}

// --- minimal Chrome DevTools Protocol client ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, "--hide-scrollbars",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "cards-"))}`, "about:blank"], { stdio: "ignore" });
const watchdog = setTimeout(() => { console.error("timed out"); chrome.kill(); process.exit(1); }, 120000);
let targets;
for (let i = 0; i < 50 && !targets; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await sleep(200); }
}
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

await send("Emulation.setDeviceMetricsOverride", { width: 1040, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
await send("Page.enable");
mkdirSync(join(ROOT, "assets/cards"), { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "cards-page-"));

for (const theme of Object.keys(THEMES)) {
  const file = join(tmp, `${theme}.html`);
  writeFileSync(file, pageHtml(theme));
  await send("Page.navigate", { url: pathToFileURL(file).href });
  await sleep(1500);
  // Same height within a group, so each row lines up.
  const rects = await evaluate(`(async () => {
    await Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => i.onload = i.onerror = r)));
    for (const g of ["client", "featured"]) {
      const cs = [...document.querySelectorAll('.card[data-group="' + g + '"]')];
      const h = Math.max(...cs.map(c => c.offsetHeight));
      cs.forEach(c => c.style.height = h + "px");
    }
    return [...document.querySelectorAll(".card")].map(c => { const r = c.getBoundingClientRect();
      return { slug: c.dataset.slug, x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; });
  })()`);
  for (const r of rects) {
    const { data: b64 } = await send("Page.captureScreenshot", { format: "webp", quality: 90, captureBeyondViewport: true,
      clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 } });
    writeFileSync(join(ROOT, "assets/cards", `${r.slug}-${theme}.webp`), Buffer.from(b64, "base64"));
  }
  console.log(`${theme}: ${rects.length} cards`);
}
ws.close(); chrome.kill(); clearTimeout(watchdog);

// --- rewrite the card blocks in README.md ---
const cardLink = (c) => `<a href="${c.href}"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/cards/${c.slug}-dark.webp">
  <img src="assets/cards/${c.slug}-light.webp" width="${CARD_WIDTH}" alt="${esc(c.title)}: ${esc(c.text ?? c.subtitle)}">
</picture></a>`;
const block = (list) => `<p align="center">\n${list.map(cardLink).join("\n")}\n</p>`;
const sourceLinks = data.featured.flatMap((c) => [
  ...(c.code ? [`<a href="${c.code}">${esc(c.codeLabel ?? c.title)}</a>`] : []),
  ...(c.extraCode ?? []).map((x) => `<a href="${x.href}">${esc(x.label)}</a>`),
]);
const featured = `${block(data.featured)}\n\n<p align="center"><b>Source code:</b> ${sourceLinks.join(" · ")}</p>`;

let readme = readFileSync(join(ROOT, "README.md"), "utf8");
for (const [name, html] of [["client", block(data.client)], ["featured", featured]]) {
  const re = new RegExp(`(<!-- cards:${name} -->)[\\s\\S]*?(<!-- /cards:${name} -->)`);
  if (!re.test(readme)) throw new Error(`README is missing the <!-- cards:${name} --> markers`);
  readme = readme.replace(re, (_, open, close) => `${open}\n${html}\n${close}`);
}
writeFileSync(join(ROOT, "README.md"), readme);
console.log("README.md updated");
