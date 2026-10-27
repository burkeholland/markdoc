import { clearAllLocalDocuments, hasLocalDocuments } from "@/editor/collab/offline";
import { navigateTo } from "@/lib/nav";

export const SIGN_OUT_WARNING =
  "Sign out and remove offline document copies from this device?\n\nAny changes that have not finished syncing will be permanently lost. Select Cancel to stay signed in.";

export const SIGN_OUT_CLEANUP_ERROR =
  "Could not sign out because offline document copies could not be removed. You are still signed in, and this tab will keep storing your edits offline. Close other Markdoc tabs and try again.";

let inFlight: Promise<boolean> | null = null;

/**
 * The single client-side account-boundary flow. Auth.js is reached only after every local
 * document mirror and its registry have been removed.
 */
export function signOutSafely(callbackUrl?: string): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      if ((await hasLocalDocuments()) && !window.confirm(SIGN_OUT_WARNING)) return false;
      await clearAllLocalDocuments();
      navigateTo(callbackUrl ? `/api/auth/signout?callbackUrl=${encodeURIComponent(callbackUrl)}` : "/api/auth/signout");
      return true;
    } catch (error) {
      console.error("[markdoc] sign-out cleanup failed", error);
      window.alert(SIGN_OUT_CLEANUP_ERROR);
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
