// Screen-record one real migration in the Overnight app (headless Chrome, 1920x1080).
//   node tools/record.mjs <label>     -> runs/<label>.mp4 and runs/<label>.json
// Nothing here computes a number: it copies what the page shows when the run ends.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const require = createRequire(path.join(HERE, "../kimi-hackathon/repos/wkasekende__cerebras-video-demos/package.json"));
const puppeteer = require("puppeteer");
const label = process.argv[2] || `take-${Date.now()}`;
const out = path.join(HERE, "runs");
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1920, height: 1080 }, args: ["--window-size=1920,1080"] });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:4646/", { waitUntil: "networkidle2" });
await page.waitForFunction(() => document.querySelectorAll(".tile").length > 0);
await sleep(800);
const rec = await page.screencast({ path: path.join(out, `${label}.mp4`) });
await sleep(1800);
await page.click("#go");
const started = Date.now();
const recStart = started - 1800;
const marks = {};
await page.exposeFunction("__mark", (k) => { marks[k] = Date.now() - recStart; });

await page.evaluate(() => {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => { const e = JSON.parse(m.data); if (["plan", "migrated", "tests-done", "agent-done"].includes(e.type)) window.__mark(e.type); };
});
await page.waitForFunction(() => /passing|failing|crashed|error/.test(document.getElementById("testsBig").textContent) && document.getElementById("agent").className === "agent" && !/^idle/.test(document.getElementById("agentText").textContent), { timeout: 240_000, polling: 200 });
await sleep(9000);
await rec.stop();
const read = await page.evaluate(() => Object.fromEntries(["elapsed", "tokens", "combined", "peak", "meanNote", "testsBig", "testsLine", "tokNote", "diffTitle", "agentText"].map((id) => [id, document.getElementById(id).textContent])));
const result = { label, wallSeconds: Math.round((Date.now() - started) / 1000), marksMs: marks, ...read };
fs.writeFileSync(path.join(out, `${label}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
await browser.close();
