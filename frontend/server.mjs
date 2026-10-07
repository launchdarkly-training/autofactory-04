/**
 * Demo frontend (Node / Express). Serves a tiny page and the status contract.
 *   GET /api/status        -> { service, version }   (version = deployed SHA)
 *   GET /                  -> a page that fetches the backend greeting
 *   POST /api/client-events -> browser outcome beacon, forwarded to LaunchDarkly
 *
 * The backend-status line on the page is gated by the string multivariate flag
 * "enable-backend-status": "control" renders the page exactly as before, "v1"
 * also renders the status line and fetches the backend's /api/status.
 */

import express from "express";
import { pathToFileURL } from "node:url";

import { init as initLd } from "@launchdarkly/node-server-sdk";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";
const LD_SDK_KEY = process.env.LD_SDK_KEY;

export const BACKEND_STATUS_FLAG = "enable-backend-status";

/** The evaluation context, matching the backend's hardcoded demo user. */
export function ldContext() {
  return { kind: "user", key: "demo-user" };
}

/**
 * Read a string variation, failing safe to "control" so that a missing client,
 * an absent flag, a non-string value or a throwing SDK all keep the existing
 * behavior. Never routed through a boolean helper: every non-empty string is
 * truthy, which would make the control path unreachable.
 */
export function flagVariation(ldClient, key, context = ldContext()) {
  if (!ldClient) return "control";
  try {
    const value = ldClient.variation(key, context, "control");
    return typeof value === "string" ? value : "control";
  } catch (err) {
    console.warn(`flag evaluation failed for ${key}: ${err.message}`);
    return "control";
  }
}

/** Emit a custom event. A telemetry failure must never fail the request. */
function track(ldClient, eventKey, context, metricValue) {
  if (!ldClient) return;
  try {
    ldClient.track(eventKey, context, undefined, metricValue);
  } catch (err) {
    console.warn(`track failed for ${eventKey}: ${err.message}`);
  }
}

/**
 * Parse a `navigator.sendBeacon` body. The browser posts a Blob with whatever
 * content type it likes, so the body arrives as raw text and may be malformed
 * or empty. Returns the recognized outcome, or null to drop the report —
 * an unrecognized payload must never be counted as either arm of a metric.
 */
export function parseClientEvent(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  if (parsed.outcome !== "ok" && parsed.outcome !== "error") return null;
  return { outcome: parsed.outcome };
}

function renderPage({ showBackendStatus }) {
  const bodyLines = [
    `  <h1>LaunchDarkly Auto-Factory — Demo</h1>`,
    `  <p>Frontend deployed SHA: <code>${SHA}</code></p>`,
    `  <p id="greeting">Loading greeting from backend…</p>`,
  ];
  const scriptLines = [
    `    fetch("${BACKEND_URL}/api/greeting")`,
    `      .then(r => r.json())`,
    `      .then(d => { document.getElementById("greeting").textContent =`,
    `        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })`,
    `      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });`,
  ];

  if (showBackendStatus) {
    bodyLines.push(`  <p id="backend-status">Checking backend status…</p>`);
    scriptLines.push(
      `    function reportBackendStatus(outcome) {`,
      `      try { navigator.sendBeacon("/api/client-events", JSON.stringify({ outcome: outcome })); } catch (e) {}`,
      `    }`,
      `    fetch("${BACKEND_URL}/api/status")`,
      `      .then(r => r.json())`,
      `      .then(d => { document.getElementById("backend-status").textContent =`,
      `        "Backend online: " + d.service + " version " + d.version;`,
      `        reportBackendStatus("ok"); })`,
      `      .catch(() => { document.getElementById("backend-status").textContent = "Backend offline";`,
      `        reportBackendStatus("error"); });`,
    );
  }

  return [
    `<!doctype html>`,
    `<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>`,
    `<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">`,
    ...bodyLines,
    `  <script>`,
    ...scriptLines,
    `  </script>`,
    `</body></html>`,
  ].join("\n");
}

export function createApp({ ldClient = null } = {}) {
  const app = express();

  app.get("/api/status", (_req, res) => {
    res.json({ service: "demo-frontend", version: SHA });
  });

  app.get("/", (_req, res) => {
    const startedAt = performance.now();
    const context = ldContext();
    const showBackendStatus =
      flagVariation(ldClient, BACKEND_STATUS_FLAG, context) === "v1";

    res.type("html").send(renderPage({ showBackendStatus }));

    // Emitted on BOTH variations so the guarded release has a real two-armed
    // latency comparison rather than a one-armed treatment-only sample.
    track(
      ldClient,
      "enable-backend-status-latency",
      context,
      performance.now() - startedAt,
    );
  });

  // Outcome beacon for the v1 status check, which runs in the browser where the
  // Node server SDK cannot observe it. The control page never posts here.
  app.post(
    "/api/client-events",
    express.text({ type: "*/*", limit: "1kb" }),
    (req, res) => {
      res.status(204).end();
      const event = parseClientEvent(req.body);
      if (!event) return;
      const context = ldContext();
      if (event.outcome === "ok") {
        track(ldClient, "enable-backend-status-success", context);
      } else {
        track(ldClient, "enable-backend-status-error", context);
      }
    },
  );

  return app;
}

export async function initLdClient() {
  if (!LD_SDK_KEY) return null;
  const client = initLd(LD_SDK_KEY);
  try {
    await client.waitForInitialization({ timeout: 5 });
    return client;
  } catch (err) {
    console.warn(`LaunchDarkly unavailable (${err.message}); serving control.`);
    await client.close();
    return null;
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (import.meta.url === entryPoint) {
  const ldClient = await initLdClient();
  const port = process.env.PORT || 3000;
  createApp({ ldClient }).listen(port, () =>
    console.log(`demo-frontend on :${port}`),
  );
}
