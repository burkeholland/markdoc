/**
 * Largest JSON-RPC request body `/api/mcp` reads, in bytes (#2289). The MCP SDK's own default is
 * 4 MiB, which refused a document at the tools' 2,000,000-character bound in a three-byte script
 * (CJK): that is 6,000,000 bytes of UTF-8 plus the JSON-RPC envelope. 8 MiB fits it with room to
 * spare and stays under the 10 MiB nginx `client_max_body_size` and Next's proxy body limit in front
 * of the route (server/nginx-body-limit.test.ts holds the three together).
 *
 * A client that escapes non-ASCII as `\uXXXX` sends six bytes per character; such a body can pass
 * 8 MiB below 2,000,000 characters, and gets {@link mcpBodyTooLargeMessage}.
 */
export const MCP_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

export const mcpBodyTooLargeMessage = (maxBytes = MCP_MAX_REQUEST_BODY_BYTES) =>
  `Payload Too Large: the MCP request body is over ${maxBytes.toLocaleString("en-US")} bytes (${maxBytes / (1024 * 1024)} MiB). ` +
  "Document content is limited to 2,000,000 characters and the whole JSON-RPC request to this many bytes; " +
  "send less text per call (for example several markdoc_append calls instead of one large create or replace).";
