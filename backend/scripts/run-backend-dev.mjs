import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBackendEnv, ensurePdfBoxJar, getBackendRoot, resolvePythonRuntime } from "./pdfbox-runtime.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TSX_CLI = path.resolve(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");

try {
  const runtime = await ensurePdfBoxJar();
  const pythonRuntime = await resolvePythonRuntime();
  const child = spawn(process.execPath, [TSX_CLI, "watch", "src/server.ts"], {
    cwd: getBackendRoot(),
    stdio: "inherit",
    env: buildBackendEnv(runtime, pythonRuntime)
  });
  child.on("error", (error) => {
    console.error(`[backend] failed to start dev server: ${error.message}`);
    process.exit(1);
  });
  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
} catch (error) {
  console.error(`[backend] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
