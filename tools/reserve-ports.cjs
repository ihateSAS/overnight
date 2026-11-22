// Test-run preload. Express's tests start servers with listen(0), which binds every interface,
// then connect to 127.0.0.1. If another local app already listens on 127.0.0.1 at a port in the
// ephemeral range, the OS can still give that port to a test server, and the test talks to the
// other app instead (on the machine this was built on: a desktop app on 127.0.0.1:49538, which
// made the untouched CommonJS suite fail now and then too). This reserves those ports first.
// No test file and no Express file is changed.
const { execFileSync } = require("node:child_process");
const net = require("node:net");
let out = "";
try { out = execFileSync("lsof", ["-nP", "-iTCP@127.0.0.1", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8", timeout: 3000 }); } catch {}
const ports = [...new Set([...out.matchAll(/127\.0\.0\.1:(\d+)/g)].map((m) => Number(m[1])))].filter((p) => p >= 49152);
for (const port of ports) {
  const s = net.createServer();
  s.on("error", () => {});
  s.listen(port);
  s.unref();
}
