import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

test("GET /health returns ok", async () => {
  const server = createApp().listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    server.close();
  }
});
