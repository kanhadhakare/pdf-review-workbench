import path from "node:path";

const isWindows = process.platform === "win32";
const PYTHON_EXE = isWindows ? "python.exe" : "python3";

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())).map((value) => value.trim()))];
}

function resolvePath(candidate: string): string {
  return path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(candidate);
}

function splitCommaList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function splitPathList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
}

export const backendRoot = resolvePath(process.env.BACKEND_ROOT ?? process.cwd());
export const workbenchRoot = resolvePath(process.env.WORKBENCH_ROOT ?? path.join(backendRoot, ".."));
export const storageRoot = resolvePath(process.env.STORAGE_ROOT ?? path.join(workbenchRoot, "storage"));
export const localPythonBin = path.join(backendRoot, ".venv", isWindows ? "Scripts" : "bin", PYTHON_EXE);
export const jobsStorageRoot = path.join(storageRoot, "jobs");
export const fixesStorageRoot = path.join(storageRoot, "fixes");
export const profilesStorageRoot = path.join(storageRoot, "profiles");
export const modelsStorageRoot = path.join(storageRoot, "models");
export const uploadsStorageRoot = path.join(storageRoot, "uploads");

export const ocrScriptPath = resolvePath(process.env.OCR_SCRIPT ?? path.join(backendRoot, "src", "scripts", "paddle_ocr_runner.py"));
export const pix2TextScriptPath = resolvePath(process.env.PIX2TEXT_SCRIPT ?? path.join(backendRoot, "src", "scripts", "pix2text_runner.py"));
export const doclingLayoutScriptPath = resolvePath(process.env.DOCLING_LAYOUT_SCRIPT ?? path.join(backendRoot, "src", "scripts", "docling_layout_runner.py"));
export const trainerScriptPath = resolvePath(process.env.TRAINER_SCRIPT ?? path.join(backendRoot, "src", "scripts", "train_classifiers.py"));
export const pdfboxJarPath = resolvePath(process.env.PDFBOX_FONT_EXTRACTOR_JAR ?? path.join(backendRoot, "tools", "pdfbox-font-extractor", "target", "pdfbox-font-extractor.jar"));
export const pdfboxPdfToolJarPath = resolvePath(process.env.PDFBOX_PDF_TOOL_JAR ?? path.join(backendRoot, "tools", "pdfbox-pdf-tool", "target", "pdfbox-pdf-tool.jar"));
export const fontForgeScriptDir = resolvePath(process.env.FONTFORGE_SCRIPT_DIR ?? path.join(storageRoot, "fontforge"));
export const accessibilityAutoDetectionEngine = (process.env.ACCESSIBILITY_AUTO_DETECTION_ENGINE ?? "docling").trim().toLowerCase();

export const serverPort = Number.parseInt(process.env.PORT ?? "3000", 10) || 3000;
export const extractionPageConcurrency = Math.max(1, Number.parseInt(process.env.EXTRACT_PAGE_CONCURRENCY ?? "1", 10) || 1);
export const extractionMaxDpi = Math.max(72, Number.parseInt(process.env.EXTRACT_MAX_DPI ?? "150", 10) || 150);
export const extractionMinDpi = Math.max(36, Number.parseInt(process.env.EXTRACT_MIN_DPI ?? "72", 10) || 72);
export const extractionMaxPixels = Math.max(1_000_000, Number.parseInt(process.env.EXTRACT_MAX_PIXELS ?? "6000000", 10) || 6_000_000);
export const finalOutputDpi = Math.max(72, Number.parseInt(process.env.FINAL_OUTPUT_DPI ?? "200", 10) || 200);
export const finalMaxPixels = Math.max(1_000_000, Number.parseInt(process.env.FINAL_MAX_PIXELS ?? "9000000", 10) || 9_000_000);
export const finalViewportDpi = Math.max(72, Number.parseFloat(process.env.FINAL_VIEWPORT_DPI ?? "96") || 96);
export const mupdfMaxInputBytes = Math.max(50 * 1024 * 1024, Number.parseInt(process.env.MUPDF_MAX_INPUT_BYTES ?? String(512 * 1024 * 1024), 10) || 512 * 1024 * 1024);
export const largePdfPagesPerChunk = Math.max(1, Number.parseInt(process.env.LARGE_PDF_PAGES_PER_CHUNK ?? "50", 10) || 50);

export function getCorsOrigins(): string[] {
  const configured = splitCommaList(process.env.CORS_ORIGIN);
  return configured.length ? configured : ["http://localhost:4200", "http://localhost:8080"];
}

export function getAllowedLocalPathRoots(): string[] {
  const configured = splitPathList(process.env.PDF_ALLOWED_ROOTS).map(resolvePath);
  return configured.length ? configured : [workbenchRoot, uploadsStorageRoot];
}

export function pythonCommandCandidates(): string[] {
  return unique([
    process.env.PYTHON_BIN,
    localPythonBin,
    process.env.PYTHON_HOME ? resolvePath(path.join(process.env.PYTHON_HOME, isWindows ? PYTHON_EXE : path.join("bin", PYTHON_EXE))) : null,
    isWindows ? "python" : "python3",
    isWindows ? "py" : "python",
    isWindows ? "C:/Program Files/PostgreSQL/17/pgAdmin 4/python/python.exe" : "/usr/bin/python3",
    isWindows ? "C:/Users/Diva/AppData/Local/Programs/Python/Python313/python.exe" : "/usr/local/bin/python3"
  ]);
}

export function preferredPythonCommand(): string {
  return pythonCommandCandidates()[0] ?? (isWindows ? "python" : "python3");
}

export function tesseractCommandCandidates(): string[] {
  return unique([
    process.env.TESSERACT_BIN,
    isWindows ? "tesseract.exe" : "tesseract",
    isWindows ? "C:/Program Files/Tesseract-OCR/tesseract.exe" : "/usr/bin/tesseract",
    isWindows ? "C:/Program Files (x86)/Tesseract-OCR/tesseract.exe" : "/usr/local/bin/tesseract",
    isWindows ? "C:/Users/Diva/AppData/Local/Programs/Tesseract-OCR/tesseract.exe" : null
  ]);
}

export function fontForgeCommandCandidates(): string[] {
  return unique([
    process.env.FONTFORGE_BIN,
    isWindows ? "fontforge.exe" : "fontforge",
    isWindows ? "C:/Program Files/FontForgeBuilds/bin/fontforge.exe" : "/usr/bin/fontforge",
    isWindows ? "C:/Program Files (x86)/FontForgeBuilds/bin/fontforge.exe" : "/usr/local/bin/fontforge",
    isWindows ? "C:/Program Files/FontForge/bin/fontforge.exe" : null,
    isWindows ? "C:/Program Files (x86)/FontForge/bin/fontforge.exe" : null
  ]);
}
