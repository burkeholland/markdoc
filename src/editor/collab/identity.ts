export const ANONYMOUS_USER_ID_PREFIX = "anonymous";

export function createAnonymousUserId(): string {
  return `${ANONYMOUS_USER_ID_PREFIX}-${crypto.randomUUID()}`;
}

export function isSameAccount(localUserId: string, remoteUserId: unknown): boolean {
  return localUserId !== ANONYMOUS_USER_ID_PREFIX && remoteUserId === localUserId;
}
