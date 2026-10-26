import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8")) as {
  mcpServers: Record<string, { type?: string; url?: string; command?: string }>;
};
const SERVER_URL = "https://mcp.cometchat.com/mcp";

// From v0.1.3 to v0.1.6 the Claude Code plugin shipped a url with no type.
// Claude Code reads an entry without one as a stdio server, finds no command,
// logs "Invalid MCP server config" and registers nothing, so the plugin had no
// working server for four releases. Pin the transport on every manifest that
// Claude Code reads.
describe("plugin manifests", () => {
  it.each([".mcp.json", "mcp.json"])("%s declares every remote server as http", (file) => {
    const servers = Object.entries(read(file).mcpServers);
    expect(servers.length).toBeGreaterThan(0);
    for (const [name, server] of servers) {
      expect(server.url, `${file}: ${name} has no url`).toBe(SERVER_URL);
      expect(server.type, `${file}: ${name} has no "type": "http"`).toBe("http");
      expect(server.command, `${file}: ${name} is not a stdio server`).toBeUndefined();
    }
  });

  // Cursor and Codex infer the transport from `url` and do not take a type;
  // they only need to point at the same server.
  it.each([".cursor-plugin/plugin.json", ".codex-plugin/plugin.json"])("%s points at the hosted server", (file) => {
    const servers = Object.values(read(file).mcpServers);
    expect(servers.length).toBeGreaterThan(0);
    for (const server of servers) expect(server.url).toBe(SERVER_URL);
  });
});
