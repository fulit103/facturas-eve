import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startEveProxy, type EveProxy } from "../desktop/electron/proxy";

describe("desktop eve proxy", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("forwards /eve paths, strips Origin, and injects Basic auth", async () => {
    const seen: {
      authorization?: string;
      origin?: string;
      path?: string;
      desktopClient?: string;
    } = {};

    const upstream = createServer((req, res) => {
      seen.authorization = req.headers.authorization;
      seen.origin = req.headers.origin;
      seen.path = req.url;
      seen.desktopClient = req.headers["x-facturas-client"] as string | undefined;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, status: "ready", workflowId: "wf_test" }));
    });

    await listen(upstream);
    const address = upstream.address();
    if (address === null || typeof address === "string") {
      throw new Error("upstream bind failed");
    }
    servers.push({
      close: () =>
        new Promise((resolve, reject) => {
          upstream.close((error) => (error ? reject(error) : resolve()));
        }),
    });

    const proxy: EveProxy = await startEveProxy({
      getTargetOrigin: () => `http://127.0.0.1:${address.port}`,
      getCredentials: () => ({ username: "demo", password: "secret" }),
    });
    servers.push(proxy);

    const response = await fetch(`${proxy.origin}/eve/v1/health`, {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(response.ok).toBe(true);
    expect(seen.path).toBe("/eve/v1/health");
    expect(seen.origin).toBeUndefined();
    expect(seen.desktopClient).toBe("desktop");
    expect(seen.authorization).toBe(`Basic ${Buffer.from("demo:secret").toString("base64")}`);
    expect(response.headers.get("content-encoding")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "ready" });
  });

  it("streams NDJSON without buffering the full body", async () => {
    const upstream = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write('{"type":"session.created"}\n');
      setTimeout(() => {
        res.write('{"type":"turn.completed"}\n');
        res.end();
      }, 15);
    });

    await listen(upstream);
    const address = upstream.address();
    if (address === null || typeof address === "string") {
      throw new Error("upstream bind failed");
    }
    servers.push({
      close: () =>
        new Promise((resolve, reject) => {
          upstream.close((error) => (error ? reject(error) : resolve()));
        }),
    });

    const proxy = await startEveProxy({
      getTargetOrigin: () => `http://127.0.0.1:${address.port}`,
      getCredentials: () => null,
    });
    servers.push(proxy);

    const response = await fetch(`${proxy.origin}/eve/v1/session`);
    expect(response.ok).toBe(true);
    const text = await response.text();
    expect(text).toContain("session.created");
    expect(text).toContain("turn.completed");
  });

  it("rejects paths outside /eve/", async () => {
    const proxy = await startEveProxy({
      getTargetOrigin: () => "http://127.0.0.1:9",
      getCredentials: () => null,
    });
    servers.push(proxy);

    const response = await fetch(`${proxy.origin}/not-eve`);
    expect(response.status).toBe(404);
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
}
