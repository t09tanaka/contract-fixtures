/** The entry point of the deployed API. It adds nothing to `createServer` but the port. */
import { createServer } from "./server.js";

const tokens = JSON.parse(process.env.ORDER_API_TOKENS ?? "{}") as Record<string, string>;
createServer({ tokens }).listen(Number(process.env.PORT ?? 3000));
