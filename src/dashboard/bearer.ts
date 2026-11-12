// Bearer-token check for /mcp/dashboard. Same behaviour as the MCP SDK's
// requireBearerAuth, except that the scope a 401/403 advertises is separate
// from the scope a token must have.
//
// The SDK writes `requiredScopes` into WWW-Authenticate, and SDK clients ask
// for exactly the scope in that header (SEP-835) before looking at
// scopes_supported. Requiring dashboard:read there made every spec-following
// client (Claude Code, Claude Desktop) ask for read only. This advertises read +
// write, so clients ask for both by default, while a token with only
// dashboard:read (an explicit read-only grant) is still accepted.
import type { NextFunction, Request, Response } from "express";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { InsufficientScopeError, InvalidTokenError, OAuthError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Set once the bearer token is verified (as the SDK's own bearer middleware does). */
    auth?: AuthInfo;
  }
}

export interface DashboardBearerOptions {
  verifier: OAuthTokenVerifier;
  /** Every one of these must be on the token. */
  requiredScopes: string[];
  /** What the WWW-Authenticate challenge asks clients to request. */
  advertisedScopes: string[];
  resourceMetadataUrl: string;
}

export function dashboardBearer(opts: DashboardBearerOptions) {
  const challenge = (errorCode: string, message: string) =>
    `Bearer error="${errorCode}", error_description="${message}", scope="${opts.advertisedScopes.join(" ")}", resource_metadata="${opts.resourceMetadataUrl}"`;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.headers.authorization;
      if (!header) throw new InvalidTokenError("Missing Authorization header");
      const [type, token] = header.split(" ");
      if (type?.toLowerCase() !== "bearer" || !token) throw new InvalidTokenError("Invalid Authorization header format, expected 'Bearer TOKEN'");
      const auth = await opts.verifier.verifyAccessToken(token);
      if (!opts.requiredScopes.every((s) => auth.scopes.includes(s))) throw new InsufficientScopeError("Insufficient scope");
      if (typeof auth.expiresAt !== "number" || Number.isNaN(auth.expiresAt)) throw new InvalidTokenError("Token has no expiration time");
      if (auth.expiresAt < Date.now() / 1000) throw new InvalidTokenError("Token has expired");
      req.auth = auth;
      next();
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        res.set("WWW-Authenticate", challenge(err.errorCode, err.message)).status(401).json(err.toResponseObject());
      } else if (err instanceof InsufficientScopeError) {
        res.set("WWW-Authenticate", challenge(err.errorCode, err.message)).status(403).json(err.toResponseObject());
      } else if (err instanceof ServerError) {
        res.status(500).json(err.toResponseObject());
      } else if (err instanceof OAuthError) {
        res.status(400).json(err.toResponseObject());
      } else {
        res.status(500).json(new ServerError("Internal Server Error").toResponseObject());
      }
    }
  };
}
