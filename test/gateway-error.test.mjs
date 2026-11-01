import assert from "node:assert/strict";
import test from "node:test";
import { gatewayTransportFailure } from "../src/openclaw/gateway-client.mjs";

test("Gateway diagnostics retain underlying network codes without printing headers or credentials", () => {
  const result = gatewayTransportFailure({ error: { message: "token=secret", cause: { errors: [{ code: "ECONNREFUSED" }, { code: "ECONNRESET" }] } } });
  assert.match(result, /ECONNREFUSED/);
  assert.match(result, /ECONNRESET/);
  assert.doesNotMatch(result, /secret/);
});
