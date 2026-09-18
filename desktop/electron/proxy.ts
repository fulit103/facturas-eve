import http from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export interface ProxyCredentials {
  readonly username: string;
  readonly password: string;
}

export interface EveProxyOptions {
  readonly getTargetOrigin: () => string;
  readonly getCredentials: () => ProxyCredentials | null;
}

export interface EveProxy {
  readonly origin: string;
  readonly close: () => Promise<void>;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "origin",
  "referer",
  "cookie",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  // fetch() already decodes the upstream body; forwarding these would
  // make the renderer try to gunzip plaintext.
  "content-encoding",
  "content-length",
]);

export function normalizeTargetOrigin(host: string): string {
  return host.trim().replace(/\/+$/u, "");
}

export function applyCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "*");
}

export function startEveProxy(options: EveProxyOptions): Promise<EveProxy> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handleProxyRequest(req, res, options);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("No se pudo abrir el proxy local de eve."));
        return;
      }

      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.closeAllConnections();
            server.close((error) => {
              if (error) closeReject(error);
              else closeResolve();
            });
          }),
      });
    });

    server.on("error", reject);
  });
}

async function handleProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: EveProxyOptions,
): Promise<void> {
  applyCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const incoming = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!incoming.pathname.startsWith("/eve/")) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  try {
    const target = new URL(
      `${incoming.pathname}${incoming.search}`,
      `${normalizeTargetOrigin(options.getTargetOrigin())}/`,
    );
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }

    const credentials = options.getCredentials();
    if (credentials !== null && credentials.username.length > 0) {
      const token = Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString(
        "base64",
      );
      headers.set("Authorization", `Basic ${token}`);
    }
    headers.set("X-Facturas-Client", "desktop");

    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as globalThis.ReadableStream<Uint8Array>) : undefined,
      duplex: hasBody ? "half" : undefined,
      redirect: "manual",
    } as RequestInit);

    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      if (HOP_BY_HOP.has(key.toLowerCase()) || key.toLowerCase() === "access-control-allow-origin") {
        return;
      }
      res.setHeader(key, value);
    });
    applyCors(res);

    if (upstream.body === null) {
      res.end();
      return;
    }

    Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>).pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proxy error";
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end(message);
      return;
    }
    res.destroy(error instanceof Error ? error : undefined);
  }
}
