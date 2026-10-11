/** The entry point of the deployed API. It adds nothing to `assembleServer` but the port. */
import { assembleServer } from "./server.js";

const tokens = JSON.parse(process.env.ORDER_API_TOKENS ?? "{}") as Record<string, string>;
assembleServer({ tokens }).listen(Number(process.env.PORT ?? 3000));
