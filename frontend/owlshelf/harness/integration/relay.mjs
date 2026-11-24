/**
 * relay.mjs — run the REAL relay for an integration test.
 *
 * `harness/lib/relay.mjs` is an in-memory fake: it proves the engine's
 * behaviour, not that the engine and the relay agree on the wire. §5.3's gap is
 * exactly that — the wire is verified twice, independently, against two
 * readings of §15.4, which is how the divergences in `owlshelf-code-vs-plan.md`
 * §1 went unnoticed.
 *
 * So this spawns `backend/main.py` as a child process, on a free port, with the
 * same configuration the deployment uses. Nothing about the relay is restated
 * here: `main.py` reads `PORT` and `ALLOWED_ORIGINS` from the environment and
 * everything else from `RelayConfig.from_env()`.
 *
 * The relay fails closed on a missing `Origin` header, so the client must send
 * one — see `socket.mjs`. That is why this cannot be a plain Node WebSocket.
 */

import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** harness/integration → frontend/owlshelf → frontend → repo root */
export const REPO_ROOT = join(HERE, "..", "..", "..", "..");
export const BACKEND_DIR = join(REPO_ROOT, "backend");
export const PYTHON = join(BACKEND_DIR, ".venv", "bin", "python");

/** The origin the client claims. Must match `ALLOWED_ORIGINS` exactly. */
export const TEST_ORIGIN = "http://localhost:4173";

/** An ephemeral port. Racy in principle, fine in practice for a test. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Resolve once something accepts on the port, or reject after `timeoutMs`. */
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = connect({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`relay did not accept on 127.0.0.1:${port} within ${timeoutMs} ms`);
}

/**
 * Start the relay. Resolves with `{ url, stop }`.
 *
 * `stop()` is idempotent and always resolves — a test that throws must not
 * leave a uvicorn process holding a port.
 */
export async function startRelay({ timeoutMs = 20_000 } = {}) {
  const port = await freePort();
  const child = spawn(PYTHON, ["main.py"], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      ALLOWED_ORIGINS: TEST_ORIGIN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Keep the last lines: a startup failure is otherwise a bare timeout.
  const output = [];
  const record = (chunk) => {
    output.push(chunk.toString());
    if (output.length > 40) output.shift();
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);

  let exited = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  try {
    await waitForPort(port, timeoutMs);
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`${error.message}\nrelay output:\n${output.join("")}`);
  }
  if (exited !== null) {
    throw new Error(`relay exited during startup (${JSON.stringify(exited)})\n${output.join("")}`);
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (exited !== null) return;
    const done = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    // uvicorn shuts down cleanly on SIGTERM; SIGKILL is the backstop so a
    // wedged process cannot hang the harness.
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await done;
    clearTimeout(timer);
  };

  return { url: `ws://127.0.0.1:${port}/ws`, port, stop, output };
}
