// /rest/v1/* → PostgREST, as Supabase serves it (headers and body passed through unchanged).
import http from "node:http";
const UP = { host: "127.0.0.1", port: 3011 };
http.createServer((req, res) => {
  if (!req.url.startsWith("/rest/v1")) { res.writeHead(404); res.end("not found"); return; }
  const path = req.url.slice("/rest/v1".length) || "/";
  const up = http.request({ ...UP, path, method: req.method, headers: { ...req.headers, host: `${UP.host}:${UP.port}` } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res);
  });
  up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
}).listen(54329, "127.0.0.1");
