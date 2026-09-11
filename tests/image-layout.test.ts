import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// scripts/build-index.ts runs under tsx INSIDE the image — when baking the
// index (--target full) and at runtime for the in-container refresh — but the
// image holds only what the runtime stage copies, not the repo. Every other
// test runs the script from the repo root, where all directories exist, so none
// of them can notice a directory the image forgot to ship. This one reads the
// Dockerfile instead. Packages share that blind spot: tests run with
// devDependencies installed, but the runtime stage copies a node_modules pruned
// to production dependencies. So this file also pins that prune, and that
// everything the image loads is classified as a production dependency.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pkg: { dependencies: Record<string, string> } = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf8"),
);
const lock: { packages: Record<string, { dev?: boolean; bin?: Record<string, string> }> } = JSON.parse(
  readFileSync(path.join(ROOT, "package-lock.json"), "utf8"),
);

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

/** The Dockerfile without its comment lines, whose prose is not instructions. */
function dockerfileCode(dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8")): string {
  return dockerfile
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

interface DockerStage {
  name?: string;
  base: string;
  text: string;
}

/** Every `FROM <base> [AS <name>]` stage, comments stripped. */
function dockerStages(dockerfile?: string): DockerStage[] {
  return dockerfileCode(dockerfile)
    .split(/^(?=FROM\s)/m)
    .flatMap((text) => {
      const from = text.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
      return from ? [{ base: from[1], name: from[2], text }] : [];
    });
}

/**
 * Why the node_modules the runtime stage copies in may still hold
 * devDependencies, or undefined when its stage prunes them after they last get in.
 */
function unprunedNodeModules(dockerfile?: string): string | undefined {
  const stages = dockerStages(dockerfile);
  const runtime = stages.find((s) => s.name === "runtime");
  if (!runtime) throw new Error("Dockerfile has no `runtime` stage");
  // Every COPY into node_modules, since a second one overwrites the pruned tree.
  const copies = runtime.text.split("\n").flatMap((line) => {
    const copy = line.match(/^COPY\s+((?:--\S+\s+)*)\S+\s+(\S+)\s*$/);
    const dest = copy?.[2].replace(/^\.\//, "").replace(/^\/app\//, "");
    return copy && dest?.split("/")[0] === "node_modules" ? [copy[1]] : [];
  });
  if (copies.length !== 1) return `runtime stage must COPY node_modules in exactly once, not ${copies.length} times`;
  const from = copies[0].match(/--from=(\S+)/)?.[1];
  if (!from) return "runtime stage must COPY --from=<stage> /app/node_modules";

  // That stage runs after the stages it is built FROM, so read them as one
  // script of shell commands, ancestors first.
  const chain: DockerStage[] = [];
  for (let s = stages.find((st) => st.name === from); s && !chain.includes(s); ) {
    chain.unshift(s);
    const base = s.base;
    s = stages.find((st) => st.name === base);
  }
  const commands = chain
    .map((s) => s.text)
    .join("\n")
    .split(/\n|&&|\|\||;/);
  const prunes = (command: string) =>
    /\bnpm\s+prune\b/.test(command) &&
    /--omit[= ]dev\b/.test(command) &&
    !/--dry-run\b|--include[= ]dev\b/.test(command);
  // devDependencies get in through a COPY of node_modules or through nearly any
  // npm command: install has many aliases (i, add, ic, it, up, ...), and dedupe,
  // uninstall, audit fix or a bare prune all restore a pruned tree. Only
  // `npm run` and a real prune leave them out, so the prune must follow the rest.
  const fills = (command: string) =>
    /^\s*COPY\s.*\bnode_modules\b/.test(command) ||
    (/\bnpm\s/.test(command) && !/\bnpm\s+run\b/.test(command) && !prunes(command));
  let last = -1;
  commands.forEach((command, i) => {
    if (fills(command)) last = i;
  });
  return commands.slice(last + 1).some(prunes)
    ? undefined
    : `stage "${from}" must run \`npm prune --omit=dev\` after its last COPY of node_modules and every npm command but npm run, or the runtime image ships devDependencies`;
}

/** Dockerfile lines that run a package through npx or `npm exec` (alias `npm x`), which npx is. */
function npxLines(dockerfile?: string): string[] {
  return dockerfileCode(dockerfile)
    .split("\n")
    .filter((line) => /\bnpx\b|\bnpm\s+(?:exec|x)\b/.test(line));
}

/**
 * The file a relative import loads, found the way tsx and moduleResolution
 * Bundler find it: a .js, .mjs or .cjs specifier names its TypeScript source,
 * and an extensionless one a .ts file or a directory's index.ts. Throws rather
 * than skip an import it cannot follow.
 */
function resolveImport(file: string, specifier: string): string {
  const target = path.resolve(path.dirname(file), specifier);
  const candidates = [target.replace(/\.([mc]?)js$/, ".$1ts"), target, `${target}.ts`, path.join(target, "index.ts")];
  const found = candidates.find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile());
  if (!found) throw new Error(`${path.relative(ROOT, file)} imports "${specifier}", which resolves to no file`);
  return found;
}

/**
 * Packages the image loads: every value import reachable from the server,
 * stdio and index-build entrypoints, plus the package that provides each
 * node_modules/.bin executable those files or the Dockerfile run. Uses the
 * TypeScript parser because comment prose can look like an import
 * (src/search/mdx-imports.ts has one).
 */
function runtimeLoads(
  entries = ["src/server.ts", "src/stdio.ts", "scripts/build-index.ts"].map((e) => path.join(ROOT, e)),
): Set<string> {
  const loads = new Set<string>();
  const texts = [dockerfileCode()];
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    texts.push(text);
    const specifiers: string[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        // `import type` is erased by tsx and tsc and never loaded.
        if (!node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
          specifiers.push(node.moduleSpecifier.text);
        }
      } else if (ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && !node.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
          specifiers.push(node.moduleSpecifier.text);
        }
      } else if (ts.isCallExpression(node)) {
        const [arg] = node.arguments;
        const callee = node.expression;
        const loader =
          callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
        if (loader && arg && ts.isStringLiteralLike(arg)) specifiers.push(arg.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        visit(resolveImport(file, specifier));
      } else if (!specifier.startsWith("node:") && !builtinModules.includes(specifier)) {
        const parts = specifier.split("/");
        loads.add(parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/"));
      }
    }
  };
  for (const entry of entries) visit(entry);

  // An executable run by path, like the refresher's
  // path.join(APP_ROOT, "node_modules", ".bin", "tsx"), is loaded from
  // whichever package the lockfile says provides that bin.
  const BIN = /node_modules(?:\/|["'],\s*["'])\.bin(?:\/|["'],\s*["'])([\w.-]+)/g;
  const topLevel = Object.entries(lock.packages).filter(([key]) =>
    /^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(key),
  );
  for (const text of texts) {
    for (const [, bin] of text.matchAll(BIN)) {
      const owners = topLevel.filter(([, entry]) => entry.bin && Object.hasOwn(entry.bin, bin));
      if (owners.length !== 1) {
        throw new Error(`node_modules/.bin/${bin} is provided by ${owners.length} lockfile packages, expected 1`);
      }
      loads.add(owners[0][0].slice("node_modules/".length));
    }
  }
  return loads;
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

  it("installs only production dependencies into the runtime image", () => {
    expect(unprunedNodeModules()).toBeUndefined();
  });

  // What T1 reads, reduced to a Dockerfile it accepts, and variants of it.
  const BUILD = "FROM node:24-bookworm-slim AS build\nRUN npm ci --no-audit --no-fund\nRUN npm run build\n";
  const PRUNE = "RUN npm prune --omit=dev --no-audit --no-fund\n";
  const COPY_MODULES = "COPY --from=build /app/node_modules ./node_modules\n";
  const RUNTIME = `FROM node:24-bookworm-slim AS runtime\n${COPY_MODULES}`;
  const nodeStage = (name: string, ...lines: string[]) => `FROM node:24-bookworm-slim AS ${name}\n${lines.join("")}`;
  const runtimeFrom = (name: string) => RUNTIME.replace("--from=build", `--from=${name}`);

  it.each([
    ["prunes in the build stage", BUILD + PRUNE + RUNTIME],
    ["prunes in a stage built FROM it", `${BUILD}FROM build AS prod-deps\n${PRUNE}${runtimeFrom("prod-deps")}`],
    ["prunes node_modules after copying it in", BUILD + nodeStage("prod", COPY_MODULES, PRUNE) + runtimeFrom("prod")],
  ])("accepts a Dockerfile that %s", (_, dockerfile) => {
    expect(unprunedNodeModules(dockerfile)).toBeUndefined();
  });

  it.each<[string, string, RegExp]>([
    ["never prunes", BUILD + RUNTIME, /must run `npm prune --omit=dev`/],
    ["runs npm i after the prune", `${BUILD}${PRUNE}RUN npm i\n${RUNTIME}`, /must run/],
    ["runs npm clean-install after the prune", `${BUILD}${PRUNE}RUN npm clean-install\n${RUNTIME}`, /must run/],
    ["runs npm dedupe after the prune", `${BUILD}${PRUNE}RUN npm dedupe\n${RUNTIME}`, /must run/],
    ["runs a bare npm prune after the prune", `${BUILD}${PRUNE.trimEnd()} && npm prune\n${RUNTIME}`, /must run/],
    ["prunes with --include=dev", `${BUILD}RUN npm prune --omit=dev --include=dev\n${RUNTIME}`, /must run/],
    ["prunes before node_modules is copied in", BUILD + nodeStage("prod", PRUNE, COPY_MODULES) + runtimeFrom("prod"), /must run/],
    [
      "copies node_modules in again from an unpruned stage",
      `${BUILD}${PRUNE}FROM build AS devdeps\nRUN npm ci\n${RUNTIME}COPY --from=devdeps /app/node_modules ./node_modules\n`,
      /exactly once/,
    ],
  ])("rejects a Dockerfile that %s", (_, dockerfile, reason) => {
    expect(unprunedNodeModules(dockerfile)).toMatch(reason);
  });

  it("declares every package the image loads as a production dependency", () => {
    const loaded = [...runtimeLoads()];
    expect(loaded).toEqual(expect.arrayContaining(["better-sqlite3", "gray-matter", "tsx"]));
    // Soft, so one run names every misclassified package in both files.
    const undeclared = loaded.filter((n) => !Object.hasOwn(pkg.dependencies, n));
    expect
      .soft(undeclared, `the image prunes devDependencies; list these under package.json "dependencies"`)
      .toEqual([]);
    const unlocked = loaded.filter((n) => !lock.packages[`node_modules/${n}`]);
    expect.soft(unlocked, "package-lock.json has no top-level entry for these").toEqual([]);
    const devFlagged = loaded.filter((n) => lock.packages[`node_modules/${n}`]?.dev === true);
    expect
      .soft(devFlagged, "package-lock.json flags these dev, so the image prunes them; regenerate the lockfile")
      .toEqual([]);
  });

  it("follows every relative import tsx resolves, and throws on one it cannot", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "image-layout-"));
    try {
      const files: Record<string, string> = {
        "entry.ts": 'import "./bare";\nimport "./mapped.js";\nimport "./module.mjs";\n',
        "bare.ts": 'import "pkg-bare";\n',
        "mapped.ts": 'import "pkg-mapped";\n',
        "module.mts": 'import "pkg-module";\n',
        "directory.ts": 'import "./dir";\n',
        "dir/index.ts": 'import "pkg-dir";\n',
        "broken.ts": 'import "./missing";\n',
      };
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        writeFileSync(path.join(dir, name), text);
      }
      expect([...runtimeLoads([path.join(dir, "entry.ts")])]).toEqual(
        expect.arrayContaining(["pkg-bare", "pkg-mapped", "pkg-module"]),
      );
      expect([...runtimeLoads([path.join(dir, "directory.ts")])]).toContain("pkg-dir");
      expect(() => runtimeLoads([path.join(dir, "broken.ts")])).toThrow(/broken\.ts.*"\.\/missing"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never runs npx or npm exec in the image", () => {
    // If a package were missing after the prune, npx (that is, npm exec) in a
    // non-TTY build would install whatever the registry serves instead of failing.
    expect(
      npxLines(),
      "run executables as node_modules/.bin/<name> in the Dockerfile, not through npx or npm exec",
    ).toEqual([]);
  });

  it.each(["npx tsx", "npm exec -- tsx", "npm x tsx"])("rejects `%s` in a Dockerfile", (runner) => {
    expect(npxLines(`FROM runtime AS indexer\nRUN ${runner} scripts/build-index.ts\n`)).not.toEqual([]);
  });
});
