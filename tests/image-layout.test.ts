import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// scripts/build-index.ts runs under tsx INSIDE the image — when baking the
// index (--target full) and at runtime for the in-container refresh — but the
// image holds only what the runtime stage copies, not the repo. Every other
// test runs the script from the repo root, where all directories exist, so none
// of them can notice a directory the image forgot to ship. This one reads the
// Dockerfile instead.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Top-level entries under /app that the `runtime` stage copies in. */
function runtimeStageShips(): Set<string> {
  const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  const stage = dockerfile
    .split(/^(?=FROM\s)/m)
    .find((s) => /^FROM\s+\S+\s+AS\s+runtime\b/i.test(s));
  if (!stage) throw new Error("Dockerfile has no `runtime` stage");
  const shipped = new Set<string>();
  for (const line of stage.split("\n")) {
    const copy = line.match(/^COPY\s+(?:--\S+\s+)*(\S+)\s+(\S+)\s*$/);
    if (!copy) continue;
    const dest = copy[2].replace(/^\.\//, "").replace(/^\/app\//, "");
    if (dest) shipped.add(dest.split("/")[0]);
  }
  return shipped;
}

/** Top-level project directories reachable through relative imports. */
function importedRoots(entry: string): Set<string> {
  const roots = new Set<string>([entry.split("/")[0]]);
  const seen = new Set<string>();
  const IMPORT = /\b(import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/g;
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
      if (m[2]) continue; // `import type` is erased by tsx and never loaded
      let target = path.resolve(path.dirname(file), m[3]);
      if (target.endsWith(".js")) target = target.slice(0, -3) + ".ts";
      roots.add(path.relative(ROOT, target).split(path.sep)[0]);
      if (existsSync(target)) visit(target);
    }
  };
  visit(path.join(ROOT, entry));
  return roots;
}

describe("runtime image layout", () => {
  it("parses the runtime stage (guards against a vacuous pass)", () => {
    const shipped = runtimeStageShips();
    expect(shipped.has("dist")).toBe(true);
    expect(shipped.has("node_modules")).toBe(true); // tsx lives here
  });

  it("ships every project directory the index build imports", () => {
    const shipped = runtimeStageShips();
    const missing = [...importedRoots("scripts/build-index.ts")].filter((d) => !shipped.has(d));
    expect(missing, `runtime stage must COPY these into /app: ${missing.join(", ")}`).toEqual([]);
  });
});
