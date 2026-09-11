import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// These boot the real entrypoint in a child process. The app itself is
// createApp() in src/app.ts, driven in-process by http-server.test.ts; these
// pin what only the entrypoint does, where Express 5 quietly changed what
// server.ts relied on: binding, startup failure, and the body limit end to end.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Hard cap on a child's lifetime, so a hung boot fails instead of hanging. */
const CHILD_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 40_000;

interface LogEvent {
  msg?: string;
  err?: { code?: string };
}

interface Run {
  code: number | null;
  events: LogEvent[];
  stderr: string;
}

interface Booted {
  /** Resolves with the first event logged as `msg`; rejects if the child
   *  exits without logging it. */
  waitFor(msg: string): Promise<LogEvent>;
  /** SIGTERM the child (a no-op once it has exited) and wait for it. */
  stop(): Promise<Run>;
  exited: Promise<Run>;
}

function boot(port: number, env: NodeJS.ProcessEnv = {}): Booted {
  // One process, as in production (`node dist/server.js`), with tsx loaded via
  // --import. The tsx CLI runs the server in a second process and relays
  // signals to it; under CPU load that relay intermittently turned a SIGTERM
  // the server handles into exit 143 instead of its clean exit 0.
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      LOG_LEVEL: "info",
      INDEX_AUTO_REFRESH: "false",
      POSTHOG_KEY: "",
      // Neutralise a developer shell's overrides so every run boots the same
      // server (empty values count as unset).
      ALLOWED_HOSTS: "",
      ALLOWED_ORIGINS: "",
      DNS_REBINDING_PROTECTION: "",
      RATE_LIMIT_ENABLED: "",
      RATE_LIMIT_MAX: "",
      RATE_LIMIT_WINDOW_MS: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events: LogEvent[] = [];
  const watchers = new Set<() => void>();
  const notify = () => watchers.forEach((check) => check());
  let closed = false;
  let pending = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as LogEvent);
      } catch {
        // not a log line
      }
    }
    notify();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  // SIGTERM first so the server's own shutdown runs; SIGKILL only if it hangs.
  const timer = setTimeout(() => child.kill("SIGTERM"), CHILD_TIMEOUT_MS);
  const killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS + 5_000);
  // 'close', not 'exit': stdout can still hold the last log lines at 'exit'.
  const exited = new Promise<Run>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      closed = true;
      resolve({ code, events, stderr });
      notify();
    });
  });
  const waitFor = (msg: string) =>
    new Promise<LogEvent>((resolve, reject) => {
      const check = () => {
        const hit = events.find((e) => e.msg === msg);
        if (!hit && !closed) return;
        watchers.delete(check);
        if (hit) resolve(hit);
        else reject(new Error(`server exited without logging ${msg}\n${stderr}`));
      };
      watchers.add(check);
      check();
    });
  const stop = () => {
    if (!closed) child.kill("SIGTERM");
    return exited;
  };
  return { waitFor, stop, exited };
}

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const portOf = (server: Server) => (server.address() as AddressInfo).port;
const close = (server: Server) => new Promise<void>((r) => server.close(() => r()));

async function freePort(): Promise<number> {
  const probe = await listenOn(0);
  const port = portOf(probe);
  await close(probe);
  return port;
}

describe("server startup — listen errors (Express 5)", () => {
  // Express 5's app.listen() hands bind errors (EADDRINUSE, EACCES) to the
  // listen callback instead of emitting an unhandled 'error' event. Under
  // Express 4 a port clash crashed the process; under Express 5 an unchecked
  // callback logs server_listening and exits 0 with nothing bound, which a
  // supervisor that restarts only on failure never notices.

  it("exits 1 without claiming to listen when the port is already taken", async () => {
    const holder = await listenOn(0);
    try {
      const run = await boot(portOf(holder)).exited;
      expect(run.events.map((e) => e.msg)).not.toContain("server_listening");
      const failure = run.events.find((e) => e.msg === "server_startup_failed");
      expect(failure?.err?.code, run.stderr).toBe("EADDRINUSE");
      expect(run.code).toBe(1);
    } finally {
      await close(holder);
    }
  }, TEST_TIMEOUT_MS);

  it("still logs server_listening and shuts down cleanly when the port is free", async () => {
    const server = boot(await freePort());
    await server.waitFor("server_listening");
    const run = await server.stop();
    expect(run.events.map((e) => e.msg)).not.toContain("server_startup_failed");
    expect(run.code).toBe(0);
  }, TEST_TIMEOUT_MS);

  // The 'error' listener Express registers for the listen callback is a spent
  // once() wrapper after a successful bind, so a later server error (an accept
  // failure such as EMFILE) would vanish without a log line. A preload raises
  // one on the real http.Server right after it starts listening.
  it("logs a server error raised after a successful bind and keeps running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-server-error-"));
    try {
      const preload = join(dir, "emit-server-error.mjs");
      writeFileSync(
        preload,
        [
          'import http from "node:http";',
          "const listen = http.Server.prototype.listen;",
          "http.Server.prototype.listen = function (...args) {",
          '  this.once("listening", () => setImmediate(() => {',
          '    const err = Object.assign(new Error("accept EMFILE"), { code: "EMFILE", syscall: "accept" });',
          '    this.emit("error", err);',
          "  }));",
          "  return listen.apply(this, args);",
          "};",
        ].join("\n"),
      );
      const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`]
        .filter(Boolean)
        .join(" ");
      const server = boot(await freePort(), { NODE_OPTIONS: nodeOptions });
      const logged = await server.waitFor("server_error");
      expect(logged.err?.code).toBe("EMFILE");
      const run = await server.stop();
      const msgs = run.events.map((e) => e.msg);
      expect(msgs.indexOf("server_listening")).toBeLessThan(msgs.indexOf("server_error"));
      expect(msgs).not.toContain("server_startup_failed");
      expect(run.code, run.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});

describe("POST /mcp — 4mb body limit (Express 5)", () => {
  // body-parser 2 leaves req.body undefined when the Content-Type is not one
  // express.json() parses (body-parser 1 under Express 4 set {}). The SDK reads
  // an undefined parsedBody from the raw stream itself with no size limit, and
  // its own Content-Type gate is a substring match on "application/json", so a
  // near-miss type would carry an unbounded body straight past the cap.

  const OVER_LIMIT_PAD = 5 * 1024 * 1024;
  let server: Booted;
  let port: number;

  beforeAll(async () => {
    port = await freePort();
    server = boot(port);
    await server.waitFor("server_listening");
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
  }, TEST_TIMEOUT_MS);

  /** An initialize request, optionally padded with trailing JSON whitespace. */
  const initialize = (pad = 0) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "body-limit-test", version: "0" },
      },
    }) + " ".repeat(pad);

  /** Bodies at least this large wait for the server to answer from the headers. */
  const STAGED_BODY_BYTES = 1024 * 1024;
  const HEADERS_ONLY_GRACE_MS = 5_000;

  function post(contentType: string, body: string) {
    const payload = Buffer.from(body);
    return new Promise<{ status: number; sessionId?: string; text: string }>((resolve, reject) => {
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          agent: false,
          headers: {
            "content-type": contentType,
            accept: "application/json, text/event-stream",
            "content-length": payload.length,
          },
        },
        (res) => {
          clearTimeout(grace);
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => {
            settled = true;
            resolve({
              status: res.statusCode ?? 0,
              sessionId: res.headers["mcp-session-id"] as string | undefined,
              text,
            });
            // An answer that came before the upload finished leaves the request
            // open; end it rather than write into a connection being closed.
            req.destroy();
          });
        },
      );
      // Socket errors once the reply is in (the server closing) are expected.
      req.on("socket", (socket) => socket.on("error", () => {}));
      req.on("error", (err) => {
        if (!settled) reject(err);
      });
      if (payload.length < STAGED_BODY_BYTES) {
        req.end(payload);
        return;
      }
      // The server rejects an over-limit body from its headers alone, then
      // closes the connection without reading the upload. Writing 5 MB at once
      // raced that close: a reset could arrive before the reply was read, and
      // the test failed with ECONNRESET or EPIPE. So send the headers, give the
      // server time to answer, and send the body only if it has not. A server
      // that reads the body, the regression under test, still receives it all.
      req.flushHeaders();
      grace = setTimeout(() => req.end(payload), HEADERS_ONLY_GRACE_MS);
    });
  }

  it("still answers a normal initialize", async () => {
    const res = await post("application/json", initialize());
    expect(res.status, res.text).toBe(200);
    expect(res.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.text).toContain("serverInfo");
  }, TEST_TIMEOUT_MS);

  it("rejects an over-limit application/json body with 413", async () => {
    const res = await post("application/json", initialize(OVER_LIMIT_PAD));
    expect(res.status).toBe(413);
  }, TEST_TIMEOUT_MS);

  it.each(["application/jsonx", "text/plain; x=application/json"])(
    "does not let %s carry an over-limit body past the cap",
    async (contentType) => {
      const res = await post(contentType, initialize(OVER_LIMIT_PAD));
      expect(res.status, res.text).toBe(400);
      expect(res.text).toContain("Invalid JSON-RPC message");
      expect(res.text).not.toContain("serverInfo");
      expect(res.sessionId).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});
