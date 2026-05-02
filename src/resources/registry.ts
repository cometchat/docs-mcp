import { readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
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
    const parsed = matter(raw);
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
      const b = this.bundles.get(name)!;
      out.push({
        uri: `${BUNDLE_URI_PREFIX}${name}`,
        name,
        description: `${b.title} — ${b.framework}. Implementation bundle: prerequisites, install, configuration, working code.`,
        mimeType: "text/markdown",
      });
    }
    return out;
  }

  read(uri: string): ResourceContents | null {
    if (uri === SKILL_URI) {
      return { uri, mimeType: "text/markdown", text: this.skillText };
    }
    if (uri.startsWith(BUNDLE_URI_PREFIX)) {
      const name = uri.slice(BUNDLE_URI_PREFIX.length);
      const b = this.bundles.get(name);
      if (!b) return null;
      const text = `---
title: ${b.title}
framework: ${b.framework}
last_verified: ${b.last_verified}
prerequisites:
${b.prerequisites.map((p) => `  - "${p}"`).join("\n")}
---

${b.content}`;
      return { uri, mimeType: "text/markdown", text };
    }
    return null;
  }
}
