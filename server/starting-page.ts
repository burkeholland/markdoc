import type { IncomingMessage, ServerResponse } from "node:http";

const STARTUP_RETRY_SECONDS = 2;

const STARTUP_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="${STARTUP_RETRY_SECONDS}">
  <meta name="color-scheme" content="light dark">
  <title>Starting Markdoc</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1c1917;
      background: #fcfbf7;
    }

    * {
      box-sizing: border-box;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        color: #e7e5e4;
        background: #14161a;
      }
    }

    body {
      display: grid;
      min-height: 100vh;
      margin: 0;
      padding: 24px;
      place-items: center;
    }

    main {
      width: min(100%, 28rem);
      text-align: center;
    }

    .brand-mark {
      display: grid;
      width: 2.75rem;
      aspect-ratio: 1;
      margin: 0 auto 1.5rem;
      border-radius: 0.875rem;
      background: #e6f4f1;
      color: #0f766e;
      font-size: 1.25rem;
      font-weight: 700;
      place-items: center;
    }

    h1 {
      margin: 0;
      font-size: 1.5rem;
      font-weight: 600;
      letter-spacing: -0.03em;
    }

    p {
      margin: 0.75rem 0 0;
      color: #57534e;
      line-height: 1.5;
    }

    .spinner {
      width: 1.25rem;
      height: 1.25rem;
      margin: 1.5rem auto 0;
      border: 2px solid #d6d3d1;
      border-top-color: #0f766e;
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }

    @media (prefers-color-scheme: dark) {
      .brand-mark {
        background: rgb(45 212 191 / 16%);
        color: #2dd4bf;
      }

      p {
        color: #a8a29e;
      }

      .spinner {
        border-color: #3a3d43;
        border-top-color: #2dd4bf;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .spinner {
        animation: none;
      }
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
  </style>
</head>
<body>
  <main>
    <div class="brand-mark" aria-hidden="true">M</div>
    <h1>Markdoc is getting ready</h1>
    <p role="status">This page will refresh automatically.</p>
    <div class="spinner" aria-hidden="true"></div>
  </main>
</body>
</html>`;

export function sendStartingResponse(req: Pick<IncomingMessage, "method" | "headers">, res: ServerResponse): void {
  res.statusCode = 503;
  if (req.method === "GET" && req.headers.accept?.toLowerCase().includes("text/html")) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Retry-After", String(STARTUP_RETRY_SECONDS));
    res.end(STARTUP_PAGE);
    return;
  }
  res.end("starting");
}
