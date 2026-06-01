import http from "node:http";
import { readFileSync } from "node:fs";

function loadLocalEnv() {
  try {
    const content = readFileSync(".public-gateway.env", "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // Optional local file for test hosting.
  }
}

loadLocalEnv();

const port = Number(process.env.PUBLIC_GATEWAY_PORT ?? "8090");
const username = process.env.PUBLIC_GATEWAY_USER ?? "reviewer";
const password = process.env.PUBLIC_GATEWAY_PASS;
const frontendTarget = new URL(process.env.PUBLIC_FRONTEND_TARGET ?? "http://127.0.0.1:4200");
const backendTarget = new URL(process.env.PUBLIC_BACKEND_TARGET ?? "http://127.0.0.1:3000");

if (!password) {
  console.error("PUBLIC_GATEWAY_PASS is required.");
  process.exit(1);
}

function isAuthorized(req) {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  return decoded === `${username}:${password}`;
}

function reject(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="PDF Review Workbench"',
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end("Authentication required");
}

function resolveTarget(req) {
  const target = req.url?.startsWith("/api/") || req.url?.startsWith("/storage/")
    ? backendTarget
    : frontendTarget;
  return new URL(req.url ?? "/", target);
}

const server = http.createServer((req, res) => {
  if (!isAuthorized(req)) {
    reject(res);
    return;
  }

  const targetUrl = resolveTarget(req);
  const headers = { ...req.headers, host: targetUrl.host };
  delete headers.authorization;

  const proxyReq = http.request(
    targetUrl,
    {
      method: req.method,
      headers
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (error) => {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Gateway error: ${error.message}`);
  });

  req.pipe(proxyReq);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Protected gateway listening on http://0.0.0.0:${port}`);
  console.log(`Username: ${username}`);
});
