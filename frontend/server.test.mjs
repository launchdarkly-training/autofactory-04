import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  BACKEND_STATUS_FLAG,
  createApp,
  flagVariation,
  ldContext,
  parseClientEvent,
} from "./server.mjs";

/** A fake LD client that records evaluations and emitted events. */
function fakeClient(value) {
  const calls = [];
  const events = [];
  return {
    calls,
    events,
    variation(key, context, fallback) {
      calls.push({ key, context, fallback });
      return value;
    },
    track(eventKey, context, data, metricValue) {
      events.push({ eventKey, context, metricValue });
    },
  };
}

const servers = [];

async function boot(ldClient) {
  const app = createApp({ ldClient });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

const getPage = async (ldClient) => (await fetch(`${await boot(ldClient)}/`)).text();

async function postBeacon(base, body) {
  const res = await fetch(`${base}/api/client-events`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
  });
  // The handler responds before tracking, so give the event loop a tick.
  await new Promise((r) => setTimeout(r, 20));
  return res.status;
}

after(async () => {
  await Promise.all(
    servers.map((s) => new Promise((r) => s.close(r))),
  );
});

const STATUS_ELEMENT = `<p id="backend-status">Checking backend status…</p>`;

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

/**
 * The page exactly as the PR's base commit rendered it. Pinned literally so a
 * change that leaks treatment markup into the control path cannot hide behind
 * a control-vs-control comparison.
 */
const BASE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>${SHA}</code></p>
  <p id="greeting">Loading greeting from backend…</p>
  <script>
    fetch("${BACKEND_URL}/api/greeting")
      .then(r => r.json())
      .then(d => { document.getElementById("greeting").textContent =
        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })
      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });
  </script>
</body></html>`;

describe("control path (flag off / control variation)", () => {
  it("renders the base commit's page byte-for-byte", async () => {
    assert.equal(await getPage(fakeClient("control")), BASE_PAGE);
  });

  it("renders no backend-status element", async () => {
    const html = await getPage(fakeClient("control"));
    assert.ok(!html.includes(STATUS_ELEMENT));
    assert.ok(!html.includes("backend-status"));
  });

  it("does not fetch the backend status endpoint", async () => {
    const html = await getPage(fakeClient("control"));
    assert.ok(!html.includes("/api/status"));
    assert.ok(html.includes("/api/greeting"), "greeting fetch is preserved");
  });

  it("does not emit the outcome beacon", async () => {
    const html = await getPage(fakeClient("control"));
    assert.ok(!html.includes("sendBeacon"));
    assert.ok(!html.includes("reportBackendStatus"));
  });

  it("evaluates the flag with the right key, context and control fallback", async () => {
    const client = fakeClient("control");
    await getPage(client);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].key, BACKEND_STATUS_FLAG);
    assert.equal(client.calls[0].key, "enable-backend-status");
    assert.equal(client.calls[0].fallback, "control");
    assert.deepEqual(client.calls[0].context, { kind: "user", key: "demo-user" });
  });
});

describe("control path is preserved under every fail-safe route", () => {
  it("renders control when there is no LD client at all", async () => {
    assert.equal(await getPage(null), BASE_PAGE);
  });

  it("renders control when the SDK throws", async () => {
    const thrower = {
      variation() {
        throw new Error("sdk exploded");
      },
      track() {},
    };
    assert.equal(await getPage(thrower), BASE_PAGE);
  });

  it("renders control when the flag value is not a string", async () => {
    assert.equal(await getPage(fakeClient(true)), BASE_PAGE);
    assert.equal(await getPage(fakeClient(1)), BASE_PAGE);
  });

  it("renders control for an unknown future variation", async () => {
    assert.equal(await getPage(fakeClient("v2")), BASE_PAGE);
  });

  it("flagVariation itself degrades to the control string", () => {
    assert.equal(flagVariation(null, BACKEND_STATUS_FLAG), "control");
    assert.equal(flagVariation(fakeClient(true), BACKEND_STATUS_FLAG), "control");
    assert.equal(flagVariation(fakeClient(undefined), BACKEND_STATUS_FLAG), "control");
    assert.equal(
      flagVariation(
        {
          variation() {
            throw new Error("nope");
          },
        },
        BACKEND_STATUS_FLAG,
      ),
      "control",
    );
  });

  it("is not reachable through a truthy coercion of the variation value", () => {
    // Guards the boolean-helper trap: "control" is truthy, so any boolean
    // reading of the variation would wrongly take the treatment path.
    assert.ok(Boolean("control"), "control is truthy");
    assert.equal(flagVariation(fakeClient("control"), BACKEND_STATUS_FLAG), "control");
  });
});

describe("v1 path (treatment variation)", () => {
  it("renders the backend-status element", async () => {
    const html = await getPage(fakeClient("v1"));
    assert.ok(html.includes(STATUS_ELEMENT));
  });

  it("fetches the backend status endpoint and renders both outcomes", async () => {
    const html = await getPage(fakeClient("v1"));
    assert.ok(html.includes("/api/status"));
    assert.ok(html.includes("Backend online: "));
    assert.ok(html.includes("Backend offline"));
  });

  it("keeps the pre-existing greeting behavior intact", async () => {
    const html = await getPage(fakeClient("v1"));
    assert.ok(html.includes("/api/greeting"));
    assert.ok(html.includes("backend unavailable"));
  });

  it("wires the outcome beacon for both branches", async () => {
    const html = await getPage(fakeClient("v1"));
    assert.ok(html.includes(`navigator.sendBeacon("/api/client-events"`));
    assert.ok(html.includes(`reportBackendStatus("ok")`));
    assert.ok(html.includes(`reportBackendStatus("error")`));
  });
});

describe("the /api/status contract is untouched by the flag", () => {
  for (const variation of ["control", "v1"]) {
    it(`still serves { service, version } under ${variation}`, async () => {
      const base = await boot(fakeClient(variation));
      const body = await (await fetch(`${base}/api/status`)).json();
      assert.deepEqual(body, { service: "demo-frontend", version: "dev" });
    });
  }
});

describe("latency metric is two-armed", () => {
  for (const variation of ["control", "v1"]) {
    it(`emits enable-backend-status-latency under ${variation}`, async () => {
      const client = fakeClient(variation);
      await getPage(client);
      const latency = client.events.filter(
        (e) => e.eventKey === "enable-backend-status-latency",
      );
      assert.equal(latency.length, 1, "exactly one latency event per render");
      assert.equal(typeof latency[0].metricValue, "number");
      assert.ok(
        Number.isFinite(latency[0].metricValue) && latency[0].metricValue >= 0,
        `expected a finite non-negative duration, got ${latency[0].metricValue}`,
      );
      assert.deepEqual(latency[0].context, ldContext());
    });
  }
});

describe("outcome beacon feeds the error and success metrics", () => {
  it("maps outcome=ok to the success event only", async () => {
    const client = fakeClient("v1");
    const base = await boot(client);
    assert.equal(await postBeacon(base, JSON.stringify({ outcome: "ok" })), 204);
    const keys = client.events.map((e) => e.eventKey);
    assert.ok(keys.includes("enable-backend-status-success"));
    assert.ok(!keys.includes("enable-backend-status-error"));
  });

  it("maps outcome=error to the error event only", async () => {
    const client = fakeClient("v1");
    const base = await boot(client);
    assert.equal(
      await postBeacon(base, JSON.stringify({ outcome: "error" })),
      204,
    );
    const keys = client.events.map((e) => e.eventKey);
    assert.ok(keys.includes("enable-backend-status-error"));
    assert.ok(!keys.includes("enable-backend-status-success"));
  });

  it("emits the occurrence events with no metric value", async () => {
    const client = fakeClient("v1");
    const base = await boot(client);
    await postBeacon(base, JSON.stringify({ outcome: "ok" }));
    const success = client.events.find(
      (e) => e.eventKey === "enable-backend-status-success",
    );
    assert.equal(success.metricValue, undefined);
    assert.deepEqual(success.context, ldContext());
  });

  // A beacon payload the server does not understand must not be counted into
  // either arm: the error metric is the release killswitch.
  for (const [label, body] of [
    ["malformed JSON", "not json"],
    ["an unrecognized outcome", JSON.stringify({ outcome: "bogus" })],
    ["a missing outcome", JSON.stringify({ ok: true })],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
    ["an empty body", ""],
  ]) {
    it(`drops ${label} without emitting any event`, async () => {
      const client = fakeClient("v1");
      const base = await boot(client);
      assert.equal(await postBeacon(base, body), 204);
      assert.deepEqual(client.events, [], `${label} emitted ${JSON.stringify(client.events)}`);
    });
  }

  it("still answers 204 when tracking throws", async () => {
    const base = await boot({
      variation: () => "v1",
      track() {
        throw new Error("event pipeline down");
      },
    });
    assert.equal(await postBeacon(base, JSON.stringify({ outcome: "ok" })), 204);
  });
});

describe("parseClientEvent", () => {
  it("accepts only the two recognized outcomes", () => {
    assert.deepEqual(parseClientEvent('{"outcome":"ok"}'), { outcome: "ok" });
    assert.deepEqual(parseClientEvent('{"outcome":"error"}'), {
      outcome: "error",
    });
  });

  it("rejects everything else", () => {
    for (const bad of [
      "",
      "not json",
      "null",
      "[]",
      '"ok"',
      "{}",
      '{"outcome":"OK"}',
      '{"outcome":true}',
      undefined,
      null,
    ]) {
      assert.equal(
        parseClientEvent(bad),
        null,
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
  });
});
