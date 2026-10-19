import { describe, it, expect } from "vitest";
import { checkPin, findPins, type Pin } from "../src/bundles/pins.js";

const pub = (versions: string[]) => ({ versions });

describe("findPins", () => {
  it("finds npm, pub, Maven, version-catalog, CocoaPods and SPM versions", () => {
    const text = [
      "npm install @cometchat/chat-uikit-react@7 @cometchat/chat-uikit-react-native@5.4.0",
      '"@cometchat/chat-sdk-javascript": "^4.2.1"',
      "  cometchat_chat_uikit: ^6.2.0",
      'implementation("com.cometchat:chatuikit-kotlin-android:6.0.6")',
      'implementation "com.cometchat:chat-sdk-android:5.+"',
      "[versions]",
      'cometchat-ui-kit = "6.0.3"',
      '[libraries]',
      'cometchat-ui-kit = { module = "com.cometchat:chatuikit-compose-android", version.ref = "cometchat-ui-kit" }',
      "pod 'CometChatUIKitSwift', '5.1.22'",
      "pod 'CometChatCallsSDK', '~> 5.0'",
      "2. Enter the repository URL:",
      "```",
      "https://github.com/cometchat/cometchat-uikit-ios",
      "```",
      "3. Select **Up to Exact Version** and enter:",
      "```",
      "5.1.22",
      "```",
      "For calling, add `https://github.com/cometchat/calls-sdk-ios` with **Up to Next Major Version** from `5.0.4`.",
    ].join("\n");
    const got = findPins(text).map((p) => `${p.registry} ${p.name} ${p.version} ${p.holds}`);
    expect(got).toEqual([
      "npm @cometchat/chat-uikit-react 7 major",
      "npm @cometchat/chat-uikit-react-native 5.4.0 exact",
      "npm @cometchat/chat-sdk-javascript ^4.2.1 major",
      "pub cometchat_chat_uikit ^6.2.0 major",
      "maven chatuikit-kotlin-android 6.0.6 exact",
      "maven chat-sdk-android 5.+ major",
      "maven chatuikit-compose-android 6.0.3 exact",
      "cocoapods CometChatUIKitSwift 5.1.22 exact",
      "cocoapods CometChatCallsSDK 5.0 major",
      "github cometchat-uikit-ios 5.1.22 exact",
      "github calls-sdk-ios 5.0.4 major",
    ]);
  });

  it("ignores version numbers that aren't install instructions", () => {
    expect(findPins("UI Kit 5.2.3 requires CometChatSDK 4.1.10 or later. React 18+.")).toEqual([]);
  });

  it("reads SPM versions only next to a Swift package repo", () => {
    expect(findPins("Sample app: https://github.com/cometchat/cometchat-sample-app-react\n\nRequires 7.2.4")).toEqual([]);
  });

  it("doesn't read an unrelated number near a Swift package URL as its version", () => {
    expect(findPins("Add https://github.com/cometchat/chat-sdk-ios\n\nRequires Xcode 16.0.1 or later.")).toEqual([]);
  });

  it("reads double-quoted pod lines", () => {
    expect(findPins(`pod "CometChatUIKitSwift", "5.1.22"`).map((p) => `${p.name} ${p.version} ${p.holds}`)).toEqual(["CometChatUIKitSwift 5.1.22 exact"]);
  });

  it("reads prerelease and ~ installs as what they are", () => {
    const got = findPins("npm i @cometchat/chat-uikit-react@7.0.0-beta.1 @cometchat/chat-sdk-javascript@~4.2.0").map((p) => `${p.version} ${p.holds}`);
    expect(got).toEqual(["7.0.0-beta.1 exact", "~4.2.0 minor"]);
  });

  it("doesn't read a platform or toolchain version next to an SPM URL as the package's", () => {
    const repo = "Add https://github.com/cometchat/chat-sdk-ios to your project.";
    expect(findPins(`${repo}\nSet the minimum deployment target version to 15.1.0.`)).toEqual([]);
    expect(findPins(`${repo}\nUse Up to Next Major Version from 15.1.0 of iOS.`)).toEqual([]);
    expect(findPins(`${repo}\nUse Up to Next Major Version from \`4.1.10\`.`).map((p) => p.version)).toEqual(["4.1.10"]);
  });

  it("doesn't take a sentence's full stop into a prerelease version", () => {
    expect(findPins("Install @cometchat/chat-uikit-react@7.0.0-beta.1.").map((p) => p.version)).toEqual(["7.0.0-beta.1"]);
  });

  it("resolves a version catalog ref to the nearest definition, per tab", () => {
    const tab = (v: string) =>
      ["[versions]", `cometchat = "${v}"`, "[libraries]", 'x = { module = "com.cometchat:chatuikit-kotlin-android", version.ref = "cometchat" }'].join("\n");
    expect(findPins(`${tab("6.1.1")}\n\n${tab("6.0.8")}`).map((p) => p.version)).toEqual(["6.1.1", "6.0.8"]);
  });

  it("takes an SPM version only up to the next URL", () => {
    const text = "https://github.com/cometchat/chat-sdk-ios\n\nsee https://example.com/x\n\n4.1.9";
    expect(findPins(text)).toEqual([]);
  });
});

describe("checkPin", () => {
  const pin = (version: string, holds: Pin["holds"] = /^\d+\.\d+\.\d+(-.+)?$/.test(version) ? "exact" : "major"): Pin => ({ registry: "npm", name: "kit", version, holds });
  const kit = pub(["5.2.0", "6.0.3", "6.0.6", "6.1.0", "6.1.1", "7.0.0-beta.1"]);

  it("passes a current pin and a range on the latest major", () => {
    expect(checkPin(pin("6.1.1"), kit).level).toBe("ok");
    expect(checkPin(pin("^6.0.3"), kit).level).toBe("ok");
    expect(checkPin(pin("6.+"), kit).level).toBe("ok");
    expect(checkPin(pin("6"), kit).level).toBe("ok");
  });

  it("fails an unpublished version, an older major, and an exact pin a minor behind", () => {
    expect(checkPin(pin("6.0.4"), kit)).toMatchObject({ level: "fail", reason: expect.stringContaining("not published") });
    expect(checkPin(pin("5.2.0"), kit)).toMatchObject({ level: "fail", reason: expect.stringContaining("older major") });
    expect(checkPin(pin("^5.0.0"), kit).level).toBe("fail");
    expect(checkPin(pin("6.0.6"), kit).level).toBe("fail");
  });

  it("doesn't count a prerelease as publishing the release, or as the latest version", () => {
    expect(checkPin(pin("7.0.0"), kit)).toMatchObject({ level: "fail", reason: expect.stringContaining("not published") });
    expect(checkPin(pin("6.1.1"), kit).level).toBe("ok");
  });

  it("checks a prerelease pin exactly, and fails it once its release is out", () => {
    expect(checkPin(pin("7.0.0-beta.1"), kit).level).toBe("ok");
    expect(checkPin(pin("7.0.0-beta.2"), kit).level).toBe("fail");
    expect(checkPin(pin("6.1.1-beta.1"), pub(["6.1.1-beta.1", "6.1.1"]))).toMatchObject({ level: "fail", reason: expect.stringContaining("is out") });
  });

  it("reads a ^ range on a prerelease as a prerelease until its release is out", () => {
    const betas = pub(["6.1.1", "7.0.0-beta.1", "7.0.0-beta.2"]);
    expect(checkPin(pin("^7.0.0-beta.1", "major"), betas).level).toBe("ok");
    expect(checkPin(pin("^7.0.0-beta.9", "major"), betas).level).toBe("fail");
    // Once 7.0.0 is out the range takes it, like any ^ range.
    expect(checkPin(pin("^7.0.0-beta.1", "major"), pub(["6.1.1", "7.0.0-beta.1", "7.0.0"])).level).toBe("ok");
  });

  it("holds a ~ range, and a 6.0.+ / 6.0.x range, to its minor", () => {
    expect(findPins("implementation 'com.cometchat:chatuikit-kotlin-android:6.0.+'")[0].holds).toBe("minor");
    expect(checkPin(pin("6.0.+", "minor"), kit).level).toBe("fail");
    expect(checkPin(pin("~6.0.3", "minor"), kit).level).toBe("fail");
    expect(checkPin(pin("~6.1.0", "minor"), kit).level).toBe("ok");
  });

  it("warns on an exact pin a patch behind", () => {
    expect(checkPin(pin("6.1.0"), kit).level).toBe("warn");
  });

  it("accepts a newer major published under another tag (e.g. next)", () => {
    expect(checkPin(pin("2.x.x"), pub(["1.0.36", "2.0.0"])).level).toBe("ok");
  });
});
