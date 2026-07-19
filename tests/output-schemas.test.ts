import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import Ajv from "ajv";
import { SEARCH_TOOL_DEFINITION, runSearch } from "../src/tools/search.js";
import { FETCH_TOOL_DEFINITION, runFetch } from "../src/tools/fetch.js";
import { BUNDLE_TOOL_DEFINITION, runBundle } from "../src/tools/bundle.js";
import { LIST_BUNDLES_TOOL_DEFINITION, runListBundles } from "../src/tools/list-bundles.js";
import { SqliteSearchClient } from "../src/search/sqlite.js";
import { BundleStore } from "../src/bundles/loader.js";

// Every run* return value must conform to its declared outputSchema: SDK
// clients validate structuredContent against the schema and throw on
// mismatch, and additionalProperties:false makes silent drift a total tool
// outage for validating clients. This suite is the server-side guard.

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlesDir = path.resolve(here, "../bundles");

const ajv = new Ajv({ strict: false });

function assertConforms(schema: object, value: unknown, label: string) {
  const validate = ajv.compile(schema);
  const ok = validate(value);
  if (!ok) {
    throw new Error(`${label} does not conform to its outputSchema: ${JSON.stringify(validate.errors, null, 2)}`);
  }
  expect(ok).toBe(true);
}

describe("tool outputs conform to declared outputSchema", () => {
  let tmpDir: string;
  let searchClient: SqliteSearchClient;
  let store: BundleStore;
  let httpServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "schema-test-"));
    const indexPath = path.join(tmpDir, "index.sqlite");
    const db = new Database(indexPath);
    db.exec(`
      CREATE TABLE pages (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        section TEXT NOT NULL,
        version TEXT,
        body TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE pages_fts USING fts5(
        title, body, section, version,
        content='pages', content_rowid='id', tokenize='porter unicode61'
      );
      CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
        INSERT INTO pages_fts(rowid, title, body, section, version)
        VALUES (new.id, new.title, new.body, new.section, COALESCE(new.version, ''));
      END;
    `);
    db.prepare(
      "INSERT INTO pages (path, url, title, section, version, body) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("/x", "https://example.com/x", "Presence indicators", "sdk", null, "Presence indicators and typing events for chat apps.");
    db.close();
    searchClient = new SqliteSearchClient(indexPath);
    store = await BundleStore.load(bundlesDir);

    httpServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end("# Fixture Page\n\nMarkdown body for schema conformance testing.\n");
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    searchClient.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("search_cometchat_docs", async () => {
    const result = await runSearch({ query: "presence indicators" }, searchClient);
    assertConforms(SEARCH_TOOL_DEFINITION.outputSchema, result, "runSearch");
  });

  it("fetch_cometchat_doc_page", async () => {
    const result = await runFetch({ path: "/fixture" }, { docsBaseUrl: baseUrl, timeoutMs: 2000 });
    assertConforms(FETCH_TOOL_DEFINITION.outputSchema, result, "runFetch");
  });

  it("get_cometchat_implementation_bundle", () => {
    const result = runBundle({ bundle: "react-uikit-quickstart" }, store);
    assertConforms(BUNDLE_TOOL_DEFINITION.outputSchema, result, "runBundle");
  });

  it("list_cometchat_bundles", () => {
    const result = runListBundles(store);
    assertConforms(LIST_BUNDLES_TOOL_DEFINITION.outputSchema, result, "runListBundles");
  });
});
