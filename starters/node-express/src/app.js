import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  app.use(express.static(path.join(here, "..", "public")));

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  app.get("/ready", (req, res) => {
    // TODO: answer 200 {"ready": true} once your app can serve six-month reports (level 2).
    res.status(503).json({ ready: false });
  });

  app.get("/api/requests", (req, res) => {
    // TODO (level 4): filters, sorting and cursor pagination, see docs/contract.md.
    res.status(501).json({ error: "not implemented" });
  });

  app.get("/api/sla-report", (req, res) => {
    // TODO: implement the response-time report here.
    // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD.
    // Use the client in src/helpdesk.js to call the helpdesk API.
    res.status(501).json({ error: "not implemented" });
  });

  return app;
}
