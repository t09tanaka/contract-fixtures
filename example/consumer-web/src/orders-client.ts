/**
 * The web client of the tiny order API. It calls `fetch`, builds its requests and decodes
 * the responses itself; the contract tests run exactly this code and only put another
 * function in the place of `fetch`.
 */

export type PlaceOrderOutcome =
  | { kind: "placed"; id: string; totalMinor: number }
  | { kind: "out-of-stock"; available: number }
  | { kind: "sign-in-again" }
  | { kind: "failed" };

export type ReceiptOutcome =
  | { kind: "ready"; fileName: string; totalMinor: number }
  | { kind: "sign-in-again" }
  | { kind: "failed" };

export interface OrdersClientOptions {
  /** For example `https://api.example.test`. */
  baseUrl: string;
  /** The value of the `authorization` header. */
  authorization: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const ATTACHMENT = /^attachment;\s*filename="([^"/\\]+)"$/;

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => undefined);
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function createOrdersClient(options: OrdersClientOptions) {
  const call = options.fetch ?? fetch;
  const headers = { authorization: options.authorization, accept: "application/json" };

  return {
    async placeOrder(sku: string, quantity: number): Promise<PlaceOrderOutcome> {
      const response = await call(`${options.baseUrl}/orders`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ sku, quantity }),
      });
      if (response.status === 401) return { kind: "sign-in-again" };
      const json = await jsonOf(response);
      if (response.status === 201 && typeof json.id === "string" && typeof json.total_minor === "number") {
        return { kind: "placed", id: json.id, totalMinor: json.total_minor };
      }
      if (json.error === "out_of_stock" && typeof json.available === "number") {
        return { kind: "out-of-stock", available: json.available };
      }
      return { kind: "failed" };
    },

    async downloadReceipt(orderId: string): Promise<ReceiptOutcome> {
      const response = await call(`${options.baseUrl}/orders/${encodeURIComponent(orderId)}/receipt`, { headers });
      if (response.status === 401) return { kind: "sign-in-again" };
      const fileName = ATTACHMENT.exec(response.headers.get("content-disposition") ?? "")?.[1];
      const json = await jsonOf(response);
      if (
        response.status !== 200 ||
        fileName === undefined ||
        // Deliberately strict: the example API sends exactly this value.
        response.headers.get("content-type") !== "application/json" ||
        typeof json.total_minor !== "number"
      ) {
        return { kind: "failed" };
      }
      return { kind: "ready", fileName, totalMinor: json.total_minor };
    },
  };
}
