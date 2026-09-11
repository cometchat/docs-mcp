import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, stat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { logger } from "../lib/logger.js";
import { withoutGitRepoEnv } from "../lib/git-env.js";
import type { SqliteSearchClient } from "../search/sqlite.js";
import {
  DEFAULT_POLICY,
  PoisonedCommits,
  generationsToPrune,
  validateCandidate,
  type Generation,
  type IndexStats,
  type ValidationPolicy,
} from "./validate.js";

const exec = promisify(execFile);

// Resolves to the app root from either src/index (tsx) or dist/index (built).
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX_BIN = path.join(APP_ROOT, "node_modules", ".bin", "tsx");
const BUILD_SCRIPT = path.join(APP_ROOT, "scripts", "build-index.ts");
const SHA_RE = /^[0-9a-f]{40}$/;

export interface RefresherOptions {
  searchClient: SqliteSearchClient;
  repoUrl: string;
  ref: string;
  /** Pin to one commit and never follow HEAD (incident escape hatch). */
  pinnedCommit?: string;
  workDir: string;
  pollIntervalMs: number;
  keepGenerations: number;
  policy?: ValidationPolicy;
  /** Queries that must return hits after a swap, else the swap is reverted. */
  smokeQueries?: string[];
  cloneTimeoutMs?: number;
  buildTimeoutMs?: number;
  /** Consecutive failures on one commit before it is given up on. */
  maxAttempts?: number;
}

export interface RefresherState {
  docsCommit: string | null;
  builtAt: string | null;
  generations: number;
  poisoned: number;
  lastCheckedAt: string | null;
  lastError: string | null;
}

/** Reads pages/journal_mode/bytes/navPages straight off an index file. */
export async function inspectIndex(indexPath: string): Promise<IndexStats> {
  const { size } = await stat(indexPath);
  const db = new Database(indexPath, { readonly: true, fileMustExist: true });
  try {
    const pages = (db.prepare("SELECT COUNT(*) AS n FROM pages").get() as { n: number }).n;
    const journalMode = String(
      (db.pragma("journal_mode", { simple: true }) as unknown) ?? "",
    ).toLowerCase();
    const columns = db.prepare("PRAGMA table_info(pages)").all() as { name: string }[];
    const navPages = columns.some((c) => c.name === "product")
      ? (db.prepare("SELECT COUNT(*) AS n FROM pages WHERE product IS NOT NULL").get() as { n: number }).n
      : null;
    return { pages, journalMode, bytes: size, navPages };
  } finally {
    db.close();
  }
}

export class IndexRefresher {
  private timer: NodeJS.Timeout | null = null;
  private readonly poisoned = new PoisonedCommits();
  /** Consecutive failed attempts per commit; a transient blip must not
   *  permanently blacklist a commit that is actually fine. */
  private readonly attempts = new Map<string, number>();
  private readonly generations: Generation[] = [];
  private refreshing = false;
  private stopped = false;
  private state: RefresherState = {
    docsCommit: null,
    builtAt: null,
    generations: 0,
    poisoned: 0,
    lastCheckedAt: null,
    lastError: null,
  };

  constructor(private readonly opts: RefresherOptions) {}

  snapshot(): RefresherState {
    return { ...this.state, generations: this.generations.length, poisoned: this.poisoned.size };
  }

  start(): void {
    const { pollIntervalMs } = this.opts;
    logger.info(
      {
        repo: this.opts.repoUrl,
        ref: this.opts.ref,
        pollIntervalMs,
        pinned: this.opts.pinnedCommit ?? null,
        keepGenerations: this.opts.keepGenerations,
        workDir: this.opts.workDir,
      },
      "index_refresh_enabled",
    );
    // Kick immediately so a task that booted on a stale baked index converges
    // without waiting a full interval.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), pollIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll cycle. Never throws: a refresh failure must not affect serving. */
  async tick(): Promise<void> {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    let target: string | null = null;
    try {
      target = this.opts.pinnedCommit ?? (await this.remoteHead());
      this.state.lastCheckedAt = new Date().toISOString();
      if (!target) {
        // ls-remote exits 0 with empty output when the ref matches nothing, so
        // a typo'd DOCS_REF would otherwise be an invisible permanent no-op.
        this.state.lastError = `ref '${this.opts.ref}' did not resolve to a commit`;
        logger.warn({ ref: this.opts.ref }, "index_refresh_ref_unresolved");
        return;
      }
      if (target === this.state.docsCommit) return;
      if (this.poisoned.has(target)) {
        logger.debug({ docsCommit: target }, "index_refresh_skipped_poisoned");
        return;
      }
      await this.refreshTo(target);
      this.attempts.delete(target);
    } catch (err) {
      const reason = sanitizeError(err, this.opts.repoUrl);
      this.state.lastError = reason;
      // Any failure counts — a commit whose build throws deterministically must
      // not be re-cloned and rebuilt every interval forever.
      if (target) this.noteFailure(target, reason);
      logger.warn({ docsCommit: target, reason }, "index_refresh_cycle_failed");
    } finally {
      this.refreshing = false;
    }
  }

  private noteFailure(docsCommit: string, reason: string): void {
    const max = this.opts.maxAttempts ?? 3;
    const n = (this.attempts.get(docsCommit) ?? 0) + 1;
    this.attempts.set(docsCommit, n);
    // Bound the map: only a handful of commits are ever in flight.
    if (this.attempts.size > 50) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined) this.attempts.delete(oldest);
    }
    if (n >= max) {
      this.poisoned.mark(docsCommit);
      this.attempts.delete(docsCommit);
      logger.error({ docsCommit, attempts: n, reason }, "index_refresh_commit_abandoned");
    }
  }

  private async remoteHead(): Promise<string | null> {
    // Exact ref, not a glob: `git ls-remote <url> main` also matches
    // refs/tags/main, refs/heads/foo/main, etc., and taking the first line
    // could resolve HEAD to an unrelated commit.
    const fullRef = this.opts.ref.startsWith("refs/")
      ? this.opts.ref
      : `refs/heads/${this.opts.ref}`;
    const { stdout } = await exec("git", ["ls-remote", "--", this.opts.repoUrl, fullRef], {
      timeout: 30_000,
      env: withoutGitRepoEnv(),
    });
    for (const line of stdout.split("\n")) {
      const [sha, name] = line.split(/\s+/);
      if (name === fullRef && sha && SHA_RE.test(sha)) return sha;
    }
    return null;
  }

  private async refreshTo(docsCommit: string): Promise<void> {
    const started = Date.now();
    logger.info({ docsCommit }, "index_refresh_started");
    await mkdir(this.opts.workDir, { recursive: true });
    // Clone INSIDE the work dir: on Fargate with readonlyRootFilesystem the
    // work volume is the only writable path — os.tmpdir() is read-only there.
    const cloneDir = await mkdtemp(path.join(this.opts.workDir, "clone-"));
    const candidatePath = path.join(this.opts.workDir, `index-${docsCommit}.sqlite`);
    let adopted = false;

    try {
      await this.clone(cloneDir, docsCommit);
      const buildStarted = Date.now();
      let output: BuildOutput;
      try {
        output = await this.build(cloneDir, candidatePath);
      } catch (err) {
        if (err instanceof IndexBuildError) {
          logBuild(docsCommit, Date.now() - buildStarted, err.output, err.exit);
        }
        throw err;
      }
      logBuild(docsCommit, Date.now() - buildStarted, output, null);

      const candidate = await inspectIndex(candidatePath);
      const currentPages = this.searchPageCount();
      const current: IndexStats | null =
        currentPages === null
          ? null
          : {
              pages: currentPages,
              journalMode: "delete",
              bytes: 1,
              navPages: this.opts.searchClient.navigationPageCount(),
            };
      const verdict = validateCandidate(candidate, current, this.opts.policy ?? DEFAULT_POLICY);
      if (!verdict.ok) {
        this.poisoned.mark(docsCommit);
        this.state.lastError = verdict.reason;
        logger.error(
          {
            docsCommit,
            code: verdict.code,
            reason: verdict.reason,
            candidate: { pages: candidate.pages, navPages: candidate.navPages ?? null },
            served: current && { pages: current.pages, navPages: current.navPages ?? null },
          },
          "index_refresh_rejected",
        );
        return;
      }

      // Swap, then prove the new index actually answers before keeping it.
      const previousPath = this.opts.searchClient.currentPath();
      this.opts.searchClient.swapTo(candidatePath);
      const smokeOk = await this.smokeTest();
      if (!smokeOk) {
        this.opts.searchClient.swapTo(previousPath);
        this.poisoned.mark(docsCommit);
        this.state.lastError = "post-swap smoke test failed";
        logger.error({ docsCommit, revertedTo: previousPath }, "index_refresh_reverted");
        return;
      }

      adopted = true;
      this.generations.push({ path: candidatePath, docsCommit, createdAt: Date.now() });
      this.state.docsCommit = docsCommit;
      this.state.builtAt = new Date().toISOString();
      this.state.lastError = null;
      logger.info(
        {
          docsCommit,
          pages: candidate.pages,
          navPages: candidate.navPages ?? null,
          bytes: candidate.bytes,
          duration_ms: Date.now() - started,
        },
        "index_refresh_succeeded",
      );
      await this.prune();
    } finally {
      await rm(cloneDir, { recursive: true, force: true });
      // Anything not adopted — rejected, reverted, or a mid-build throw — must
      // not linger: it is never in `generations`, so prune() can never see it.
      if (!adopted) await removeIndexFiles(candidatePath);
    }
  }

  private async clone(dir: string, docsCommit: string): Promise<void> {
    const timeout = this.opts.cloneTimeoutMs ?? 180_000;
    // Never the repository of whatever process spawned us (see git-env.ts).
    const env = withoutGitRepoEnv();
    // Blobless + sparse: fetches only mdx blobs (~44MB) instead of the full
    // repo (~390MB of assets). `--` stops a hostile ref/url being read as a flag.
    await exec(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        "--branch",
        this.opts.ref,
        "--",
        this.opts.repoUrl,
        dir,
      ],
      { timeout, env },
    );
    await exec(
      "git",
      ["-C", dir, "sparse-checkout", "set", "--no-cone", "/*", "!/*/", "**/*.mdx"],
      { timeout, env },
    );
    await exec("git", ["-C", dir, "fetch", "--depth", "1", "origin", docsCommit], { timeout, env });
    await exec("git", ["-C", dir, "checkout", docsCommit], { timeout, env });
  }

  private async build(cloneDir: string, outPath: string): Promise<BuildOutput> {
    // tsx creates an IPC socket under os.tmpdir(), and SQLite spills temp files
    // there too. On a read-only root filesystem /tmp is unwritable, so point
    // both at the work volume — the one writable path the task is given.
    const tmp = path.join(this.opts.workDir, "tmp");
    await mkdir(tmp, { recursive: true });
    const timeoutMs = this.opts.buildTimeoutMs ?? 600_000;
    const maxBuffer = 8 * 1024 * 1024;
    try {
      // Child process: the build burns ~2s of CPU and must not block serving.
      const { stderr } = await exec(TSX_BIN, [BUILD_SCRIPT], {
        timeout: timeoutMs,
        // ALLOWLIST, not `...process.env`: this child parses ~3k files fetched
        // from a public repo, so it must never hold ANALYTICS_SALT, POSTHOG_KEY,
        // HEALTH_DETAIL_TOKEN or any other server secret. Only what tsx/node and
        // the builder actually need is forwarded.
        env: {
          ...pick(process.env, BUILD_ENV_ALLOWLIST),
          DOCS_REPO: cloneDir,
          INDEX_PATH: outPath,
          TMPDIR: tmp,
          SQLITE_TMPDIR: tmp,
        },
        maxBuffer,
      });
      return summarizeBuildOutput(stderr);
    } catch (err) {
      // The raw rejection is "Command failed: <tsx path>" plus stderr, where
      // sanitizeError would pick an earlier WARNING line over the real cause.
      const e = err as ExecFileException;
      const output = summarizeBuildOutput(typeof e.stderr === "string" ? e.stderr : "");
      throw new IndexBuildError(describeBuildFailure(e, output, { timeoutMs, maxBuffer }), output, buildExit(e));
    }
  }

  private searchPageCount(): number | null {
    try {
      return this.opts.searchClient.pageCount();
    } catch {
      return null;
    }
  }

  private async smokeTest(): Promise<boolean> {
    const queries = this.opts.smokeQueries ?? ["chat", "message"];
    for (const q of queries) {
      try {
        const res = await this.opts.searchClient.search(q, { limit: 1 });
        if (res.results.length === 0) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private async prune(): Promise<void> {
    const current = this.opts.searchClient.currentPath();
    const doomed = generationsToPrune(this.generations, this.opts.keepGenerations, current);
    for (const g of doomed) {
      await removeIndexFiles(g.path);
      const i = this.generations.findIndex((x) => x.path === g.path);
      if (i >= 0) this.generations.splice(i, 1);
    }
    // Sweep anything orphaned by an earlier crash or hard kill.
    await this.sweepOrphans(current);
    if (doomed.length > 0) {
      logger.debug(
        { pruned: doomed.length, kept: this.generations.length },
        "index_generations_pruned",
      );
    }
  }

  /** Deletes index/clone leftovers in the work dir that we do not track. */
  private async sweepOrphans(currentPath: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.opts.workDir);
    } catch {
      return;
    }
    const known = new Set(this.generations.map((g) => path.basename(g.path)));
    for (const name of entries) {
      const full = path.join(this.opts.workDir, name);
      if (full === currentPath || known.has(name)) continue;
      if (name === "tmp") continue;
      if (name.startsWith("clone-")) {
        await rm(full, { recursive: true, force: true });
      } else if (/^index-.*\.sqlite(-wal|-shm)?$/.test(name)) {
        await rm(full, { force: true });
      }
    }
  }
}

/** Removes a SQLite file together with any -wal/-shm siblings. */
async function removeIndexFiles(indexPath: string): Promise<void> {
  await Promise.all(
    [indexPath, `${indexPath}-wal`, `${indexPath}-shm`].map((p) => rm(p, { force: true })),
  );
}

/**
 * execFile rejections carry the whole argv ("Command failed: git clone ... <url>")
 * and raw stderr. That reaches /health, which is unauthenticated — so strip the
 * command line and redact the repo URL, which may embed credentials.
 */
export function sanitizeError(err: unknown, repoUrl: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const withoutCmd = raw.replace(/^Command failed:.*$/m, "").trim();
  const lines = (withoutCmd || raw).split("\n").map((l) => l.trim()).filter(Boolean);
  // A child crash starts with a stack-trace header ("node:internal/..."), not
  // the message — prefer the first line that actually names an error.
  const firstLine = lines.find((l) => /^[A-Za-z]*Error\b|^[A-Z_]+:/.test(l)) ?? lines[0] ?? "";
  const redacted = firstLine
    .split(repoUrl)
    .join("<docs-repo>")
    .replace(/https?:\/\/[^\s@]*@[^\s]+/g, "<redacted-url>");
  return redacted.slice(0, 300) || "index refresh failed";
}

/** The index builder's stderr, reduced to what is safe and useful to log. */
export interface BuildOutput {
  lines: string[];
  /** "WARNING:" lines, counted before any are capped away. */
  warnings: number;
  /** Stack frames, plus lines cut from the middle of a long output. */
  linesOmitted: number;
}

const MAX_BUILD_LOG_LINES = 20;
const MAX_BUILD_LOG_LINE_CHARS = 300;
// Control characters (Cc), format characters (Cf: bidi marks, embeddings,
// overrides and isolates, zero-width characters, tags) and the Unicode line
// and paragraph separators. pino's JSON.stringify escapes C0 controls but
// passes the rest through raw.
const UNSAFE_LOG_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * The builder prints docs text from a public repo (version labels, page paths,
 * JSON.parse excerpts), and this goes to production logs: neutralize characters
 * that could forge or hide log content, and bound the volume.
 */
export function summarizeBuildOutput(stderr: string): BuildOutput {
  let linesOmitted = 0;
  const kept: string[] = [];
  for (const raw of stderr.split("\n")) {
    const line = raw.replace(UNSAFE_LOG_CHARS, " ").trim();
    if (!line) continue;
    if (/^at\s/.test(line)) {
      linesOmitted += 1;
      continue;
    }
    kept.push(line);
  }
  const warnings = kept.filter((l) => l.startsWith("WARNING:")).length;
  let lines = kept;
  if (kept.length > MAX_BUILD_LOG_LINES) {
    // The head says what was being built, the tail how it ended.
    const half = MAX_BUILD_LOG_LINES / 2;
    lines = [...kept.slice(0, half), ...kept.slice(-half)];
    linesOmitted += kept.length - MAX_BUILD_LOG_LINES;
  }
  return { lines: lines.map((l) => truncate(l, MAX_BUILD_LOG_LINE_CHARS)), warnings, linesOmitted };
}

/** A one-line reason for a failed build that names what actually happened. */
export function describeBuildFailure(
  err: ExecFileException,
  output: BuildOutput,
  limits: { timeoutMs: number; maxBuffer: number },
): string {
  if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return `index build output exceeded the ${limits.maxBuffer}-byte buffer`;
  }
  const exit = buildExit(err);
  // execFile kills a timed-out build with SIGTERM, which tsx relays to the
  // builder before exiting 143: a timeout can carry a signal and an exit code
  // too, so it must be tested before both.
  if (exit.timedOut) return `index build timed out after ${limits.timeoutMs}ms`;
  if (exit.signal) return `index build was killed by ${exit.signal}`;
  if (exit.exitCode !== null) {
    // The last Error line: sanitizeError's pattern also matches the WARNING
    // lines a build prints before it crashes.
    const crash = output.lines.filter((l) => /^[A-Za-z]*Error\b/.test(l)).pop();
    const exited = `index build exited with code ${exit.exitCode}`;
    return crash ? `${exited}: ${truncate(crash, 200)}` : exited;
  }
  if (typeof err.code === "string") return `index build could not start (${err.code})`;
  return "index build failed";
}

/** Cuts to `max` code points, the last being "…", never splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

export type BuildExit = { exitCode: number | null; signal: string | null; timedOut: boolean };

/**
 * How a failed build ended, as its build event logs it. The builder runs under
 * tsx, which relays the signals it receives to its node child and exits 128+n
 * when that child dies of signal n: a timeout reaches execFile as {code: 143,
 * killed: true}, and a SIGKILL of the builder (the out-of-memory killer's) as
 * {code: 137}, so the signal is read back from the exit code. execFile names a
 * signal itself only when tsx dies before relaying, as it does under a timeout
 * of a few milliseconds.
 */
export function buildExit(err: ExecFileException): BuildExit {
  const exitCode = typeof err.code === "number" ? err.code : null;
  const relayed =
    exitCode !== null && exitCode > 128
      ? (Object.entries(osConstants.signals).find(([, n]) => n === exitCode - 128)?.[0] ?? null)
      : null;
  return { exitCode, signal: err.signal ?? relayed, timedOut: err.killed === true };
}

/** A failed build, carrying what the child printed and how it ended. */
class IndexBuildError extends Error {
  constructor(
    message: string,
    readonly output: BuildOutput,
    readonly exit: BuildExit,
  ) {
    super(message);
    this.name = "IndexBuildError";
  }
}

/**
 * One event per build. warn is the level to alert on: a WARNING line means the
 * index was built degraded (docs.json unusable, pages skipped), or it failed.
 */
function logBuild(docsCommit: string, durationMs: number, output: BuildOutput, exit: BuildExit | null): void {
  logger[exit !== null || output.warnings > 0 ? "warn" : "info"](
    {
      docsCommit,
      duration_ms: durationMs,
      ok: exit === null,
      warnings: output.warnings,
      lines: output.lines,
      linesOmitted: output.linesOmitted,
      ...exit,
    },
    "index_refresh_build_finished",
  );
}

/**
 * The ONLY variables forwarded to the index-build child. Exported so a test
 * can assert no secret ever creeps onto it.
 */
export const BUILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "NODE_OPTIONS",
  "DOCS_BASE_URL",
] as const;

/** Copy only the named variables that are actually set. */
function pick(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = env[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
