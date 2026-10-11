/**
 * A tiny order API, small enough to read in one sitting. It has no HTTP server: `handle`
 * is the function a server would call, which is also what the contract tests call.
 */
import { randomBytes } from "node:crypto";

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

interface Product {
  unitPriceMinor: number;
  stock: number;
}

const PRODUCTS: Record<string, Product> = {
  "tea-100": { unitPriceMinor: 600, stock: 40 },
  "mug-200": { unitPriceMinor: 1250, stock: 0 },
  "tin-300": { unitPriceMinor: 999, stock: 5 },
};

const COUPONS: Record<string, number> = { SAVE10: 10, HALF: 50 };

/** Total in minor units. The discount is rounded half up before it is subtracted. */
export function orderTotalMinor(
  unitPriceMinor: number,
  quantity: number,
  discountPercent: number,
): number {
  const subtotal = unitPriceMinor * quantity;
  const discount = Math.floor((subtotal * discountPercent + 50) / 100);
  return subtotal - discount;
}

export interface App {
  handle(request: HttpRequest): HttpResponse;
}

export function createApp(options: {
  /** Bearer token -> customer id. */
  tokens: Record<string, string>;
  now?: () => Date;
}): App {
  const now = options.now ?? (() => new Date());
  let sequence = 0;

  return {
    handle(request) {
      const receiptOf = /^\/orders\/([a-z0-9_]+)\/receipt$/.exec(request.path)?.[1];
      const known =
        receiptOf === undefined
          ? request.method === "POST" && (request.path === "/orders" || request.path === "/payments")
          : request.method === "GET";
      if (!known) {
        return { status: 404, body: { error: "not_found" } };
      }
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
      const customer = token === undefined ? undefined : options.tokens[token];
      if (customer === undefined) {
        return { status: 401, body: { error: "token_invalid" } };
      }

      if (receiptOf !== undefined) {
        // The example keeps no orders: every receipt is for two packs of tea.
        const line = { sku: "tea-100", quantity: 2 };
        return {
          status: 200,
          // Part of the agreement: the client saves the receipt under this file name.
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="receipt-${receiptOf}.json"`,
            "Cache-Control": "private, no-store",
          },
          body: {
            order_id: receiptOf,
            lines: [line],
            total_minor: orderTotalMinor(PRODUCTS[line.sku]!.unitPriceMinor, line.quantity, 0),
          },
        };
      }

      if (request.path === "/payments") {
        const orderId = ((request.body ?? {}) as { order_id?: unknown }).order_id;
        if (typeof orderId !== "string") {
          return { status: 422, body: { error: "invalid_request", field: "order_id" } };
        }
        sequence += 1;
        return {
          status: 201,
          body: {
            id: `pay_${Date.now().toString(36)}${sequence}`,
            order_id: orderId,
            status: "awaiting_confirmation",
            // A secret, new for every payment: whoever holds it can confirm the payment.
            confirm_key: randomBytes(24).toString("base64url"),
          },
        };
      }

      const body = (request.body ?? {}) as { sku?: unknown; quantity?: unknown; coupon?: unknown };
      if (typeof body.sku !== "string") {
        return { status: 422, body: { error: "invalid_request", field: "sku" } };
      }
      const quantity = body.quantity;
      if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
        return { status: 422, body: { error: "invalid_request", field: "quantity" } };
      }
      const product = PRODUCTS[body.sku];
      if (product === undefined) {
        return { status: 404, body: { error: "unknown_sku" } };
      }
      let discountPercent = 0;
      if (body.coupon !== undefined && body.coupon !== null) {
        const percent = typeof body.coupon === "string" ? COUPONS[body.coupon] : undefined;
        if (percent === undefined) {
          return { status: 422, body: { error: "coupon_unknown" } };
        }
        discountPercent = percent;
      }
      if (product.stock < quantity) {
        return { status: 409, body: { error: "out_of_stock", available: product.stock } };
      }

      sequence += 1;
      return {
        status: 201,
        body: {
          id: `ord_${Date.now().toString(36)}${sequence}`,
          customer,
          status: "confirmed",
          total_minor: orderTotalMinor(product.unitPriceMinor, quantity, discountPercent),
          created_at: now().toISOString(),
        },
      };
    },
  };
}
