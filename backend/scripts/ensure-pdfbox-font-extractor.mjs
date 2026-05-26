import { ensurePdfBoxJar } from "./pdfbox-runtime.mjs";

const force = process.argv.includes("--force");

try {
  const runtime = await ensurePdfBoxJar({ force });
  console.log(`[pdfbox] ready: ${runtime.jarPath}`);
} catch (error) {
  console.error(`[pdfbox] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
