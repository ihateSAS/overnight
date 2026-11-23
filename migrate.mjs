// Overnight: migrate a CommonJS package to native ES modules with Kimi K3.1 Pro on Cerebras,
// one streaming call per file, all files at once, then prove it with the package's own tests.
//
//   node migrate.mjs                 migrate targets/express-cjs -> targets/express-esm and test
//   node migrate.mjs --no-test       skip the test run
//
// Speed is read the way Cerebras reports it: usage.completion_tokens / time_info.completion_time
// from the last stream chunk of each call (server-side decode). "Combined" is all output tokens
// divided by wall-clock seconds from the first request to the last file written, so it includes
// queueing and network and flatters nothing.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const MODEL = process.env.OVERNIGHT_MODEL || "moonshotai-kimi-k3.1-pro-trial";
const BASE = (process.env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1").replace(/\/$/, "");

function apiKey() {
  if (process.env.CEREBRAS_API_KEY) return process.env.CEREBRAS_API_KEY.trim();
  try {
    const env = fs.readFileSync(path.join(HERE, ".env"), "utf8");
    return (env.match(/^CEREBRAS_API_KEY=(.+)$/m) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}

export const RULES = `You convert one Node.js CommonJS module to native ES module syntax. Reply with the complete converted file and nothing else: no Markdown fences, no commentary.

Rules:
1. Copy every line that does not involve require, exports or module.exports exactly as it is, including comments, blank lines and 'use strict'.
2. Top-level require of a package or node: builtin becomes an import at the same place. Packages use a default import: var x = require('x') -> import x from 'x'. A property of a package, var y = require('x').y, becomes import x from 'x' followed by var y = x.y (reuse one import per package). node: builtins may use named imports: var y = require('node:x').y -> import { y } from 'node:x'.
3. A called require such as var debug = require('debug')('ns') becomes import createDebug from 'debug' then var debug = createDebug('ns').
4. Local files (paths starting with ./) get an explicit .js extension. When the source reads a property of a local file, import that name directly and merge names from the same file into one import: var a = require('./utils').a; var b = require('./utils').b; -> import { a, b } from './utils.js'; Never default-import a local file whose properties are read. var X = require('./view') with no property -> import X from './view.js'.
5. A module that sets exports.name = value exports each name: write export const name = value, or export function name for function expressions, and replace later uses of exports.name inside the file with the bare name. Name clash: if the file already imports or declares that name (for example exports.etag in a file that also does require('etag')), keep the import as it is, write const _etag = value; export { _etag as etag }; and replace exports.etag with _etag.
6. A module that sets module.exports = X (also written exports = module.exports = X) exports X twice, right there: export default X; then export { X as 'module.exports' }; so require() callers keep working. If such a module later sets exports.name = value, write X.name = value instead.
7. A require inside a function body stays a require: add import { createRequire } from 'node:module'; and const require = createRequire(import.meta.url); after the other imports.
8. Do not rename, reorder or reformat anything else.`;

export async function listFiles(root, rel = "lib") {
  const dir = path.join(root, rel);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(rel, f))
    .sort();
}

function stripFences(text) {
  const t = text.replace(/^\s*```[a-z]*\n/i, "").replace(/\n```\s*$/i, "");
  return t.endsWith("\n") ? t : t + "\n";
}

// Split a file at top-level boundaries (a blank line followed by a line that starts in column 0),
// never before the last top-level require, and pack the pieces to about `target` characters.
export function splitFile(source, target = Number(process.env.OVERNIGHT_PIECE_CHARS || 5100)) {
  const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
  let lastRequire = 0;
  lines.forEach((l, i) => { if (/^\S.*\brequire\(/.test(l) || /^(var|let|const)\b.*\brequire\(/.test(l)) lastRequire = i; });
  const starts = [0];
  for (let i = lastRequire + 1; i < lines.length; i++) {
    if (lines[i - 1] === "" && /^[^\s})\]]/.test(lines[i])) starts.push(i);
  }
  // Balanced cut: as many parts as the target size needs, each cut at the boundary nearest an equal share,
  // so no single piece is left much bigger than the others (the biggest piece sets the wall clock).
  const offs = [];
  let acc = 0;
  for (const l of lines) { offs.push(acc); acc += l.length + 1; }
  const n = Math.max(1, Math.ceil(acc / target));
  const cuts = [0];
  for (let k = 1; k < n; k++) {
    const want = (acc * k) / n;
    let best = -1;
    for (const st of starts) if (st > cuts[cuts.length - 1] && (best < 0 || Math.abs(offs[st] - want) < Math.abs(offs[best] - want))) best = st;
    if (best > 0) cuts.push(best);
  }
  cuts.push(lines.length);
  const parts = [];
  for (let k = 0; k + 1 < cuts.length; k++) parts.push({ from: cuts[k], to: cuts[k + 1], text: lines.slice(cuts[k], cuts[k + 1]).map((l) => l + "\n").join("") });
  const context = lines.filter((l) => /^\S/.test(l) && /\brequire\(|module\.exports\s*=/.test(l));
  const nestedRequire = lines.some((l) => /^\s+.*\brequire\(/.test(l) && !/^\s*\*/.test(l) && !/^\s*\/\//.test(l));
  return parts.map((p, i) => ({ ...p, index: i, count: parts.length, context, nestedRequire }));
}

function pieceMessage(file, piece) {
  if (piece.count === 1) return `File: ${file}\n\n${piece.text}`;
  const head = `File: ${file}, part ${piece.index + 1} of ${piece.count} (lines ${piece.from + 1}-${piece.to}). Other workers convert the other parts at the same time. Convert only this part and reply with only its converted lines.`;
  let note = "";
  if (piece.index === 0 && piece.nestedRequire) note = " A later part calls require() inside a function, so add the createRequire lines from rule 7 after your imports.";
  if (piece.index > 0) note = " Imports are written by the worker on part 1; do not add any. A require() inside a function stays as it is.";
  const ctx = piece.index > 0 && piece.context.length ? `\n\nContext only (top-level lines of this file, handled by part 1, do not output them):\n${piece.context.join("\n")}` : "";
  return `${head}${note}${ctx}\n\nPart to convert:\n${piece.text}`;
}

// The trial endpoint allows 50K tokens a minute, and the OpenClaw agent's own turn spends part of that
// just before this runs. Firing fifteen streams into a half-spent minute gets some of them a 429 and a
// retry, which is what made slow runs slow. So before the fan-out (and before the clock starts), ask the
// endpoint how much of the minute is left and wait until the whole run fits.
async function waitForBudget({ pieces, key, emit, signal }) {
  if (process.env.OVERNIGHT_PREFLIGHT === "0") return;
  const chars = pieces.reduce((s, { file, piece }) => s + RULES.length + pieceMessage(file, piece).length + piece.text.length, 0);
  const need = Math.min(48_000, Math.ceil(chars / 3.2));
  const until = Date.now() + 60_000;
  for (;;) {
    let left = null;
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST", signal,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 1, reasoning_effort: "low", messages: [{ role: "system", content: RULES }, { role: "user", content: "." }] }),
      });
      left = Number(res.headers.get("x-ratelimit-remaining-tokens-minute"));
      await res.body?.cancel();
    } catch (e) { if (signal?.aborted) throw e; }
    if (!Number.isFinite(left) || left >= need || Date.now() > until) { emit("budget", { need, left }); return; }
    emit("budget-wait", { need, left });
    await new Promise((r) => setTimeout(r, Math.min(3000, Math.max(500, ((need - left) / 50_000) * 60_000))));
  }
}

async function convertOne({ file, piece, key, emit, signal }) {
  const source = piece.text;
  const id = piece.count > 1 ? `${file}#${piece.index + 1}` : file;
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    attempt++;
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0,
        reasoning_effort: "low",
        max_tokens: Math.ceil(source.length / 2) + 2048,
        messages: [
          { role: "system", content: RULES },
          { role: "user", content: pieceMessage(file, piece) },
        ],
      }),
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(2, Number(res.headers.get("retry-after")) || 0.3 * attempt);
      const why = (await res.text().catch(() => "")).slice(0, 160);
      emit("retry", { file, id, status: res.status, wait, why, left: res.headers.get("x-ratelimit-remaining-tokens-minute") });
      if (attempt >= 12) throw new Error(`${file}: HTTP ${res.status} after ${attempt} tries`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status} ${await res.text()}`);

    const dec = new TextDecoder();
    let buf = "", out = "", last = null, firstAt = 0, pieces = 0, reasoningChars = 0;
    for await (const part of res.body) {
      buf += dec.decode(part, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, cut).trim();
        buf = buf.slice(cut + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.time_info || j.usage) last = j;
        const d = j.choices?.[0]?.delta || {};
        const r = d.reasoning || d.reasoning_content || "";
        if (r) reasoningChars += r.length;
        if (d.content) {
          if (!firstAt) firstAt = Date.now();
          out += d.content;
          pieces++;
          emit("progress", { file, id, part: piece.index, parts: piece.count, chars: out.length, total: source.length, pieces, text: d.content });
        }
      }
    }
    const usage = last?.usage || {};
    const ti = last?.time_info || {};
    const tokens = usage.completion_tokens || 0;
    let code = stripFences(out);
    if (source.endsWith("\n\n") && !code.endsWith("\n\n")) code += "\n";
    const result = {
      file,
      id,
      part: piece.index,
      parts: piece.count,
      code,
      tokens,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
      promptTokens: usage.prompt_tokens || 0,
      completionTime: ti.completion_time || null,
      queueTime: ti.queue_time ?? null,
      tps: ti.completion_time ? tokens / ti.completion_time : null,
      wallMs: Date.now() - started,
      firstTokenMs: firstAt ? firstAt - started : null,
      attempts: attempt,
    };
    emit("file-done", result);
    return result;
  }
}

// Every line a piece should copy untouched (no require, no exports) must come back, and every
// exported name must still be exported. A piece that fails is converted again, at most twice.
export function missingLines(input, output) {
  const have = new Map();
  for (const l of output.split("\n")) have.set(l.trim(), (have.get(l.trim()) || 0) + 1);
  const missing = [];
  for (const l of input.split("\n")) {
    const t = l.trim();
    if (!t || /require\(|exports/.test(t) || /^[\])};,]+$/.test(t)) continue;
    const n = have.get(t) || 0;
    if (n > 0) have.set(t, n - 1);
    else missing.push(t);
  }
  for (const m of input.matchAll(/^\s*exports\.(\w+)\s*=/gm)) {
    const name = m[1];
    if (!new RegExp(`\\.${name}\\s*=|export\\s+(const|let|var|function\\*?|class)\\s+${name}\\b|as\\s+${name}\\b`).test(output)) missing.push(`exports.${name}`);
  }
  return missing;
}

async function convertChecked(args) {
  let r;
  for (let tries = 1; tries <= 3; tries++) {
    r = await convertOne(args);
    const missing = missingLines(args.piece.text, r.code);
    if (!missing.length) return { ...r, checks: tries };
    args.emit("recheck", { file: args.file, id: r.id, missing: missing.slice(0, 3), tries });
  }
  return { ...r, checks: 3, unchecked: true };
}

function copyTree(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (name === ".git") continue;
    const s = path.join(src, name), d = path.join(dst, name);
    if (name === "node_modules") { fs.symlinkSync(s, d); continue; }
    fs.cpSync(s, d, { recursive: true });
  }
}

export function runTests(root, emit = () => {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [path.join(root, "node_modules/mocha/bin/mocha.js"), "--require", path.join(HERE, "tools/reserve-ports.cjs"), "--require", "test/support/env", "--reporter", "json", "--check-leaks", "test/", "test/acceptance/"],
      { cwd: root, env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const kill = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("close", (code) => {
      clearTimeout(kill);
      let stats = null, failures = [];
      try {
        const start = stdout.indexOf("{");
        const j = JSON.parse(stdout.slice(start));
        stats = j.stats;
        failures = (j.failures || []).slice(0, 20).map((f) => ({ title: f.fullTitle, file: f.file, err: f.err?.message }));
      } catch {}
      const r = { code, stats, failures, stderr: stderr.slice(-4000), ms: Date.now() - started };
      emit("tests-done", r);
      resolve(r);
    });
  });
}

export async function migrate({ src = path.join(HERE, "targets/express-cjs"), dst = path.join(HERE, "targets/express-esm"), test = true, emitter = new EventEmitter(), signal } = {}) {
  const emit = (type, data) => emitter.emit("event", { type, t: Date.now(), ...data });
  const key = apiKey();
  if (!key) throw new Error("CEREBRAS_API_KEY is not set (env or .env)");

  copyTree(src, dst);
  const files = await listFiles(src);
  const sources = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(src, f), "utf8")]));
  emit("start", { model: MODEL, files: files.map((f) => ({ file: f, lines: sources[f].split("\n").length - 1, chars: sources[f].length })) });

  const pieces = files.flatMap((file) => splitFile(sources[file]).map((piece) => ({ file, piece })));
  await waitForBudget({ pieces, key, emit, signal });
  emit("plan", { pieces: pieces.map(({ file, piece }) => ({ file, id: piece.count > 1 ? `${file}#${piece.index + 1}` : file, part: piece.index, parts: piece.count, chars: piece.text.length, from: piece.from + 1, to: piece.to })) });
  const t0 = Date.now();
  const results = await Promise.all(pieces.map(({ file, piece }) => convertChecked({ file, piece, key, emit, signal })));
  for (const file of files) {
    const code = results.filter((r) => r.file === file).sort((a, b) => a.part - b.part).map((r) => r.code).join("");
    fs.writeFileSync(path.join(dst, file), code);
    emit("file-written", { file });
  }
  fs.writeFileSync(path.join(dst, "lib/package.json"), '{\n  "type": "module"\n}\n');
  const wallMs = Date.now() - t0;
  const tokens = results.reduce((s, r) => s + r.tokens, 0);
  const rates = results.map((r) => r.tps).filter(Boolean);
  const summary = {
    model: MODEL,
    files: files.length,
    pieces: results.length,
    lines: files.reduce((s, f) => s + sources[f].split("\n").length - 1, 0),
    tokens,
    wallMs,
    combinedTps: tokens / (wallMs / 1000),
    meanTps: rates.reduce((s, x) => s + x, 0) / rates.length,
    peakTps: Math.max(...rates),
    perFile: results.map(({ code, ...r }) => r),
  };
  emit("migrated", summary);

  let tests = null;
  if (test) {
    emit("tests-start", {});
    tests = await runTests(dst, emit);
  }
  emit("done", { summary, tests: tests && { stats: tests.stats, failures: tests.failures } });
  return { summary, tests };
}

// When OVERNIGHT_EVENTS is set (the dashboard does this for the OpenClaw agent), every event is
// also posted there in small batches, so the page animates a run started from the agent's exec tool.
function forwardEvents(emitter, url) {
  let queue = [], timer = null, chain = Promise.resolve();
  const flush = () => {
    timer = null;
    const batch = queue; queue = [];
    if (batch.length) chain = chain.then(() => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch) }).catch(() => {}));
    return chain;
  };
  emitter.on("event", (e) => {
    queue.push(e);
    if (e.type !== "progress") flush();
    else if (!timer) timer = setTimeout(flush, 40);
  });
  return () => flush();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const emitter = new EventEmitter();
  const json = process.argv.includes("--json");
  const flushEvents = process.env.OVERNIGHT_EVENTS ? forwardEvents(emitter, process.env.OVERNIGHT_EVENTS) : async () => {};
  if (!json)
  emitter.on("event", (e) => {
    if (e.type === "progress") return;
    if (e.type === "recheck") return console.log(`recheck ${e.id}: missing ${JSON.stringify(e.missing)}`);
    if (e.type === "file-done") console.log(`${e.id.padEnd(22)} ${String(e.tokens).padStart(5)} tok  ${e.tps ? Math.round(e.tps) : "?"} tok/s  reasoning ${e.reasoningTokens}  wall ${(e.wallMs / 1000).toFixed(2)}s  queue ${e.queueTime}`);
    else if (e.type === "budget-wait" || e.type === "budget") console.log(`${e.type}: need ${e.need}, minute has ${e.left} left`);
    else if (e.type === "retry") console.log(`retry ${e.file} ${e.status} in ${e.wait}s (left ${e.left}) ${e.why || ""}`);
    else if (e.type === "migrated") console.log(`migrated ${e.files} files (${e.pieces} pieces), ${e.lines} lines, ${e.tokens} tokens in ${(e.wallMs / 1000).toFixed(2)}s  combined ${Math.round(e.combinedTps)} tok/s  mean ${Math.round(e.meanTps)}  peak ${Math.round(e.peakTps)}`);
    else if (e.type === "tests-done") {
      console.log(`tests: ${e.stats ? `${e.stats.passes} passing, ${e.stats.failures} failing` : `crashed (exit ${e.code})`}`);
      for (const f of e.failures.slice(0, 8)) console.log(`  x ${f.title}: ${f.err}`);
      if (!e.stats) console.log(e.stderr);
    }
  });
  const { summary, tests } = await migrate({ test: !process.argv.includes("--no-test"), emitter });
  await flushEvents();
  fs.mkdirSync(path.join(HERE, "runs"), { recursive: true });
  fs.writeFileSync(path.join(HERE, `runs/${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(summary, null, 2));
  if (json) {
    const { perFile, ...rest } = summary;
    const round = (x) => Math.round(x);
    console.log(JSON.stringify({ summary: { ...rest, combinedTps: round(rest.combinedTps), meanTps: round(rest.meanTps), peakTps: round(rest.peakTps) }, tests: tests?.stats ? { passes: tests.stats.passes, failures: tests.stats.failures, firstFailure: tests.failures[0] || null } : { crashed: true, error: tests?.stderr?.split("\n").find((l) => /Error/.test(l)) || null } }));
  }
}
