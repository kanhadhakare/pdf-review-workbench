const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const port = Number(process.env.PORT || "4010");
const jobsRoot = process.env.JOBS_ROOT || "/jobs";

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (err) { reject(err); }
    });
  });
}

function runPdf2HtmlEx(payload) {
  const jobId = payload && payload.jobId;
  const pdfRelPath = payload && payload.pdfRelPath;
  const destRelDir = payload && payload.destRelDir;
  if (!jobId || typeof jobId !== "string") throw new Error("jobId required");
  if (!pdfRelPath || typeof pdfRelPath !== "string") throw new Error("pdfRelPath required");
  if (!destRelDir || typeof destRelDir !== "string") throw new Error("destRelDir required");
  if (pdfRelPath.includes("..") || destRelDir.includes("..")) throw new Error("Invalid relative paths");

  const jobDir = path.join(jobsRoot, jobId);
  const inputPdfPath = path.join(jobDir, pdfRelPath);
  const destDir = path.join(jobDir, destRelDir);

  const args = [
    "--dest-dir", destDir,
    "--split-pages", "1",
    "--page-filename", "page-%d.html",
    "--css-filename", "style.css",
    "--font-format", "woff",
    inputPdfPath
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("pdf2htmlEX", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, stdout: stdout, stderr: stderr });
      else reject(new Error(`pdf2htmlEX failed (code ${code}): ${stderr.slice(0, 2000)}`));
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/run") {
    readJson(req)
      .then((body) => runPdf2HtmlEx(body))
      .then((result) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      })
      .catch((err) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: err && err.message ? err.message : "bad request" }));
      });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, message: "not found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`pdf2htmlex-runner listening on ${port}`);
});
