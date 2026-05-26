import { spawn } from "node:child_process";
import { buildBackendEnv, ensurePdfBoxJar, getBackendRoot, resolvePythonRuntime } from "./pdfbox-runtime.mjs";

try {
  const runtime = await ensurePdfBoxJar();
  const pythonRuntime = await resolvePythonRuntime();
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: getBackendRoot(),
    stdio: "inherit",
    env: buildBackendEnv(runtime, pythonRuntime)
  });
  child.on("error", (error) => {
    console.error(`[backend] failed to start server: ${error.message}`);
    process.exit(1);
  });
  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
} catch (error) {
  console.error(`[backend] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
