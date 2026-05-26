import { spawn, spawnSync } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, "..");
const TOOL_ROOT = path.join(BACKEND_ROOT, "tools", "pdfbox-font-extractor");
const POM_PATH = path.join(TOOL_ROOT, "pom.xml");
const JAR_PATH = path.join(TOOL_ROOT, "target", "pdfbox-font-extractor.jar");
const JAVA_EXE = process.platform === "win32" ? "java.exe" : "java";
const MVN_EXE = process.platform === "win32" ? "mvn.cmd" : "mvn";
const PYTHON_EXE = process.platform === "win32" ? "python.exe" : "python3";
const LOCAL_PYTHON = path.join(BACKEND_ROOT, ".venv", process.platform === "win32" ? "Scripts" : "bin", PYTHON_EXE);

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function which(command) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], { encoding: "utf8" });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function commandWorks(command, args = ["--version"]) {
  try {
    const result = spawnSync(command, args, { encoding: "utf8" });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    return result.status === 0 && !/No installed Python found/i.test(output);
  } catch {
    return false;
  }
}

async function listDirectories(rootPath) {
  try {
    const entries = await readdir(rootPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(rootPath, entry.name));
  } catch {
    return [];
  }
}

async function findJavaCandidates() {
  const candidates = [
    process.env.JAVA_BIN,
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", JAVA_EXE) : null,
    ...which(process.platform === "win32" ? "java.exe" : "java"),
    "/usr/bin/java",
    "/usr/local/bin/java",
    "E:\\openjdk-21+35_windows-x64_bin\\jdk-21\\bin\\java.exe",
    "C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\java.exe"
  ];

  const commonRoots = process.platform === "win32"
    ? ["C:\\Program Files\\Java", "C:\\Program Files\\Eclipse Adoptium", "C:\\Program Files\\Microsoft", "E:\\"]
    : ["/usr/lib/jvm"];

  for (const root of commonRoots) {
    for (const directory of await listDirectories(root)) {
      candidates.push(path.join(directory, "bin", JAVA_EXE));
      if (process.platform === "win32" && root === "E:\\") {
        for (const nested of await listDirectories(directory)) {
          candidates.push(path.join(nested, "bin", JAVA_EXE));
        }
      }
    }
  }

  return unique(candidates);
}

async function findMavenCandidates() {
  const candidates = [
    process.env.MAVEN_BIN,
    process.env.MAVEN_HOME ? path.join(process.env.MAVEN_HOME, "bin", MVN_EXE) : null,
    process.env.M2_HOME ? path.join(process.env.M2_HOME, "bin", MVN_EXE) : null,
    ...which(process.platform === "win32" ? "mvn.cmd" : "mvn"),
    "/usr/bin/mvn",
    "/usr/local/bin/mvn",
    "E:\\apache-maven-3.9.16-bin\\apache-maven-3.9.16\\bin\\mvn.cmd"
  ];

  const commonRoots = process.platform === "win32"
    ? ["C:\\Program Files\\Apache", "C:\\Program Files\\Maven", "E:\\"]
    : ["/usr/share/maven", "/opt"];

  for (const root of commonRoots) {
    for (const directory of await listDirectories(root)) {
      if (process.platform !== "win32" || /apache-maven|maven/i.test(path.basename(directory))) {
        candidates.push(path.join(directory, "bin", MVN_EXE));
      }
    }
  }

  return unique(candidates);
}

function isWindowsAppAlias(candidate) {
  return typeof candidate === "string" && candidate.toLowerCase().includes("windowsapps");
}

async function findPythonCandidates() {
  return unique([
    process.env.PYTHON_BIN,
    LOCAL_PYTHON,
    process.env.PYTHON_HOME ? path.join(process.env.PYTHON_HOME, process.platform === "win32" ? PYTHON_EXE : path.join("bin", PYTHON_EXE)) : null,
    ...which(process.platform === "win32" ? "python.exe" : "python3"),
    ...(process.platform === "win32" ? [] : which("python")),
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "C:\\Program Files\\PostgreSQL\\17\\pgAdmin 4\\python\\python.exe",
    "C:\\Users\\Diva\\AppData\\Local\\Programs\\Python\\Python313\\python.exe"
  ]);
}

export async function resolveJavaRuntime() {
  for (const candidate of await findJavaCandidates()) {
    if (await pathExists(candidate)) {
      return {
        javaBin: candidate,
        javaHome: path.dirname(path.dirname(candidate))
      };
    }
  }
  throw new Error("Java runtime not found. Set JAVA_HOME or JAVA_BIN, or install Java and restart the shell.");
}

export async function resolveMavenBin() {
  for (const candidate of await findMavenCandidates()) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function resolvePythonRuntime() {
  for (const candidate of await findPythonCandidates()) {
    if (isWindowsAppAlias(candidate)) continue;
    if (await pathExists(candidate) && commandWorks(candidate)) {
      return { pythonBin: candidate };
    }
  }
  return null;
}

async function collectSourceFiles(rootPath) {
  const queue = [rootPath];
  const files = [];
  while (queue.length > 0) {
    const current = queue.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function latestInputMtime() {
  const files = [POM_PATH, ...(await collectSourceFiles(path.join(TOOL_ROOT, "src")))];
  let latest = 0;
  for (const filePath of files) {
    const info = await stat(filePath);
    latest = Math.max(latest, info.mtimeMs);
  }
  return latest;
}

async function jarIsFresh() {
  if (!(await pathExists(JAR_PATH))) {
    return false;
  }
  const [jarStat, newestInput] = await Promise.all([stat(JAR_PATH), latestInputMtime()]);
  return jarStat.mtimeMs >= newestInput;
}

export async function ensurePdfBoxJar({ force = false } = {}) {
  const runtime = await resolveJavaRuntime();
  const mavenBin = await resolveMavenBin();

  if (!force && await jarIsFresh()) {
    return {
      javaBin: runtime.javaBin,
      javaHome: runtime.javaHome,
      jarPath: JAR_PATH
    };
  }

  if (!mavenBin) {
    if (await pathExists(JAR_PATH)) {
      console.warn("[pdfbox] Maven not found. Continuing with existing PDFBox jar.");
      return {
        javaBin: runtime.javaBin,
        javaHome: runtime.javaHome,
        jarPath: JAR_PATH
      };
    }
    throw new Error("Maven not found. Set MAVEN_HOME or install Maven so the PDFBox sidecar can be built.");
  }

  await new Promise((resolve, reject) => {
    const child = spawn(mavenBin, ["-f", POM_PATH, "package"], {
      cwd: BACKEND_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        JAVA_HOME: runtime.javaHome
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`PDFBox build failed with exit code ${code ?? "unknown"}.`));
      }
    });
  });

  return {
    javaBin: runtime.javaBin,
    javaHome: runtime.javaHome,
    jarPath: JAR_PATH
  };
}

export function buildBackendEnv(runtime, pythonRuntime = null) {
  const env = {
    ...process.env,
    JAVA_BIN: runtime.javaBin,
    JAVA_HOME: runtime.javaHome,
    PDFBOX_FONT_EXTRACTOR_JAR: runtime.jarPath,
    BACKEND_ROOT: BACKEND_ROOT,
    WORKBENCH_ROOT: path.resolve(BACKEND_ROOT, ".."),
    STORAGE_ROOT: process.env.STORAGE_ROOT || path.resolve(BACKEND_ROOT, "..", "storage")
  };
  if (pythonRuntime?.pythonBin) {
    env.PYTHON_BIN = pythonRuntime.pythonBin;
  }
  console.debug("[backend] environment variables:", {
    JAVA_BIN: env.JAVA_BIN,
    JAVA_HOME: env.JAVA_HOME,
    PDFBOX_FONT_EXTRACTOR_JAR: env.PDFBOX_FONT_EXTRACTOR_JAR,
    PYTHON_BIN: env.PYTHON_BIN || "(not set)"
  });
  return env;
}

export function getBackendRoot() {
  return BACKEND_ROOT;
}

