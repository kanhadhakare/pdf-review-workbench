import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";

const root = "E:\\pdf-review-workbench\\frontend\\dist\\web\\browser";
const port = Number(process.env.PUBLIC_FRONTEND_PORT ?? "4300");

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const candidate = path.join(root, normalized);
  return candidate.startsWith(root) ? candidate : path.join(root, "index.html");
}

const server = http.createServer((req, res) => {
  const requested = safePath(req.url ?? "/");
  const filePath = existsSync(requested) && statSync(requested).isFile()
    ? requested
    : path.join(root, "index.html");
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": contentTypes.get(ext) ?? "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable"
  });
  createReadStream(filePath).pipe(res);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Static frontend listening on http://0.0.0.0:${port}`);
});
