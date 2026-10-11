/**
 * The HTTP server of the order API: the one place where the handler is put behind HTTP.
 *
 * Both the entry point (`main.ts`) and the contract tests call `assembleServer`. That is what
 * makes a fixture a record of what the deployed API answers: a test that built its own server
 * around the handler, or called the handler directly, would record the answers of something
 * that is never deployed. What only this layer does (the answer to a body that is not JSON,
 * the `content-type` of every JSON answer) can be in a fixture because the tests come through
 * it: see `order.body-not-json` in the contracts of the web client.
 */
import http from "node:http";

import { createApp, type HttpResponse } from "./orders.js";

function send(res: http.ServerResponse, response: HttpResponse): void {
  const text = response.body === undefined ? "" : JSON.stringify(response.body);
  const headers: Record<string, string> = text === "" ? {} : { "content-type": "application/json" };
  for (const [name, value] of Object.entries(response.headers ?? {})) headers[name.toLowerCase()] = value;
  res.writeHead(response.status, headers);
  res.end(text);
}

export function assembleServer(options: Parameters<typeof createApp>[0]): http.Server {
  const app = createApp(options);
  return new http.Server((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      if (text !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          send(res, { status: 400, body: { error: "body_not_json" } });
          return;
        }
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers[name] = [value].flat().join(", ");
      }
      send(res, app.handle({ method: req.method ?? "GET", path: req.url ?? "/", headers, body }));
    });
  });
}
