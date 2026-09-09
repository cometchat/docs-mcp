import { describe, it, expect } from "vitest";
import { BUILD_ENV_ALLOWLIST } from "../src/index/refresher.js";

// The index build parses ~3k files pulled from a public repo, inside the live
// serving container. It previously inherited the whole environment, so any
// parser bug was also a secret-exfiltration bug. This test fails the moment a
// secret is added back to the forwarded set.
describe("index-build child environment", () => {
  const SECRETS = [
    "ANALYTICS_SALT",
    "POSTHOG_KEY",
    "POSTHOG_HOST",
    "HEALTH_DETAIL_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "NPM_TOKEN",
  ];

  for (const name of SECRETS) {
    it(`never forwards ${name}`, () => {
      expect(BUILD_ENV_ALLOWLIST as readonly string[]).not.toContain(name);
    });
  }

  it("is an allowlist, not a denylist — nothing token/secret/key-shaped is on it", () => {
    const suspicious = (BUILD_ENV_ALLOWLIST as readonly string[]).filter((k) =>
      /TOKEN|SECRET|KEY|PASSWORD|SALT|CREDENTIAL/i.test(k),
    );
    expect(suspicious).toEqual([]);
  });

  it("still forwards what the builder needs to run at all", () => {
    expect(BUILD_ENV_ALLOWLIST as readonly string[]).toContain("PATH");
  });
});
