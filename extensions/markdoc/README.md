# Markdoc canvas for GitHub Copilot

Open a Markdoc document in the GitHub Copilot app's canvas panel. Requests (a comment that @-mentions the agent), mentions, comments, and reviews are pushed into the attached Copilot session. Copilot CLI loads the same extension as a push-only integration.

## Install

Copy this directory into your personal extensions directory. The extension host
provides the SDK, so there is no build or runtime install:

```sh
mkdir -p ~/.copilot/extensions/markdoc
cp -R extensions/markdoc/. ~/.copilot/extensions/markdoc/
```

Set these environment variables before launching Copilot, then start a new app
session:

```text
MARKDOC_URL
MARKDOC_TOKEN
```

`MARKDOC_URL` must be the Markdoc origin, such as `http://192.168.1.20:3000`, without a path. Create `MARKDOC_TOKEN` in **Settings -> Agents & API access** in Markdoc. The extension never prints the token.

Ask Copilot to call the `markdoc-document` canvas with a document id, or use:

```text
/markdoc open <document-id>
```

The app opens the editor in its right-side panel. In Copilot CLI, start with `copilot --experimental`; event push works there, but the CLI has no canvas panel.

The extension starts a random local shell for the panel. The shell obtains a one-time, 60-second Markdoc handoff bound to its exact origin and frames the editor; the token never appears in the panel URL or HTML. Markdoc uses a short-lived, document-scoped embed cookie without replacing the user's normal login, renews it while the editor stays open, and prevents any other origin from framing the session. The shell obtains a fresh handoff before expiry if in-frame renewal is interrupted. For plain HTTP, `MARKDOC_URL` must resolve to this machine so the shell can use the same hostname and keep the cookie same-site. Remote Markdoc servers must use HTTPS. One Markdoc canvas is active per Copilot session; a second panel is refused so document-scoped sessions cannot collide. Reuse the existing panel with `open_document`, or close it before opening another.

The extension sends each request, mention, comment, and review event once. A
comment that @-mentions the agent produces a comment, a mention and a request
for the same thread; the extension waits briefly for the request and pushes
only that one, so one ask is one prompt. An
event arriving during a Copilot turn is queued; an event arriving while the
session is idle starts a turn immediately. Closing the canvas aborts the event
poll and removes the Copilot app presence from the document. Event-driven turns
are restricted to the Markdoc tools they need; shell, filesystem, browser, and
other global tools are unavailable.
