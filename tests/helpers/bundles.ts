import { BundleStore, type PageFetcher } from "../../src/bundles/loader.js";
import { BUNDLES } from "../../src/bundles/manifest.js";

/** A docs page as the live .md export serves it, llms.txt preamble included. */
export const stubPage = (path: string, note = "") => ({
  title: `Page ${path}`,
  url: `https://www.cometchat.com/docs${path}`,
  content:
    "> ## Documentation Index\n> Fetch the complete documentation index at: https://www.cometchat.com/docs/llms.txt\n\n" +
    `# Page ${path}\n\nInstall the kit, initialize it, log a user in and render the chat screen (${path}). ${note}\n`,
});

/** The real manifest, with pages served by `fetchPage` (default: a stub per path). */
export function stubBundleStore(fetchPage: PageFetcher = async (p) => stubPage(p)): BundleStore {
  return new BundleStore(BUNDLES, fetchPage);
}
