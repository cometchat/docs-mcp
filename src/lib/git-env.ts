/**
 * Environment for a child `git` that must act only on the repository its
 * arguments name (`-C dir`, a clone target, its cwd).
 *
 * Git exports GIT_DIR, GIT_INDEX_FILE and friends to hooks, and inside a linked
 * worktree they are absolute paths. A child git that inherits them ignores its
 * cwd and works on the committing repository instead: the refresh E2E, run by
 * the pre-commit hook from a worktree, once rewrote that worktree's HEAD and
 * index and set core.bare=true in the shared config.
 */
export const GIT_REPO_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
] as const;

export function withoutGitRepoEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of GIT_REPO_LOCATION_VARS) delete out[key];
  return out;
}
