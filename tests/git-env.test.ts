import { describe, it, expect } from "vitest";
import { GIT_REPO_LOCATION_VARS, withoutGitRepoEnv } from "../src/lib/git-env.js";

describe("withoutGitRepoEnv", () => {
  it("drops every repository-location variable git exports to hooks", () => {
    const leaked = Object.fromEntries(GIT_REPO_LOCATION_VARS.map((k) => [k, "/some/other/repo/.git"]));
    const out = withoutGitRepoEnv({ ...leaked, PATH: "/usr/bin", GIT_TERMINAL_PROMPT: "0" });
    for (const k of GIT_REPO_LOCATION_VARS) expect(out).not.toHaveProperty(k);
    // Git settings that are not a repository location still pass through.
    expect(out).toMatchObject({ PATH: "/usr/bin", GIT_TERMINAL_PROMPT: "0" });
  });

  it("does not mutate the environment it is given", () => {
    const env = { GIT_DIR: "/x/.git" };
    withoutGitRepoEnv(env);
    expect(env.GIT_DIR).toBe("/x/.git");
  });
});
