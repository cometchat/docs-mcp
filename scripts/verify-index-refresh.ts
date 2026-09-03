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
 *
 * Usage: npx tsx scripts/verify-index-refresh.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SqliteSearchClient } from "../src/search/sqlite.js";
import { IndexRefresher } from "../src/index/refresher.js";

const root = mkdtempSync(path.join(tmpdir(), "verify-refresh-"));
const repo = path.join(root, "docs-origin");
const work = path.join(root, "generations");
const seedIndex = path.join(root, "seed.sqlite");

const git = (args: string[], cwd = repo) =>
  execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });

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

function commit(msg: string): string {
  git(["add", "-A"]);
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
  ]);
  return git(["rev-parse", "HEAD"]).trim();
}

function buildIndex(from: string, out: string): void {
  execFileSync("npx", ["tsx", "scripts/build-index.ts"], {
    env: { ...process.env, DOCS_REPO: from, INDEX_PATH: out },
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
    commit("gen6 — builds will time out");
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

    await failRefresher.tick();
    await failRefresher.tick();
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
