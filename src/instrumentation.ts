/**
 * Next.js server start hook. The webhook dispatcher must run in this module graph (it reads live documents),
 * while the custom server's collaboration hooks only wake it; start it once the Node runtime is up.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startWebhookDispatcher } = await import("@/server/webhooks");
  startWebhookDispatcher();
}
