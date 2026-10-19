/**
 * The implementation bundles, as lists of docs pages.
 *
 * A bundle has no content of its own: get_cometchat_implementation_bundle
 * reads its `pages` from the live docs (the same .md source the fetch tool
 * uses) and returns them together. The docs pages are the single source of
 * truth, so fixing a quickstart page fixes its bundle; nothing here goes stale
 * when a kit releases. Hand-written bundle files did (they sat on old kit
 * majors and removed components for months).
 *
 * `pages` are included in order while they fit in BUNDLE_MAX_BYTES; the rest,
 * and `related`, are listed as paths to fetch. Paths are docs paths without
 * the .md suffix. `npm run verify:bundles` checks every path still resolves,
 * is current, and installs current package versions.
 */
export type BundleSpec = {
  name: string;
  title: string;
  framework: string;
  prerequisites: string[];
  /** Docs pages whose content makes up the bundle, most important first. */
  pages: string[];
  /** Further pages, listed by path for the agent to fetch. */
  related: string[];
};

/** When this list of pages was last reviewed against the docs navigation. */
export const BUNDLES_REVIEWED = "2026-10-19";

const CREDENTIALS = "CometChat App ID, Auth Key, and Region from app.cometchat.com";

export const BUNDLES: readonly BundleSpec[] = [
  {
    name: "react-uikit-quickstart",
    title: "React UI Kit Quickstart",
    framework: "react",
    prerequisites: ["Node.js 20.19+", "React 18–20 project (Vite or Next.js)", CREDENTIALS],
    pages: ["/ui-kit/react/integration-react", "/ui-kit/react/llms-react-v7"],
    related: [
      "/ui-kit/react/integration-nextjs",
      "/ui-kit/react/components-overview",
      "/ui-kit/react/theming",
      "/ui-kit/react/methods",
    ],
  },
  {
    name: "react-native-uikit-quickstart",
    title: "React Native UI Kit Quickstart",
    framework: "react-native",
    prerequisites: ["Node.js 22.13+ (React Native 0.88)", "React Native CLI or Expo (development build) project", CREDENTIALS],
    pages: ["/ui-kit/react-native/react-native-cli-integration", "/ui-kit/react-native/llms-react-native-v5"],
    related: [
      "/ui-kit/react-native/expo-integration",
      "/ui-kit/react-native/components-overview",
      "/ui-kit/react-native/calling-integration",
    ],
  },
  {
    name: "angular-uikit-quickstart",
    title: "Angular UI Kit Quickstart",
    framework: "angular",
    prerequisites: ["Node.js 20.19+", "Angular 17–21 project (the kit doesn't support 22 yet)", CREDENTIALS],
    pages: ["/ui-kit/angular/integration", "/ui-kit/angular/llms-angular-v5"],
    related: [
      "/ui-kit/angular/components/components-overview",
      "/ui-kit/angular/customization/theming",
      "/ui-kit/angular/call-features",
    ],
  },
  {
    name: "flutter-uikit-quickstart",
    title: "Flutter UI Kit Quickstart",
    framework: "flutter",
    prerequisites: ["Flutter SDK (stable)", CREDENTIALS],
    pages: ["/ui-kit/flutter/getting-started", "/ui-kit/flutter/llms-flutter-v6"],
    related: [
      "/ui-kit/flutter/components-overview",
      "/ui-kit/flutter/theme-introduction",
      "/ui-kit/flutter/call-features",
    ],
  },
  {
    name: "ios-uikit-quickstart",
    title: "iOS UI Kit Quickstart",
    framework: "ios",
    prerequisites: ["Xcode 16+", "iOS 15.1+ deployment target", "Swift Package Manager", CREDENTIALS],
    pages: ["/ui-kit/ios/getting-started", "/ui-kit/ios/llms-ios-v5"],
    related: ["/ui-kit/ios/components-overview", "/ui-kit/ios/ios-conversation", "/ui-kit/ios/theme-introduction"],
  },
  {
    name: "android-uikit-quickstart",
    title: "Android UI Kit Quickstart",
    framework: "android",
    prerequisites: ["Android Studio", "Kotlin", CREDENTIALS],
    pages: [
      "/ui-kit/android/getting-started",
      "/ui-kit/android/getting-started-jetpack",
      "/ui-kit/android/llms-android-v6",
    ],
    related: [
      "/ui-kit/android/getting-started-kotlin",
      "/ui-kit/android/components-overview",
      "/ui-kit/android/calling-integration",
    ],
  },
  {
    name: "js-sdk-messaging-basics",
    title: "JavaScript SDK — Messaging Basics",
    framework: "javascript",
    prerequisites: ["A web or Node.js project", CREDENTIALS],
    pages: ["/sdk/javascript/setup-sdk", "/sdk/javascript/send-message", "/sdk/javascript/receive-message"],
    related: [
      "/sdk/javascript/authentication-overview",
      "/sdk/javascript/all-real-time-listeners",
      "/sdk/javascript/llms-javascript-v4",
    ],
  },
  {
    name: "presence-and-typing",
    title: "Presence, Typing Indicators, and Read Receipts",
    framework: "javascript",
    prerequisites: ["CometChat JavaScript SDK initialized and a user logged in"],
    pages: [
      "/sdk/javascript/user-presence",
      "/sdk/javascript/typing-indicators",
      "/sdk/javascript/delivery-read-receipts",
    ],
    related: ["/sdk/javascript/connection-status", "/sdk/javascript/all-real-time-listeners"],
  },
  {
    name: "moderation-setup",
    title: "Moderation Setup",
    framework: "any",
    prerequisites: ["A CometChat app on a plan with Moderation"],
    pages: ["/moderation/getting-started"],
    related: [
      "/moderation/rules-management",
      "/moderation/lists-management",
      "/moderation/flagged-messages",
      "/moderation/constraints-and-limits",
      "/rest-api/moderation-apis/overview",
      "/sdk/javascript/ai-moderation",
    ],
  },
  {
    name: "multi-tenant-chat",
    title: "Multi-Tenant Chat",
    framework: "any",
    prerequisites: ["Multi-tenancy enabled on your CometChat account"],
    pages: ["/fundamentals/multi-tenancy"],
    related: ["/rest-api/management-apis", "/rest-api/rbac-overview", "/rest-api/auth-tokens/create"],
  },
  {
    name: "widget-embed",
    title: "Widget Embed (No-Code)",
    framework: "widget",
    prerequisites: ["A CometChat app and a widget configured in the dashboard"],
    pages: ["/widget/html/integration"],
    related: [
      "/widget/html/advanced",
      "/widget/wordpress/integration",
      "/widget/webflow/integration",
      "/widget/squarespace/integration",
      "/widget/migration",
    ],
  },
];
