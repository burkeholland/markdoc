import { SignJWT, jwtVerify } from "jose";
import type { Role } from "@/server/db/schema";

export interface CollabClaims {
  userId: string;
  docId: string;
  role: Role;
  name: string;
  login: string | null;
  avatar: string | null;
}

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET ?? process.env.COLLAB_SECRET;
  if (!value) throw new Error("AUTH_SECRET is not set");
  return new TextEncoder().encode(value);
}

export async function signCollabToken(claims: CollabClaims, ttlSeconds = 60 * 60): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setSubject(claims.userId)
    .setAudience("markdoc-collab")
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secret());
}

export async function verifyCollabToken(token: string): Promise<CollabClaims> {
  const { payload } = await jwtVerify(token, secret(), { audience: "markdoc-collab" });
  const claims = payload as unknown as CollabClaims;
  if (!claims.docId || !claims.userId || !claims.role) throw new Error("Invalid collaboration token");
  return claims;
}
