// RFC 9207: once the server advertises authorization_response_iss_parameter_supported,
// ChatGPT and Codex reject an authorization response without `iss`.
import { describe, expect, it } from "vitest";
import { withIssuer } from "../src/app.js";

const ISS = "https://mcp.cometchat.com/";

describe("withIssuer", () => {
  it("adds iss to code and error redirects", () => {
    expect(new URL(withIssuer("https://chatgpt.com/connector_platform_oauth_redirect?code=abc&state=s", ISS)).searchParams.get("iss")).toBe(ISS);
    expect(new URL(withIssuer("http://127.0.0.1:5555/cb?error=invalid_request&error_description=x", ISS)).searchParams.get("iss")).toBe(ISS);
    expect(new URL(withIssuer("cursor://anysphere.cursor-mcp/oauth?error=access_denied", ISS)).searchParams.get("iss")).toBe(ISS);
  });

  it("replaces an iss that isn't ours (a redirect_uri can carry one), keeps a correct one", () => {
    const planted = new URL(withIssuer("https://chatgpt.com/connector_platform_oauth_redirect?iss=https%3A%2F%2Fevil.example%2F&error=invalid_request", ISS));
    expect(planted.searchParams.getAll("iss")).toEqual([ISS]);
    const ours = "https://claude.ai/api/mcp/auth_callback?code=abc&iss=https%3A%2F%2Fmcp.cometchat.com%2F";
    expect(withIssuer(ours, ISS)).toBe(ours);
  });

  it("leaves anything that isn't an authorization response alone", () => {
    expect(withIssuer("https://mcp.cometchat.com/oauth/cometchat/disconnect", ISS)).toBe("https://mcp.cometchat.com/oauth/cometchat/disconnect");
    expect(withIssuer("/relative/path?code=1", ISS)).toBe("/relative/path?code=1");
  });
});
