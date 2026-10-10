/**
 * What the sign-in page says after a sign-in that failed. Auth.js sends the browser back here with its
 * error type in `?error=`. Whatever it does not consider safe to show (a refused identity, a database
 * or provider failure, a wrong setting) arrives as `Configuration`; the cause is in the server log
 * under `[auth][error]`.
 */
export function signInErrorMessage(error: string): string {
  switch (error) {
    case "AccessDenied":
    case "OAuthCallbackError":
      return "The GitHub sign-in was cancelled or did not finish. Please try again.";
    case "CredentialsSignin":
      return "That development login was not accepted. Enter a GitHub handle and try again.";
    default:
      return "Sign-in could not be completed because of a problem on our side. Please try again later.";
  }
}
