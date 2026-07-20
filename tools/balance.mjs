// 引き抜き層 — 均衡の掃引
//
// 実時間を待たずに step(dt) でゲームを進め、反応遅れつきの自動操縦を2種類走らせる。
//   greedy : 引き抜いた結果の消去数が最大の列を選ぶ
//   random : 引き抜ける列から無作為に選ぶ
// 両者の差がゲームの「どこを抜くか」に意味があるかを示す。差が無ければ選択は飾り。
//
// 使い方: node tools/balance.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PORT = 9222 + Math.floor(Math.random() * 900);   // 実行ごとに変える
const PROFILE = mkdtempSync(join(tmpdir(), "pullout-cdp-"));
const PAGE = pathToFileURL(new URL("../index.html", import.meta.url).pathname).href;

const chrome = spawn("google-chrome", [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  PAGE,
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
ws.addEventListener("message", e => {
  const m = JSON.parse(e.data);
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); p(m); }
});
function send(method, params) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
}

async function evalJS(expr) {
  const m = await send("Runtime.evaluate", {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  if (m.result?.exceptionDetails) {
    throw new Error(JSON.stringify(m.result.exceptionDetails.exception?.description
      ?? m.result.exceptionDetails));
  }
  return m.result.result.value;
}

// ページ側に置く試行ルーチン。1回の evaluate で1試行を丸ごと回す。
const TRIAL = String.raw`
window.__trial = function (opts) {
  const g = window.__game;
  const { mode, seed, cap, delay, params } = opts;

  // 種つき乱数に差し替えて試行間を揃える
  let s = seed >>> 0;
  Math.random = function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  g.setParams(params);
  g.newGame();

  const ROWS = g.ROWS, COLS = g.COLS;

  // 盤面の写しに対して「その列を引き抜いたら何マス消えるか」を数える
  function clearedIfPull(grid, col) {
    const gg = grid.map(r => r.slice());
    for (let r = ROWS - 1; r > 0; r--) gg[r][col] = gg[r - 1][col];
    gg[0][col] = -1;
    const seen = gg.map(r => r.map(() => false));
    let total = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (seen[r][c] || gg[r][c] < 0) continue;
      const color = gg[r][c], stack = [[r, c]], group = [];
      seen[r][c] = true;
      while (stack.length) {
        const [y, x] = stack.pop();
        group.push([y, x]);
        for (const [ny, nx] of [[y-1,x],[y+1,x],[y,x-1],[y,x+1]]) {
          if (ny < 0 || ny >= ROWS || nx < 0 || nx >= COLS) continue;
          if (seen[ny][nx] || gg[ny][nx] !== color) continue;
          seen[ny][nx] = true;
          stack.push([ny, nx]);
        }
      }
      if (group.length >= 3) total += group.length;
    }
    return total;
  }

  function decide(grid, heights) {
    const pullable = [];
    for (let c = 0; c < COLS; c++) if (grid[ROWS - 1][c] >= 0) pullable.push(c);
    if (!pullable.length) return -1;
    if (mode === "random") return pullable[(Math.random() * pullable.length) | 0];
    // human: 盤面全部は読めない。目についた数列だけを見て、その中で最善を選ぶ
    if (mode === "human") {
      const look = pullable.slice();
      for (let i = look.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const tmp = look[i]; look[i] = look[j]; look[j] = tmp;
      }
      const sub = look.slice(0, 4);
      let b = sub[0], bs = -1, bh = -1;
      for (const c of sub) {
        const sc = clearedIfPull(grid, c);
        if (sc > bs || (sc === bs && heights[c] > bh)) { b = c; bs = sc; bh = heights[c]; }
      }
      return b;
    }
    // greedy: 消去数が最大の列。同点なら最も高い列を削る
    let best = -1, bestScore = -1, bestH = -1;
    for (const c of pullable) {
      const sc = clearedIfPull(grid, c);
      if (sc > bestScore || (sc === bestScore && heights[c] > bestH)) {
        best = c; bestScore = sc; bestH = heights[c];
      }
    }
    return best;
  }

  const dt = 1 / 60;
  let t = 0, planned = null, plannedAt = -1;
  let hSum = 0, hLate = 0, nLate = 0, hMax = 0, samples = 0, chainEvents = 0, lastChain = 0, pulls = 0;

  while (t < cap && g.state !== "over") {
    // 反応遅れ: クールダウンが明けた瞬間の盤面を見て、delay 秒後にその判断で打つ
    if (g.cd <= 0 && g.state === "playing") {
      if (planned === null) {
        planned = decide(g.grid(), g.heights());
        plannedAt = t;
      } else if (t - plannedAt >= delay) {
        if (planned >= 0 && g.canPull(planned)) { g.pull(planned); pulls++; }
        planned = null;
      }
    } else if (g.cd > 0) {
      planned = null;
    }

    g.step(dt);
    t += dt;

    if (g.maxChain > lastChain) { chainEvents++; lastChain = g.maxChain; }

    if (samples % 6 === 0) {
      const h = g.heights();
      const avg = h.reduce((a, b) => a + b, 0) / COLS;
      hSum += avg;
      if (t > 30) { hLate += avg; nLate++; }
      hMax = Math.max(hMax, Math.max.apply(null, h));
    }
    samples++;
  }

  const hs = g.heights();
  return {
    mode, seed,
    died: g.state === "over",
    time: +t.toFixed(1),
    cleared: g.cleared,
    spawned: g.spawned,
    dropped: g.spawnTries - g.spawned,
    maxChain: g.maxChain,
    pulls,
    lateHeight: +(hLate / Math.max(1, nLate)).toFixed(2),
    avgHeight: +(hSum / Math.max(1, Math.floor(samples / 6))).toFixed(2),
    peakHeight: hMax,
    finalHeight: +(hs.reduce((a, b) => a + b, 0) / COLS).toFixed(2),
  };
};
true;
`;

await evalJS(TRIAL);

function summarize(rows) {
  const n = rows.length;
  const mean = k => +(rows.reduce((a, r) => a + r[k], 0) / n).toFixed(2);
  const deaths = rows.filter(r => r.died);
  return {
    死亡率: `${deaths.length}/${n}`,
    生存秒: mean("time"),
    平均高: mean("avgHeight"),
    後半高: mean("lateHeight"),
    最高到達: mean("peakHeight"),
    消去: mean("cleared"),
    出現: mean("spawned"),
    出現失敗: mean("dropped"),
    最大連鎖: mean("maxChain"),
    連鎖2以上: rows.filter(r => r.maxChain >= 2).length,
  };
}

const CONFIGS = JSON.parse(process.env.CONFIGS ?? "null") ?? [
  { name: "現状", params: {} },
];
const TRIALS = +(process.env.TRIALS ?? 8);
const CAP = +(process.env.CAP ?? 200);
const DELAY = +(process.env.DELAY ?? 0.25);

for (const cfg of CONFIGS) {
  const out = {};
  for (const mode of ["greedy", "human", "random"]) {
    const rows = [];
    for (let i = 0; i < TRIALS; i++) {
      rows.push(await evalJS(
        `__trial(${JSON.stringify({ mode, seed: 1000 + i * 77, cap: CAP, delay: DELAY, params: cfg.params })})`
      ));
    }
    out[mode] = summarize(rows);
  }
  console.log(`\n=== ${cfg.name} ${JSON.stringify(cfg.params)}`);
  console.table(out);
}

ws.close();
cleanup();
process.exit(0);
