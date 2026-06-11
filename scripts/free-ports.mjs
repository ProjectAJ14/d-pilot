// Frees the dev ports before `npm run dev` so a stale dev server doesn't cause
// EADDRINUSE — effectively "restart" instead of erroring.
//
// Run automatically as the `predev` npm hook. Reads PORT / VITE_PORT from .env
// (same defaults as the server and vite config). For each port it finds the
// listening process and kills its whole process group — important because the
// server runs under `tsx watch`, which would otherwise just respawn it and
// re-grab the port. It never kills its own process group (this invocation).
//
// macOS/Linux only (uses lsof/ps); that's the supported dev platform here.

import "dotenv/config";
import { execSync } from "node:child_process";

const sh = (cmd) => {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return ""; // lsof/ps exit non-zero when there's no match — treat as empty
  }
};

const listenersOn = (port) =>
  sh(`lsof -ti tcp:${port} -sTCP:LISTEN`).split("\n").filter(Boolean);
const pgidOf = (pid) => sh(`ps -o pgid= -p ${pid}`).trim();

const serverPort = process.env.PORT || "3101";
const clientPort = process.env.VITE_PORT || String(Number(serverPort) - 1);
const ports = [...new Set([serverPort, clientPort])];

const myPgid = pgidOf(process.pid);

let signaledSomething = false;
for (const port of ports) {
  for (const pid of listenersOn(port)) {
    const pgid = pgidOf(pid);
    // Kill the whole group (defeats tsx-watch respawn) unless it's our own.
    const useGroup = pgid && pgid !== myPgid;
    const target = useGroup ? -Number(pgid) : Number(pid);
    try {
      process.kill(target, "SIGTERM");
      console.log(`✓ Freed port ${port} — stopped ${useGroup ? `process group ${pgid}` : `pid ${pid}`}`);
      signaledSomething = true;
    } catch {
      // already gone
    }
  }
}

if (signaledSomething) {
  // Give the OS a moment to release the sockets, then force-kill any stragglers.
  await new Promise((r) => setTimeout(r, 1200));
  for (const port of ports) {
    for (const pid of listenersOn(port)) {
      try {
        process.kill(Number(pid), "SIGKILL");
        console.log(`✓ Force-killed lingering pid ${pid} still on port ${port}`);
      } catch {
        // gone
      }
    }
  }
}
