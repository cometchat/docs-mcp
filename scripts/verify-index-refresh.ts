/**
 * End-to-end proof that in-container index refresh works.
 *
 * Runs entirely offline against a throwaway local git repo, so it is safe in a
 * pre-commit hook and in CI. It exercises the real code path — git ls-remote,
 * sparse clone, child-process index build, validation, hot swap, self-heal —
 * not mocks.
 *
 * Scenarios:
 *   1. a new docs commit is detected, built, validated and swapped in
 *   2. a regressed commit (most pages deleted) is REJECTED and the good index
 *      keeps serving
 *   3. a rejected commit is remembered, so the poller does not rebuild it
 *   4. a docs page with executable (`---js`) frontmatter cannot run code or
 *      leak the server's environment during the in-container rebuild
 *   5. a git location inherited from a hook (GIT_DIR, GIT_INDEX_FILE) is
 *      ignored, so running this from a worktree hook cannot touch that repo
 *   6. a commit that loses docs.json navigation (deleted, then corrupted) is
 *      REJECTED, the builder's WARNING reaches the logs, and restoring
 *      docs.json is adopted
 *   7. a build that times out or crashes logs a warn-level build event with
 *      its output and how it ended, and lastError names the crash rather than
 *      an earlier WARNING line
 *
 * Usage: npx tsx scripts/verify-index-refresh.ts
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SqliteSearchClient } from "../src/search/sqlite.js";
import { IndexRefresher } from "../src/index/refresher.js";
import { logger } from "../src/lib/logger.js";
import { withoutGitRepoEnv } from "../src/lib/git-env.js";

const root = mkdtempSync(path.join(tmpdir(), "verify-refresh-"));
const repo = path.join(root, "docs-origin");
const work = path.join(root, "generations");
const seedIndex = path.join(root, "seed.sqlite");

const git = (args: string[], cwd = repo) =>
  execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8", env: withoutGitRepoEnv() });

function page(name: string, body: string): string {
  // Body must clear the builder's 40-character minimum (build-index.ts skips
  // shorter pages as stubs), so pad with realistic prose.
  const filler =
    "This page documents how to integrate the feature into your application " +
    "with the CometChat SDK, including setup and configuration steps.";
  return `---\ntitle: ${name}\n---\n\n# ${name}\n\n${body}\n\n${filler}\n`;
}

function writePages(count: number, marker: string): void {
  execFileSync("sh", ["-c", `rm -f ${repo}/*.mdx`]);
  for (let i = 0; i < count; i++) {
    writeFileSync(path.join(repo, `page-${i}.mdx`), page(`Page ${i}`, `${marker} chat message content ${i}`));
  }
}

function commit(msg: string, cwd = repo): string {
  git(["add", "-A"], cwd);
  // gpgsign=false: the throwaway repo must not inherit a developer's global
  // signing config, which would prompt for a key passphrase.
  git([
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    msg,
  ], cwd);
  return git(["rev-parse", "HEAD"], cwd).trim();
}

function buildIndex(from: string, out: string): void {
  execFileSync("npx", ["tsx", "scripts/build-index.ts"], {
    env: { ...withoutGitRepoEnv(), DOCS_REPO: from, INDEX_PATH: out },
    stdio: "pipe",
  });
}

let failures = 0;
// Must await: several checks are async, and an un-awaited assertion silently
// passes while its side effects race the next scenario.
const check = async (label: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures++;
    const msg = (err as Error).message.replace(/\s+/g, " ").slice(0, 200);
    console.error(`  ✗ ${label}\n      ${msg}`);
  }
};

type Logged = { level: "info" | "warn" | "error"; obj: Record<string, unknown>; msg: string };

/**
 * Records the logger calls made at `levels`, still passing each one on, until
 * restore() is called. pino assigns its level methods on the instance, so they
 * can be wrapped.
 */
function captureLogs(levels: Logged["level"][]): { logged: Logged[]; restore: () => void } {
  const logged: Logged[] = [];
  const originals = levels.map((level) => ({ level, write: logger[level] }));
  for (const { level, write } of originals) {
    logger[level] = ((obj: Record<string, unknown>, msg: string) => {
      logged.push({ level, obj, msg });
      write.call(logger, obj, msg);
    }) as typeof logger.warn;
  }
  const restore = () => {
    for (const { level, write } of originals) logger[level] = write;
  };
  return { logged, restore };
}

/** The events logged at `level` as `msg` for one docs commit. */
const eventsFor = (logged: Logged[], level: Logged["level"], msg: string, sha: string) =>
  logged.filter((e) => e.level === level && e.msg === msg && e.obj.docsCommit === sha);

async function main() {
  console.log("verify-index-refresh: setting up a local docs repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(work, { recursive: true });
  git(["init", "-q", "-b", "main"]);

  // Generation 1 — the "already deployed" baked index.
  writePages(30, "alpha");
  commit("gen1");
  buildIndex(repo, seedIndex);

  const client = new SqliteSearchClient(seedIndex);
  const before = await client.search("alpha", { limit: 5 });
  assert.ok(before.results.length > 0, "seed index should answer");

  const refresher = new IndexRefresher({
    searchClient: client,
    repoUrl: repo, // local path: git ls-remote/clone accept it, no network
    ref: "main",
    workDir: work,
    pollIntervalMs: 60_000,
    keepGenerations: 2,
    // Floors scaled to the fixture; ratios are the production values.
    policy: { minPages: 10, maxDropRatio: 0.2 },
    smokeQueries: ["chat"],
  });

  // ---- Scenario 1: a good new commit is picked up ------------------------
  writePages(40, "bravo");
  const goodSha = commit("gen2 — more pages");
  await refresher.tick();

  await check("new commit is detected, built and swapped in", () => {
    const s = refresher.snapshot();
    assert.equal(s.docsCommit, goodSha, `expected swap to ${goodSha.slice(0, 7)}, got ${String(s.docsCommit).slice(0, 7)}`);
    assert.equal(s.lastError, null, `unexpected error: ${s.lastError}`);
  });

  await check("served index now returns the NEW content", async () => {
    assert.equal(client.pageCount(), 40, "page count should reflect generation 2");
  });

  await check("previous generation is retained on disk for fallback", () => {
    assert.ok(refresher.snapshot().generations >= 1, "expected at least one retained generation");
  });

  // ---- Scenario 2a: relative regression, still above the absolute floor ---
  // 40 -> 28 pages is a 30% drop but comfortably above minPages(10): only the
  // RELATIVE guard can catch this, which is the case an absolute floor misses.
  writePages(28, "charlie");
  const droppedSha = commit("gen3 — 30% of pages deleted");
  await refresher.tick();

  await check("relative page-drop is REJECTED even though it clears the floor", () => {
    const s = refresher.snapshot();
    assert.notEqual(s.docsCommit, droppedSha, "regressed commit must not become current");
    assert.equal(s.docsCommit, goodSha, "should still serve the last good commit");
    assert.match(
      String(s.lastError),
      /more than 20% drop/i,
      `expected the relative guard to fire, got: ${s.lastError}`,
    );
  });

  // ---- Scenario 2b: catastrophic build, below the absolute floor ----------
  writePages(5, "charlie");
  const badSha = commit("gen3b — nearly everything deleted");
  await refresher.tick();

  await check("near-empty index is REJECTED by the absolute floor", () => {
    const s = refresher.snapshot();
    assert.notEqual(s.docsCommit, badSha, "poisoned commit must not become current");
    assert.equal(s.docsCommit, goodSha, "should still serve the last good commit");
    assert.match(String(s.lastError), /below floor/i);
  });

  await check("good index keeps serving after a rejection", async () => {
    assert.equal(client.pageCount(), 40, "still generation 2");
    const r = await client.search("bravo", { limit: 5 });
    assert.ok(r.results.length > 0, "good content still searchable");
  });

  // ---- Scenario 3: the bad commit is not retried -------------------------
  await check("rejected commit is remembered (no rebuild loop)", async () => {
    const poisonedBefore = refresher.snapshot().poisoned;
    assert.ok(poisonedBefore >= 1, "expected the bad commit to be marked");
    await refresher.tick();
    const s = refresher.snapshot();
    assert.equal(s.docsCommit, goodSha, "still on the good commit after re-poll");
  });

  // ---- Scenario 4: recovery after a bad commit --------------------------
  writePages(45, "delta");
  const recoverySha = commit("gen4 — restored");
  await refresher.tick();

  await check("a healthy commit after a bad one is accepted (recovery)", () => {
    assert.equal(refresher.snapshot().docsCommit, recoverySha);
  });

  // ---- Scenario 5: candidate passes validation but FAILS the smoke test --
  // The revert branch is otherwise untested: without this, deleting the
  // post-swap smoke check leaves every other scenario green.
  {
    const smokeClient = new SqliteSearchClient(seedIndex);
    await smokeClient.search("alpha", { limit: 1 });
    const smokeWork = path.join(root, "smoke-generations");
    mkdirSync(smokeWork, { recursive: true });
    const smokeRefresher = new IndexRefresher({
      searchClient: smokeClient,
      repoUrl: repo,
      ref: "main",
      workDir: smokeWork,
      pollIntervalMs: 60_000,
      keepGenerations: 2,
      policy: { minPages: 10, maxDropRatio: 0.2 },
      // "alpha" exists only in the seed generation; the repo HEAD is "delta",
      // so the candidate is valid but cannot answer this query.
      smokeQueries: ["alpha"],
    });
    const servedBefore = smokeClient.currentPath();
    await smokeRefresher.tick();

    await check("candidate failing the smoke test is REVERTED, not served", () => {
      assert.equal(
        smokeClient.currentPath(),
        servedBefore,
        "client must be back on the previous index",
      );
      assert.equal(smokeRefresher.snapshot().docsCommit, null, "no commit should be adopted");
      assert.match(String(smokeRefresher.snapshot().lastError), /smoke/i);
    });

    await check("reverted candidate file is cleaned up (no orphan)", () => {
      const leftovers = readdirSync(smokeWork).filter((f) => f.startsWith("index-"));
      assert.deepEqual(leftovers, [], `expected no orphaned index files, found ${leftovers}`);
    });

    await smokeRefresher.stop();
    smokeClient.close();
  }

  // ---- Scenario 6: a poisoned commit is not REBUILT ----------------------
  // Asserting on state alone passes even with the poison check removed (the
  // commit is simply re-rejected), so count actual builds instead.
  {
    const spy = refresher as unknown as { build: (a: string, b: string) => Promise<void> };
    const originalBuild = spy.build.bind(refresher);
    let builds = 0;
    spy.build = async (a: string, b: string) => {
      builds += 1;
      return originalBuild(a, b);
    };

    writePages(5, "echo"); // rejected: below the absolute floor
    commit("gen5 — broken again");
    await refresher.tick(); // rejects + poisons -> 1 build
    const afterFirst = builds;
    await refresher.tick(); // must be skipped entirely -> no build
    const afterSecond = builds;

    await check("poisoned commit is skipped WITHOUT rebuilding", () => {
      assert.equal(afterFirst, 1, "first tick should build once");
      assert.equal(afterSecond, afterFirst, "second tick must not rebuild a poisoned commit");
    });

    spy.build = originalBuild as typeof spy.build;
  }

  // ---- Scenario 7: build failures are given up on after maxAttempts ------
  // A commit whose build throws must not be re-cloned forever.
  {
    const failClient = new SqliteSearchClient(seedIndex);
    await failClient.search("alpha", { limit: 1 });
    const failWork = path.join(root, "fail-generations");
    mkdirSync(failWork, { recursive: true });
    writePages(40, "foxtrot");
    const timeoutSha = commit("gen6 — builds will time out");
    const failRefresher = new IndexRefresher({
      searchClient: failClient,
      repoUrl: repo,
      ref: "main",
      workDir: failWork,
      pollIntervalMs: 60_000,
      keepGenerations: 2,
      policy: { minPages: 10, maxDropRatio: 0.2 },
      buildTimeoutMs: 1, // the child is killed immediately -> build() throws
      maxAttempts: 2,
    });

    const capture = captureLogs(["warn"]);
    try {
      await failRefresher.tick();
      await failRefresher.tick();
    } finally {
      capture.restore();
    }
    const poisonedAfter = failRefresher.snapshot().poisoned;

    const spy = failRefresher as unknown as { build: (a: string, b: string) => Promise<void> };
    let buildsAfterGiveUp = 0;
    const orig = spy.build.bind(failRefresher);
    spy.build = async (a: string, b: string) => {
      buildsAfterGiveUp += 1;
      return orig(a, b);
    };
    await failRefresher.tick();

    await check("a commit whose build keeps failing is abandoned after maxAttempts", () => {
      assert.ok(poisonedAfter >= 1, "expected the failing commit to be abandoned");
      assert.equal(buildsAfterGiveUp, 0, "must not keep rebuilding an abandoned commit");
      assert.match(String(failRefresher.snapshot().lastError), /timed out after 1ms/);
    });

    await check("each timed-out build logs a warn-level index_refresh_build_finished", () => {
      const built = eventsFor(capture.logged, "warn", "index_refresh_build_finished", timeoutSha);
      assert.equal(built.length, 2, "expected one event per attempt");
      for (const { obj } of built) {
        // A 1 ms timeout kills tsx before it relays signals, so this is the bare
        // execFile shape; the shapes tsx reports are unit-tested.
        assert.deepEqual(
          { ok: obj.ok, exitCode: obj.exitCode, signal: obj.signal, timedOut: obj.timedOut },
          { ok: false, exitCode: null, signal: "SIGTERM", timedOut: true },
        );
      }
    });

    await check("failed builds leave no orphaned index files", () => {
      const leftovers = readdirSync(failWork).filter(
        (f) => f.startsWith("index-") || f.startsWith("clone-"),
      );
      assert.deepEqual(leftovers, [], `expected a clean work dir, found ${leftovers}`);
    });

    await failRefresher.stop();
    failClient.close();
  }

  // ---- Scenario 7b: a build that crashes is named by its crash -----------
  // The builder exits non-zero only when something like a full disk breaks it,
  // which a fixture cannot arrange. A preload passed through the allowlisted
  // NODE_OPTIONS makes the build process fail the same way instead: a WARNING
  // line, then an uncaught Error.
  {
    const crashWork = path.join(root, "crash-generations");
    const preload = path.join(root, "crash-preload.cjs");
    mkdirSync(crashWork, { recursive: true });
    writeFileSync(
      preload,
      [
        'require("node:fs").writeSync(2, "WARNING: printed before the crash" + String.fromCharCode(10));',
        'throw new Error("simulated build crash");',
      ].join("\n"),
    );
    writePages(40, "golf");
    const crashSha = commit("gen7 — the build crashes");
    const crashClient = new SqliteSearchClient(seedIndex);
    const crashRefresher = new IndexRefresher({
      searchClient: crashClient,
      repoUrl: repo,
      ref: "main",
      workDir: crashWork,
      pollIntervalMs: 60_000,
      keepGenerations: 2,
      policy: { minPages: 10, maxDropRatio: 0.2 },
    });
    const savedNodeOptions = process.env.NODE_OPTIONS;
    const capture = captureLogs(["warn"]);
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
    try {
      await crashRefresher.tick();
    } finally {
      if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = savedNodeOptions;
      capture.restore();
    }

    await check("a crashed build logs its output and exit, and lastError names the crash", () => {
      const [built] = eventsFor(capture.logged, "warn", "index_refresh_build_finished", crashSha);
      assert.ok(built, "expected a warn-level index_refresh_build_finished event");
      const lines = built.obj.lines as string[];
      assert.ok(lines.includes("WARNING: printed before the crash"), `got ${JSON.stringify(lines)}`);
      assert.ok(lines.includes("Error: simulated build crash"), `got ${JSON.stringify(lines)}`);
      const { ok, warnings, exitCode, signal, timedOut } = built.obj;
      assert.deepEqual(
        { ok, warnings, exitCode, signal, timedOut },
        { ok: false, warnings: 1, exitCode: 1, signal: null, timedOut: false },
      );
      assert.equal(crashRefresher.snapshot().lastError, "index build exited with code 1: Error: simulated build crash");
    });

    await crashRefresher.stop();
    crashClient.close();
  }

  // ---- Scenario 8: a commit that loses docs.json navigation --------------
  // A docs.json the builder cannot use still builds every page, so the page
  // rules pass while versions silently fall back to paths: only the navigation
  // count catches it, and only the builder's WARNING says why. A repo of its
  // own, because the scenarios above share `repo`, which has no docs.json.
  {
    const navRepo = path.join(root, "docs-nav");
    const navSeed = path.join(root, "nav-seed.sqlite");
    const navWork = path.join(root, "nav-generations");
    mkdirSync(navRepo, { recursive: true });
    mkdirSync(navWork, { recursive: true });
    git(["init", "-q", "-b", "main"], navRepo);
    const names = Array.from({ length: 40 }, (_, i) => `page-${i}`);
    names.forEach((name, i) =>
      writeFileSync(path.join(navRepo, `${name}.mdx`), page(`Page ${i}`, `nav chat message content ${i}`)),
    );
    // The tab label matters: a page listed under an empty trail gets no product.
    const docsJson = JSON.stringify({ navigation: { tabs: [{ tab: "Docs", pages: names }] } });
    writeFileSync(path.join(navRepo, "docs.json"), docsJson);
    commit("nav — docs.json lists every page", navRepo);
    buildIndex(navRepo, navSeed);

    const navClient = new SqliteSearchClient(navSeed);
    const navRefresher = new IndexRefresher({
      searchClient: navClient,
      repoUrl: navRepo,
      ref: "main",
      workDir: navWork,
      pollIntervalMs: 60_000,
      keepGenerations: 2,
      policy: { minPages: 10, maxDropRatio: 0.2 },
      smokeQueries: ["chat"],
    });

    const capture = captureLogs(["info", "warn", "error"]);
    const find = (level: Logged["level"], msg: string, sha: string) =>
      eventsFor(capture.logged, level, msg, sha).at(0);
    const buildLines = (sha: string) =>
      (find("warn", "index_refresh_build_finished", sha)?.obj.lines ?? []) as string[];

    try {
      rmSync(path.join(navRepo, "docs.json"));
      const missingSha = commit("nav — docs.json deleted", navRepo);
      await navRefresher.tick();

      await check("a commit deleting docs.json is REJECTED for losing navigation", () => {
        assert.equal(navClient.currentPath(), navSeed, "the seed index must keep serving");
        assert.equal(navRefresher.snapshot().docsCommit, null, "no commit should be adopted");
        assert.match(String(navRefresher.snapshot().lastError), /docs\.json navigation for 0 pages vs 40/);
        const rejected = find("error", "index_refresh_rejected", missingSha);
        assert.ok(rejected, "expected an index_refresh_rejected event");
        assert.equal(rejected.obj.code, "navigation_regression");
        assert.deepEqual(rejected.obj.served, { pages: 40, navPages: 40 });
        assert.deepEqual(rejected.obj.candidate, { pages: 40, navPages: 0 });
      });

      await check("the builder's missing docs.json WARNING is logged at warn", () => {
        const built = find("warn", "index_refresh_build_finished", missingSha);
        assert.ok(built, "expected a warn-level index_refresh_build_finished event");
        assert.ok(Number(built.obj.warnings) >= 1, `expected warnings >= 1, got ${built.obj.warnings}`);
        assert.ok(
          buildLines(missingSha).some((l) => l.startsWith("WARNING: no docs.json found")),
          `expected the WARNING line, got ${JSON.stringify(buildLines(missingSha))}`,
        );
      });

      writeFileSync(path.join(navRepo, "docs.json"), "{ not json");
      const corruptSha = commit("nav — docs.json corrupted", navRepo);
      await navRefresher.tick();

      await check("a corrupt docs.json is REJECTED and its WARNING is logged", () => {
        assert.equal(navClient.currentPath(), navSeed, "the seed index must keep serving");
        assert.match(String(navRefresher.snapshot().lastError), /docs\.json navigation for 0 pages vs 40/);
        assert.ok(find("error", "index_refresh_rejected", corruptSha), "expected the corrupt commit to be rejected");
        assert.ok(
          buildLines(corruptSha).some((l) => l.startsWith("WARNING: docs.json is not valid JSON")),
          `expected the WARNING line, got ${JSON.stringify(buildLines(corruptSha))}`,
        );
      });

      writeFileSync(path.join(navRepo, "docs.json"), docsJson);
      const restoredSha = commit("nav — docs.json restored", navRepo);
      await navRefresher.tick();

      await check("restoring docs.json is adopted, with no warn-level build event", () => {
        const s = navRefresher.snapshot();
        assert.equal(s.docsCommit, restoredSha, `expected ${restoredSha.slice(0, 7)}, got ${s.lastError}`);
        assert.equal(s.lastError, null);
        assert.equal(find("warn", "index_refresh_build_finished", restoredSha), undefined, "a clean build logs at info");
        const succeeded = find("info", "index_refresh_succeeded", restoredSha);
        assert.ok(succeeded, "expected an index_refresh_succeeded event");
        assert.equal(succeeded.obj.navPages, 40);
      });
    } finally {
      capture.restore();
      await navRefresher.stop();
      navClient.close();
    }
  }

  // --- hostile docs commit: executable frontmatter -------------------------
  // The rebuild runs as a CHILD OF THE LIVE SERVING CONTAINER with the
  // server's environment, so a page that can execute code during the build is
  // remote code execution plus secret exfiltration. gray-matter picks its
  // parser from the tag in the file and its `javascript` engine is `eval`.
  {
    console.log("\nverify-index-refresh: hostile docs commit (executable frontmatter)");
    const canary = `CANARY-${Math.random().toString(36).slice(2)}`;
    const hostileRepo = path.join(root, "docs-hostile");
    mkdirSync(hostileRepo, { recursive: true });
    git(["init", "-q", "-b", "main"], hostileRepo);
    for (let i = 0; i < 12; i++) {
      writeFileSync(path.join(hostileRepo, `ok-${i}.mdx`), page(`Ok ${i}`, `benign chat content ${i}`));
    }
    // Exfiltrates an env var to stdout — the same primitive that would leak
    // ANALYTICS_SALT / POSTHOG_KEY / HEALTH_DETAIL_TOKEN in production.
    writeFileSync(
      path.join(hostileRepo, "evil.mdx"),
      '---js\n{ title: (globalThis.process.stdout.write("PWNED:" + globalThis.process.env.SECRET_CANARY + "\\n"), "Innocent Page") }\n---\n\n' +
        "# Innocent Page\n\nzzmarkerzz this body is unique to the hostile page and must never be indexed.\n",
    );
    git(["add", "-A"], hostileRepo);
    git(
      ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "hostile"],
      hostileRepo,
    );

    const hostileOut = path.join(root, "hostile.sqlite");
    // spawnSync, not execFileSync: the builder logs to stderr and execFileSync
    // returns stdout only, which would silently pass the "was it reported"
    // check no matter what the builder printed.
    const built = spawnSync("npx", ["tsx", "scripts/build-index.ts"], {
      env: { ...withoutGitRepoEnv(), DOCS_REPO: hostileRepo, INDEX_PATH: hostileOut, SECRET_CANARY: canary },
      encoding: "utf8",
    });
    const combined = (built.stdout ?? "") + (built.stderr ?? "");
    const buildFailed = built.status !== 0;

    await check("executable frontmatter does NOT run during the index build", () => {
      assert.ok(!combined.includes("PWNED"), "frontmatter code executed during the build");
      assert.ok(!combined.includes(canary), "the build leaked an environment variable");
    });

    await check("the hostile page is skipped, not indexed", async () => {
      assert.equal(buildFailed, false, "one bad page must not abort the whole build");
      const c = new SqliteSearchClient(hostileOut);
      const hits = await c.search("zzmarkerzz", { limit: 5 });
      c.close();
      assert.equal(hits.results.length, 0, "hostile page must not appear in the index");
    });

    await check("the rest of the commit still indexes (build is not derailed)", async () => {
      const c = new SqliteSearchClient(hostileOut);
      const hits = await c.search("benign", { limit: 20 });
      c.close();
      assert.ok(hits.results.length > 0, "benign pages should still be indexed");
    });

    await check("the skip is reported loudly, not silently swallowed", () => {
      // The WARNING: prefix is what makes the refresher log the build at warn.
      assert.match(
        built.stderr,
        /^WARNING: skipped 1 page\(s\) with executable frontmatter: evil\.mdx$/m,
        "expected a WARNING line naming the skipped page",
      );
    });
  }

  // --- a hook's git location must not leak into our git commands ----------
  // Git exports GIT_DIR and GIT_INDEX_FILE to hooks, as absolute paths inside a
  // linked worktree. Inherited by child git processes they redirect every one
  // of them at the committing repository: run from a worktree's pre-commit hook,
  // this script once rewrote that worktree's HEAD and index and set core.bare.
  {
    console.log("\nverify-index-refresh: inherited GIT_DIR / GIT_INDEX_FILE are ignored");
    const decoy = path.join(root, "decoy");
    mkdirSync(decoy, { recursive: true });
    git(["init", "-q", "-b", "main"], decoy);
    writeFileSync(path.join(decoy, "keep.txt"), "decoy\n");
    git(["add", "-A"], decoy);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "decoy"], decoy);
    const decoyHead = git(["rev-parse", "HEAD"], decoy).trim();
    const decoyConfig = readFileSync(path.join(decoy, ".git", "config"), "utf8");

    const leakRepo = path.join(root, "docs-leak");
    const leakWork = path.join(root, "leak-generations");
    mkdirSync(leakRepo, { recursive: true });
    const leakClient = new SqliteSearchClient(seedIndex);
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = path.join(decoy, ".git");
    process.env.GIT_INDEX_FILE = path.join(decoy, ".git", "index");
    let leakCommit = "";
    try {
      git(["init", "-q", "-b", "main"], leakRepo);
      for (let i = 0; i < 12; i++) {
        writeFileSync(path.join(leakRepo, `leak-${i}.mdx`), page(`Leak ${i}`, `leakcheck chat content ${i}`));
      }
      git(["add", "-A"], leakRepo);
      git(
        ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "leak"],
        leakRepo,
      );
      leakCommit = git(["rev-parse", "HEAD"], leakRepo).trim();
      const leakRefresher = new IndexRefresher({
        searchClient: leakClient,
        repoUrl: leakRepo,
        ref: "main",
        workDir: leakWork,
        pollIntervalMs: 3_600_000,
        keepGenerations: 2,
        policy: { minPages: 5, maxDropRatio: 0.9 },
        // The default smoke queries ("chat", "message") would revert this
        // fixture, whose pages never say "message".
        smokeQueries: ["leakcheck"],
      });
      await leakRefresher.tick();
      await leakRefresher.stop();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    await check("fixture commits land in the throwaway repo, not the inherited GIT_DIR", () => {
      assert.match(leakCommit, /^[0-9a-f]{40}$/);
      assert.equal(git(["rev-parse", "HEAD"], decoy).trim(), decoyHead, "decoy HEAD moved");
    });
    await check("the inherited repository's config is untouched (no core.bare flip)", () => {
      assert.equal(readFileSync(path.join(decoy, ".git", "config"), "utf8"), decoyConfig);
    });
    await check("the refresher still cloned and built from the throwaway repo", async () => {
      const r = await leakClient.search("leakcheck", { limit: 5 });
      assert.ok(r.results.length > 0, "expected the leak repo's pages to be served");
    });
    leakClient.close();
  }

  await refresher.stop();
  client.close();

  if (failures > 0) {
    console.error(`\nverify-index-refresh: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nverify-index-refresh: all checks passed");
}

main()
  .catch((err) => {
    console.error("verify-index-refresh: crashed\n", err);
    process.exit(1);
  })
  .finally(() => rmSync(root, { recursive: true, force: true }));
