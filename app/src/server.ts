// Placeholder until T5 wires the HTTP layer; keeps /health working from the first commit.
import http from 'node:http';

const port = Number(process.env.PORT || 8080);

http
  .createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not ready' }));
  })
  .listen(port, '0.0.0.0', () => console.log(`listening on http://0.0.0.0:${port}`));
