// Overnight web app: one button migrates the target package to ES modules with Kimi K3.1 Pro on
// Cerebras and streams every piece live to the page, then runs the package's own test suite.
//
//   npm start            http://127.0.0.1:4646
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { migrate, listFiles, splitFile, MODEL } from "./migrate.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PUBLIC = path.join(HERE, "public");
const SRC = path.join(HERE, "targets/express-cjs");
const DST = path.join(HERE, "targets/express-esm");
const PORT = Number(process.env.PORT || 4646);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };

let running = false;
const clients = new Set();
const broadcast = (e) => { const line = `data: ${JSON.stringify(e)}\n\n`; for (const c of clients) c.write(line); };

function envWithKey() {
  const env = { ...process.env };
  if (!env.CEREBRAS_API_KEY) {
    try { env.CEREBRAS_API_KEY = (fs.readFileSync(path.join(HERE, ".env"), "utf8").match(/^CEREBRAS_API_KEY=(.+)$/m) || [])[1]?.trim(); } catch {}
  }
  return env;
}

export const AGENT_PROMPT = "Migrate the CommonJS package in targets/express-cjs to native ES modules and prove it still works with its own tests. Use the overnight skill: run node migrate.mjs --json once with your exec tool, then reply in three short lines from its JSON.";
const OPENCLAW = process.env.OPENCLAW_BIN || "openclaw";
const AGENT_MODEL = process.env.OVERNIGHT_AGENT_MODEL || "cerebras/moonshotai-kimi-k3.1-pro-trial";

function parseJsonTail(raw) {
  for (let i = raw.lastIndexOf("{"); i >= 0; i = raw.lastIndexOf("{", i - 1)) {
    try { return JSON.parse(raw.slice(i)); } catch {}
  }
  return null;
}

// The OpenClaw agent (Kimi K3.1 Pro) runs the job: it reads the overnight skill, calls
// node migrate.mjs --json through its exec tool, and answers from the tool's JSON. The tool
// posts its live events to /api/ingest, so the page animates while the agent waits on it.
function runAgent() {
  running = true;
  const started = Date.now();
  broadcast({ type: "agent-start", prompt: AGENT_PROMPT, model: AGENT_MODEL, t: started });
  const env = { ...envWithKey(), OVERNIGHT_EVENTS: `http://127.0.0.1:${PORT}/api/ingest` };
  const child = spawn(OPENCLAW, ["agent", "exec", AGENT_PROMPT, "--config", path.join(HERE, "openclaw/overnight.json5"), "--code-mode", "direct", "--cwd", HERE, "--model", AGENT_MODEL, "--thinking", "low", "--timeout", "240", "--json"], { cwd: HERE, env });
  let out = "", err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  child.on("close", (code) => {
    running = false;
    const env2 = parseJsonTail(out) || {};
    const final = env2.final ?? env2.result?.payloads?.[0]?.text ?? "";
    fs.mkdirSync(path.join(HERE, "runs"), { recursive: true });
    fs.writeFileSync(path.join(HERE, `runs/agent-${new Date(started).toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ code, envelope: env2, stderr: err.slice(-3000) }, null, 2));
    broadcast({ type: "agent-done", ok: code === 0 && env2.ok !== false, final, ms: Date.now() - started, turns: env2.assistantTurns ?? null, tools: env2.toolSummary ?? null, error: env2.error?.message || (code ? err.split("\n").filter(Boolean).slice(-1)[0] : null) });
  });
}

function git(args, cwd) {
  return new Promise((resolve) => execFile("git", args, { cwd, maxBuffer: 1 << 24 }, (err, stdout) => resolve(stdout || "")));
}

async function target() {
  const files = await listFiles(SRC);
  const head = (await git(["log", "-1", "--format=%h"], SRC)).trim();
  const info = files.map((file) => {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    return { file, lines: src.split("\n").length - 1, chars: src.length, parts: splitFile(src).length };
  });
  return { repo: "expressjs/express", commit: head, model: MODEL, files: info, baselineTests: 1290 };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/target") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(await target()));
    }
    if (url.pathname === "/api/diff") {
      const file = url.searchParams.get("file") || "lib/express.js";
      if (!/^lib\/[\w.-]+\.js$/.test(file)) { res.writeHead(400); return res.end(); }
      const out = await git(["diff", "--no-index", "--no-color", "-U1", path.join(SRC, file), path.join(DST, file)], HERE);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(out);
    }
    if (url.pathname === "/api/stats") {
      const out = await git(["diff", "--no-index", "--numstat", path.join(SRC, "lib"), path.join(DST, "lib")], HERE);
      let added = 0, removed = 0;
      for (const line of out.trim().split("\n")) {
        const [a, r, name] = line.split("\t");
        if (name && name.endsWith(".js")) { added += Number(a) || 0; removed += Number(r) || 0; }
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ added, removed }));
    }
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": hello\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/api/ingest" && req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      try { for (const e of JSON.parse(body)) broadcast(e); } catch {}
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === "/api/agent" && req.method === "POST") {
      if (running) { res.writeHead(409); return res.end("busy"); }
      runAgent();
      res.writeHead(202);
      return res.end();
    }
    if (url.pathname === "/api/run") {
      if (running) { res.writeHead(409); return res.end("a migration is already running"); }
      running = true;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const emitter = new EventEmitter();
      emitter.on("event", (e) => { res.write(`data: ${JSON.stringify(e)}\n\n`); broadcast(e); });
      const abort = new AbortController();
      req.on("close", () => abort.abort());
      try {
        const { summary } = await migrate({ src: SRC, dst: DST, emitter, signal: abort.signal });
        fs.mkdirSync(path.join(HERE, "runs"), { recursive: true });
        fs.writeFileSync(path.join(HERE, `runs/${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(summary, null, 2));
      } catch (err) {
        res.write(`data: ${JSON.stringify({ type: "error", message: String(err.message || err) })}\n\n`);
      } finally {
        running = false;
        res.end();
      }
      return;
    }
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(err.message || err));
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Overnight on http://127.0.0.1:${PORT}`));
