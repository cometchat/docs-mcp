import { describe, expect, it } from "vitest";
import { staleBundlePages } from "../src/bundles/versions.js";
import {
  indexNavigation,
  resolvePageVersion,
  versionFromPath,
  versionLabel,
} from "../src/search/navigation.js";

// Shaped like the real cometchat/docs docs.json: products > tabs > dropdowns >
// versions > groups > pages, including Mintlify's invisible U+200E padding
// that keeps repeated version labels unique across dropdowns.
const DOCS_JSON = {
  navigation: {
    products: [
      {
        product: "Chat & Messaging",
        tabs: [
          { tab: "Platform", pages: ["fundamentals/overview"] },
          {
            tab: "UI Kits",
            dropdowns: [
              {
                dropdown: "React",
                versions: [
                  {
                    version: "v7",
                    default: true,
                    groups: [
                      {
                        group: "Start",
                        pages: [
                          "ui-kit/react/overview",
                          { group: "Components", pages: ["ui-kit/react/components/message-list"] },
                        ],
                      },
                    ],
                  },
                  { version: "v6", default: false, groups: [{ group: "Start", pages: ["ui-kit/react/v6/overview"] }] },
                ],
              },
              {
                dropdown: "Angular",
                versions: [
                  { version: "v5\u200e", groups: [{ group: "Start", pages: ["ui-kit/angular/overview"] }] },
                  {
                    version: "v3\u200e",
                    groups: [{ group: "Start", pages: ["ui-kit/angular/3.0/overview", "ui-kit/angular/3.0/shared"] }],
                  },
                  {
                    version: "v2\u200e",
                    groups: [{ group: "Start", pages: ["ui-kit/angular/2.0/overview", "ui-kit/angular/3.0/shared"] }],
                  },
                ],
              },
            ],
          },
          {
            tab: "SDKs",
            dropdowns: [
              {
                dropdown: "Android",
                versions: [
                  {
                    version: "v5\u200e\u200e",
                    groups: [{ group: "Start", pages: ["sdk/android/v5/send-message", "sdk/android/v5/overview"] }],
                  },
                  {
                    version: "v4\u200e\u200e",
                    groups: [
                      { group: "Start", pages: ["sdk/android/send-message", "sdk/android/overview", "sdk/reference/auxiliary"] },
                    ],
                  },
                ],
              },
              {
                dropdown: "JavaScript",
                versions: [
                  {
                    version: "v4\u200e\u200e\u200e",
                    groups: [{ group: "Start", pages: ["sdk/javascript/overview", "sdk/reference/auxiliary"] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

const nav = indexNavigation(DOCS_JSON);

describe("versionLabel", () => {
  it("strips the invisible padding docs.json uses to keep labels unique", () => {
    expect(versionLabel("v5\u200e\u200e")).toBe("v5");
    expect(versionLabel("v4\u200e\u200e\u200e")).toBe("v4");
  });

  it("canonicalizes numeric labels and folder names", () => {
    expect(versionLabel(" V7 ")).toBe("v7");
    expect(versionLabel("3.0")).toBe("v3");
    expect(versionLabel("v3.5")).toBe("v3.5");
  });

  it("keeps non-numeric labels readable", () => {
    expect(versionLabel("Latest\u200e")).toBe("latest");
  });
});

describe("resolvePageVersion from docs.json navigation", () => {
  it("marks the default:true version current and the others legacy", () => {
    expect(resolvePageVersion("/ui-kit/react/overview", nav)).toEqual({
      product: "Chat & Messaging / UI Kits / React",
      version: "v7",
      isCurrent: true,
    });
    expect(resolvePageVersion("/ui-kit/react/components/message-list", nav)).toMatchObject({
      version: "v7",
      isCurrent: true,
    });
    expect(resolvePageVersion("/ui-kit/react/v6/overview", nav)).toMatchObject({ version: "v6", isCurrent: false });
  });

  it("treats the first listed version as current when none is marked default", () => {
    expect(resolvePageVersion("/ui-kit/angular/overview", nav)).toMatchObject({ version: "v5", isCurrent: true });
    expect(resolvePageVersion("/ui-kit/angular/3.0/overview", nav)).toMatchObject({ version: "v3", isCurrent: false });
    expect(resolvePageVersion("/ui-kit/angular/2.0/overview", nav)).toMatchObject({ version: "v2", isCurrent: false });
  });

  it("follows the navigation, not the path, when a /vN/ folder holds the current version", () => {
    // The Android Chat SDK lists v5 (under /v5/) first; v4 is the unversioned path.
    expect(resolvePageVersion("/sdk/android/v5/send-message", nav)).toEqual({
      product: "Chat & Messaging / SDKs / Android",
      version: "v5",
      isCurrent: true,
    });
    expect(resolvePageVersion("/sdk/android/send-message", nav)).toMatchObject({ version: "v4", isCurrent: false });
  });

  it("gives unversioned sections no label and treats them as current", () => {
    expect(resolvePageVersion("/fundamentals/overview", nav)).toEqual({
      product: "Chat & Messaging / Platform",
      version: null,
      isCurrent: true,
    });
  });

  it("keeps the most current listing of a page listed in several versions", () => {
    // Listed under Android v4 (legacy) first, then JavaScript v4 (current).
    expect(resolvePageVersion("/sdk/reference/auxiliary", nav)).toMatchObject({
      product: "Chat & Messaging / SDKs / JavaScript",
      isCurrent: true,
    });
    // Equally legacy listings: the first (newest) one wins.
    expect(resolvePageVersion("/ui-kit/angular/3.0/shared", nav)).toMatchObject({ version: "v3" });
  });
});

describe("resolvePageVersion for pages outside the navigation", () => {
  it("takes the version of the doc set that owns the page's folder", () => {
    expect(resolvePageVersion("/sdk/android/v5/llms-android-v5", nav)).toMatchObject({
      version: "v5",
      isCurrent: true,
    });
    expect(resolvePageVersion("/ui-kit/react/llms-react-v7", nav)).toMatchObject({ version: "v7", isCurrent: true });
    expect(resolvePageVersion("/sdk/android/unlisted", nav)).toMatchObject({ version: "v4", isCurrent: false });
  });

  it("walks up to the nearest owned folder", () => {
    expect(resolvePageVersion("/ui-kit/react/components/extra/new-page", nav)).toMatchObject({
      version: "v7",
      isCurrent: true,
    });
  });

  it("never climbs out of a version folder the navigation does not know", () => {
    expect(resolvePageVersion("/ui-kit/react/v9/overview", nav)).toEqual({
      product: null,
      version: "v9",
      isCurrent: false,
    });
  });

  it("falls back to the path for folders no versioned doc set owns", () => {
    expect(resolvePageVersion("/web-shared/theme", nav)).toEqual({ product: null, version: null, isCurrent: true });
  });
});

describe("versionFromPath (repos without docs.json)", () => {
  const empty = indexNavigation(undefined);

  it("reads vN/ and N.0/ folders as older versions", () => {
    expect(resolvePageVersion("/ui-kit/react/v4/overview", empty)).toEqual({
      product: null,
      version: "v4",
      isCurrent: false,
    });
    expect(resolvePageVersion("/sdk/javascript/2.0/setup", empty)).toMatchObject({ version: "v2", isCurrent: false });
  });

  it("treats unversioned paths as current", () => {
    expect(resolvePageVersion("/page-3", empty)).toEqual({ product: null, version: null, isCurrent: true });
  });

  it("only counts whole folder segments, not file names", () => {
    expect(versionFromPath("/sdk/javascript/v3-setup")).toMatchObject({ version: null, isCurrent: true });
    expect(versionFromPath("/changelog/v4")).toMatchObject({ version: null, isCurrent: true });
  });
});

describe("indexNavigation robustness", () => {
  it("ignores malformed nodes instead of throwing", () => {
    const odd = indexNavigation({
      navigation: {
        products: [null, 3, "stray", { product: "X", pages: [null, 5, "a/b", { pages: ["c/d"] }] }],
        versions: "not-an-array",
      },
    });
    expect(resolvePageVersion("a/b", odd)).toEqual({ product: "X", version: null, isCurrent: true });
    expect(resolvePageVersion("c/d", odd)).toMatchObject({ product: "X" });
  });

  it("yields an empty index for anything that is not a docs.json object", () => {
    for (const input of [null, undefined, "docs", 42, []]) {
      expect(indexNavigation(input).pages.size).toBe(0);
    }
  });
});

describe("staleBundlePages (verify:bundles)", () => {
  // Flutter v7 has shipped: v7 is the default at the unversioned paths, v6
  // moved under /v6/, and the old llms-flutter-v6 page is still published.
  const nav = indexNavigation({
    navigation: {
      products: [
        {
          product: "Chat & Messaging",
          tabs: [
            {
              tab: "UI Kits",
              dropdowns: [
                {
                  dropdown: "Flutter",
                  versions: [
                    { version: "v7\u200e", default: true, groups: [{ group: " ", pages: ["ui-kit/flutter/getting-started", "ui-kit/flutter/overview"] }] },
                    { version: "v6\u200e", groups: [{ group: " ", pages: ["ui-kit/flutter/v6/getting-started"] }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  });
  const spec = (pages: string[]) => [
    { name: "flutter-uikit-quickstart", title: "t", framework: "flutter", prerequisites: [], pages, related: [] },
  ];

  it("passes pages of the current version", () => {
    expect(staleBundlePages(spec(["/ui-kit/flutter/getting-started", "/ui-kit/flutter/llms-flutter-v7"]), nav)).toEqual([]);
  });

  it("flags a versioned llms page that is still published after a new major", () => {
    const problems = staleBundlePages(spec(["/ui-kit/flutter/getting-started", "/ui-kit/flutter/llms-flutter-v6"]), nav);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("llms-flutter-v6 is for v6, but the current");
    expect(problems[0]).toContain("v7");
  });

  it("flags a listed page of an older version", () => {
    const problems = staleBundlePages(spec(["/ui-kit/flutter/v6/getting-started"]), nav);
    expect(problems).toEqual([expect.stringContaining("documents v6")]);
  });
});
