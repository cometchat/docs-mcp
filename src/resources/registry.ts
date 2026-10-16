import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "../lib/frontmatter.js";
import type { BundleStore } from "../bundles/loader.js";

export const SKILL_URI = "cometchat://skills/overview";
export const BUNDLE_URI_PREFIX = "cometchat://bundles/";

export type ResourceDescriptor = {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
};

export type ResourceContents = {
  uri: string;
  mimeType: string;
  text: string;
};

export class ResourceRegistry {
  private skillText: string;
  private skillDescription: string;

  private constructor(skillText: string, skillDescription: string, private bundles: BundleStore) {
    this.skillText = skillText;
    this.skillDescription = skillDescription;
  }

  static async load(skillsDir: string, bundles: BundleStore): Promise<ResourceRegistry> {
    const skillPath = path.join(skillsDir, "overview.md");
    const raw = await readFile(skillPath, "utf8");
    const parsed = parseFrontmatter(raw);
    const fm = parsed.data as { name?: string; description?: string };
    const description =
      typeof fm.description === "string" && fm.description.length > 0
        ? fm.description
        : "CometChat agent orientation skill.";
    return new ResourceRegistry(raw, description, bundles);
  }

  list(): ResourceDescriptor[] {
    const out: ResourceDescriptor[] = [
      {
        uri: SKILL_URI,
        name: "cometchat-overview",
        description: this.skillDescription,
        mimeType: "text/markdown",
      },
    ];
    for (const name of this.bundles.list()) {
      const b = this.bundles.spec(name)!;
      out.push({
        uri: `${BUNDLE_URI_PREFIX}${name}`,
        name,
        description: `${b.title} — ${b.framework}. Implementation bundle: the current documentation pages for this integration, compiled into one document.`,
        mimeType: "text/markdown",
      });
    }
    return out;
  }

  async read(uri: string): Promise<ResourceContents | null> {
    if (uri === SKILL_URI) {
      return { uri, mimeType: "text/markdown", text: this.skillText };
    }
    if (uri.startsWith(BUNDLE_URI_PREFIX)) {
      const name = uri.slice(BUNDLE_URI_PREFIX.length);
      const b = await this.bundles.get(name);
      if (!b) return null;
      // JSON strings are valid YAML double-quoted scalars, so quotes and line
      // breaks in a title cannot break the frontmatter.
      const q = (v: string) => JSON.stringify(v);
      const text = `---
title: ${q(b.title)}
framework: ${q(b.framework)}
last_verified: ${q(b.last_verified)}
prerequisites:
${b.prerequisites.map((p) => `  - ${q(p)}`).join("\n")}
---

${b.content}`;
      return { uri, mimeType: "text/markdown", text };
    }
    return null;
  }
}
