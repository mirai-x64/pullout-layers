// 実描画・実クリックでの確認。
// balance.mjs は step() だけを回して draw() を一度も通らないので、
// 描画とヒットテストはここでしか確かめられない。
//
// 使い方: node tools/playtest.mjs [秒数]

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SECONDS = +(process.argv[2] ?? 75);
const PORT = 9222 + Math.floor(Math.random() * 900);
const PROFILE = mkdtempSync(join(tmpdir(), "pullout-play-"));
const PAGE = pathToFileURL(new URL("../index.html", import.meta.url).pathname).href;

const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  `--window-size=${process.env.WINDOW ?? "760,660"}`, PAGE,
], { stdio: "ignore" });

function cleanup() {
  try { chrome.kill("SIGKILL"); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

async function wsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const t = (await r.json()).find(x => x.type === "page" && x.webSocketDebuggerUrl);
      if (t) return t.webSocketDebuggerUrl;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("CDP に繋がらない");
}

const ws = new WebSocket(await wsUrl());
await new Promise(r => ws.addEventListener("open", r, { once: true }));

let seq = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", e => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    errors.push(m.params.exceptionDetails.exception?.description
      ?? m.params.exceptionDetails.text);
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errors.push(m.params.args.map(a => a.value ?? a.description).join(" "));
  }
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); p(m); }
});
function send(method, params) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
}
async function evalJS(expression) {
  const m = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const ex = m.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex));
  return m.result.result.value;
}

await send("Runtime.enable");
await send("Page.enable");
await new Promise(r => setTimeout(r, 600));

const rect = await evalJS(`(() => {
  const r = document.getElementById("cv").getBoundingClientRect();
  const g = window.__game;
  return { x: r.left, y: r.top, w: r.width, h: r.height, cols: g.COLS, rows: g.ROWS };
})()`);

// 列の中心・最下段の座標
function cellPoint(col) {
  const cw = rect.w / rect.cols;
  const ch = rect.h / rect.rows;   // 概算。最下段さえ当たればよい
  return {
    x: Math.round(rect.x + cw * (col + 0.5)),
    y: Math.round(rect.y + rect.h - ch * 0.8),
  };
}

async function click(col) {
  const { x, y } = cellPoint(col);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0,
    });
  }
}

// 実クリックで引き抜けるか（最初の1回を単体で確かめる）
await new Promise(r => setTimeout(r, 2500));
const before = await evalJS(`JSON.stringify({h: __game.heights(), t: __game.t})`);
let clickWorks = false;
for (let c = 0; c < rect.cols && !clickWorks; c++) {
  if (await evalJS(`__game.canPull(${c})`)) {
    const h0 = await evalJS(`__game.heights()[${c}]`);
    await click(c);
    await new Promise(r => setTimeout(r, 120));
    const h1 = await evalJS(`__game.heights()[${c}]`);
    clickWorks = h1 === h0 - 1;
    console.log(`実クリック: 列${c} 高さ ${h0} -> ${h1} : ${clickWorks ? "引き抜けた" : "変化なし"}`);
  }
}

// 全列を見て最善を選ぶ自動操縦を、実時間・実クリックで回す
const AI = String.raw`
window.__pick = function () {
  const g = window.__game, ROWS = g.ROWS, COLS = g.COLS, grid = g.grid(), hs = g.heights();
  function cleared(col) {
    const gg = grid.map(r => r.slice());
    for (let r = ROWS - 1; r > 0; r--) gg[r][col] = gg[r - 1][col];
    gg[0][col] = -1;
    const seen = gg.map(r => r.map(() => false));
    let total = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (seen[r][c] || gg[r][c] < 0) continue;
      const color = gg[r][c], st = [[r, c]], grp = [];
      seen[r][c] = true;
      while (st.length) {
        const [y, x] = st.pop(); grp.push([y, x]);
        for (const [ny, nx] of [[y-1,x],[y+1,x],[y,x-1],[y,x+1]]) {
          if (ny < 0 || ny >= ROWS || nx < 0 || nx >= COLS) continue;
          if (seen[ny][nx] || gg[ny][nx] !== color) continue;
          seen[ny][nx] = true; st.push([ny, nx]);
        }
      }
      if (grp.length >= 3) total += grp.length;
    }
    return total;
  }
  let best = -1, bs = -1, bh = -1;
  for (let c = 0; c < COLS; c++) {
    if (!g.canPull(c)) continue;
    const sc = cleared(c);
    if (sc > bs || (sc === bs && hs[c] > bh)) { best = c; bs = sc; bh = hs[c]; }
  }
  return best;
};
true;`;
await evalJS(AI);

const shots = [];
const t0 = Date.now();
let peak = 0;
while ((Date.now() - t0) / 1000 < SECONDS) {
  const st = await evalJS(`JSON.stringify({s: __game.state, cd: __game.cd, t: __game.t,
    h: __game.heights(), cl: __game.cleared, mc: __game.maxChain})`);
  const g = JSON.parse(st);
  peak = Math.max(peak, Math.max(...g.h));
  if (g.s === "over") { console.log(`天井に到達: ${g.t.toFixed(1)}s 消去${g.cl} 最大連鎖${g.mc}`); break; }
  if (g.s === "playing" && g.cd <= 0) {
    const col = await evalJS(`__pick()`);
    if (col >= 0) {
      await new Promise(r => setTimeout(r, 320));   // 人間相当の反応遅れ
      await click(col);
    }
  }
  // 山が育ったところを1枚撮る
  if (!shots.length && Math.max(...g.h) >= 6) {
    const img = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync("/tmp/pullout-mid.png", Buffer.from(img.result.data, "base64"));
    shots.push("mid");
    console.log(`山が育った場面を撮影: 最高列 ${Math.max(...g.h)} 段 (t=${g.t.toFixed(1)}s)`);
  }
  await new Promise(r => setTimeout(r, 60));
}

const fin = JSON.parse(await evalJS(`JSON.stringify({s: __game.state, t: __game.t,
  cl: __game.cleared, mc: __game.maxChain, h: __game.heights()})`));
const img = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/pullout-end.png", Buffer.from(img.result.data, "base64"));

console.log("\n--- 実描画・実クリックでの結果 ---");
console.log(`状態: ${fin.s} / 経過 ${fin.t.toFixed(1)}s / 消去 ${fin.cl} / 最大連鎖 ${fin.mc}`);
console.log(`到達した最高の山: ${peak} 段`);
console.log(`実クリックでの引き抜き: ${clickWorks ? "成立" : "不成立"}`);
console.log(`JS エラー: ${errors.length ? errors.join("\n") : "なし"}`);

ws.close();
cleanup();
process.exit(0);
