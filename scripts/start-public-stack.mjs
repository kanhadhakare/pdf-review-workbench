import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const root = "E:\\pdf-review-workbench";
const nodeExe = "C:\\Program Files\\nodejs\\node.exe";

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function spawnDetached(name, command, args, cwd, logFile, env = {}) {
  const out = openSync(path.join(root, logFile), "a");
  const child = spawn(command, args, {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
    shell: false,
    env: { ...process.env, ...env }
  });
  child.unref();
  console.log(`${name} started with pid ${child.pid}`);
}

if (!(await isPortOpen(3000))) {
  spawnDetached("backend", nodeExe, ["dist/server.js"], path.join(root, "backend"), "public-backend.log", {
    BACKEND_ROOT: path.join(root, "backend"),
    WORKBENCH_ROOT: root,
    STORAGE_ROOT: path.join(root, "storage"),
    JAVA_HOME: "E:\\openjdk-21+35_windows-x64_bin\\jdk-21",
    JAVA_BIN: "E:\\openjdk-21+35_windows-x64_bin\\jdk-21\\bin\\java.exe",
    PDFBOX_FONT_EXTRACTOR_JAR: path.join(root, "backend", "tools", "pdfbox-font-extractor", "target", "pdfbox-font-extractor.jar"),
    PYTHON_BIN: path.join(root, "backend", ".venv", "Scripts", "python.exe")
  });
} else {
  console.log("backend already running on 3000");
}

if (!(await isPortOpen(4300))) {
  spawnDetached("frontend", nodeExe, ["scripts/static-frontend.mjs"], root, "public-frontend.log");
} else {
  console.log("frontend already running on 4300");
}

if (!(await isPortOpen(8090))) {
  spawnDetached("gateway", nodeExe, ["scripts/public-gateway.mjs"], root, "public-gateway-runtime.log");
} else {
  console.log("gateway already running on 8090");
}
