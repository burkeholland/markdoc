/** Share keys identify the recipient; access-request keys identify the requester. */
export function notificationLoginRefId(resourceId: string, login: string): string {
  return `${resourceId}:${login.toLowerCase()}`;
}
