// /rest/v1/* → PostgREST, as Supabase serves it (headers and body passed through unchanged).
// Fault injection for the acceptance tests (POST /__fault with JSON { match, mode, count, ms }):
//   lose_response  the request reaches the database and commits, then the connection drops before the answer
//                  (what a phone sees when mobile data cuts out mid-request);
//   no_connection  the connection drops before the request is sent (nothing reaches the database);
//   delay          the request waits `ms` before it is sent.
// `match` is a substring of the path (e.g. "rpc/book_at_desk"); `count` how many requests it applies to.
import http from "node:http";
const UP = { host: "127.0.0.1", port: 3011 };
let faults = [];
http.createServer((req, res) => {
  if (req.url === "/__fault") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => { const f = JSON.parse(body || "{}"); if (f.clear) faults = []; else faults.push({ count: 1, ...f }); res.end("ok"); });
    return;
  }
  if (!req.url.startsWith("/rest/v1")) { res.writeHead(404); res.end("not found"); return; }
  const path = req.url.slice("/rest/v1".length) || "/";
  const f = faults.find((x) => x.count > 0 && path.includes(x.match));
  if (f) f.count--;
  const send = () => {
    if (f?.mode === "no_connection") { req.socket.destroy(); return; }
    const up = http.request({ ...UP, path, method: req.method, headers: { ...req.headers, host: `${UP.host}:${UP.port}` } }, (r) => {
      if (f?.mode === "lose_response") { r.resume(); r.on("end", () => req.socket.destroy()); return; }
      res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res);
    });
    up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
    req.pipe(up);
  };
  if (f?.mode === "delay") setTimeout(send, f.ms ?? 1000); else send();
}).listen(54329, "127.0.0.1");
