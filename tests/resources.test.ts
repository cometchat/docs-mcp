import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BundleStore } from "../src/bundles/loader.js";
import {
  ResourceRegistry,
  SKILL_URI,
  BUNDLE_URI_PREFIX,
} from "../src/resources/registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlesDir = path.resolve(here, "../bundles");
const skillsDir = path.resolve(here, "../skills");

describe("ResourceRegistry", () => {
  it("lists the orientation skill plus one resource per bundle", async () => {
    const bundles = await BundleStore.load(bundlesDir);
    const registry = await ResourceRegistry.load(skillsDir, bundles);
    const list = registry.list();
    expect(list[0].uri).toBe(SKILL_URI);
    expect(list[0].mimeType).toBe("text/markdown");
    expect(list.length).toBe(1 + bundles.list().length);
    for (const desc of list.slice(1)) {
      expect(desc.uri.startsWith(BUNDLE_URI_PREFIX)).toBe(true);
    }
  });

  it("reads the orientation skill content", async () => {
    const bundles = await BundleStore.load(bundlesDir);
    const registry = await ResourceRegistry.load(skillsDir, bundles);
    const out = registry.read(SKILL_URI);
    expect(out).not.toBeNull();
    expect(out!.text.length).toBeGreaterThan(500);
    expect(out!.text).toMatch(/CometChat Skill/);
  });

  it("reads each bundle as a resource", async () => {
    const bundles = await BundleStore.load(bundlesDir);
    const registry = await ResourceRegistry.load(skillsDir, bundles);
    for (const name of bundles.list()) {
      const out = registry.read(`${BUNDLE_URI_PREFIX}${name}`);
      expect(out, `bundle resource ${name}`).not.toBeNull();
      expect(out!.text.length).toBeGreaterThan(100);
    }
  });

  it("returns null for unknown URIs", async () => {
    const bundles = await BundleStore.load(bundlesDir);
    const registry = await ResourceRegistry.load(skillsDir, bundles);
    expect(registry.read("cometchat://unknown")).toBeNull();
    expect(registry.read("cometchat://bundles/does-not-exist")).toBeNull();
  });
});
