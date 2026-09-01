import { SignJWT, errors as joseErrors, jwtVerify } from "jose";
import type { Role, TokenScope } from "@/server/db/schema";

export interface CollabClaims {
  userId: string;
  docId: string;
  role: Role;
  name: string;
  login: string | null;
  avatar: string | null;
  tokenId?: string;
  tokenScope?: TokenScope;
  tokenExpiresAt?: number | null;
}

export type VerifiedCollabClaims = CollabClaims & (
  | { version: 2; principal: "user"; tokenId?: never; tokenScope?: never; tokenExpiresAt?: never }
  | { version: 2; principal: "token"; tokenId: string; tokenScope: TokenScope; tokenExpiresAt?: number | null }
);

export function isVerifiedCollabClaims(claims: CollabClaims & { version?: unknown; principal?: unknown }): claims is VerifiedCollabClaims {
  return (
    claims.version === 2
    && (claims.principal === "user" || claims.principal === "token")
    && (claims.principal !== "token" || (!!claims.tokenId && !!claims.tokenScope))
    && (claims.principal !== "user" || (!claims.tokenId && !claims.tokenScope))
  );
}

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET ?? process.env.COLLAB_SECRET;
  if (!value) throw new Error("AUTH_SECRET is not set");
  return new TextEncoder().encode(value);
}

export async function signCollabToken(input: CollabClaims, ttlSeconds = 60 * 60): Promise<string> {
  if (input.tokenId && !input.tokenScope) throw new Error("Token-backed collaboration claims require a scope");
  const claims = { ...input, version: 2, principal: input.tokenId ? "token" : "user" };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setSubject(claims.userId)
    .setAudience("markdoc-collab-v2")
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secret());
}

export async function verifyCollabToken(token: string): Promise<VerifiedCollabClaims> {
  const { payload } = await jwtVerify(token, secret(), { audience: "markdoc-collab-v2" });
  const claims = payload as unknown as VerifiedCollabClaims;
  if (
    !isVerifiedCollabClaims(claims)
    || !claims.docId
    || !claims.userId
    || !claims.role
  ) {
    throw new Error("Invalid collaboration token");
  }
  return claims;
}

/**
 * The server-log line for a `verifyCollabToken` failure, by cause: an expired JWT (a tab reconnecting
 * after a release — the common case), a claim mismatch such as the audience, a signature the current
 * secret does not verify (a token minted elsewhere — the case worth noticing), a string that is not a
 * JWT at all (`JWSInvalid`/`JWTInvalid` — what the `release:verify` `collab:reject` probe sends), a
 * well-signed JWT whose claims are not collaboration claims (this module's own
 * `Invalid collaboration token` — a token minted with our secret for something else, worth noticing),
 * or anything else. Never the token, login or document. `JWTExpired` is checked first: in older jose
 * versions it is a subclass of `JWTClaimValidationFailed`.
 */
export function collabTokenFailureMessage(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return "Invalid token (expired)";
  if (err instanceof joseErrors.JWTClaimValidationFailed) return "Invalid token (claims)";
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return "Invalid token (signature)";
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) return "Invalid token (malformed)";
  if (err instanceof Error && err.message === "Invalid collaboration token") return "Invalid token (shape)";
  return "Invalid token";
}
