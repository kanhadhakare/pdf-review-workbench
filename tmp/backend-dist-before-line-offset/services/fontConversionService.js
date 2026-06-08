import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { compress as compressWoff2 } from "wawoff2";
import { fontForgeCommandCandidates, fontForgeScriptDir } from "../config/runtime.js";
import { jobStore } from "./jobStore.js";
const CONVERTIBLE_FORMATS = new Set(["truetype", "opentype"]);
const REBUILDABLE_FORMATS = new Set(["type1", "unknown"]);
let cachedFontForgeCommand;
function align4(value) {
    return (value + 3) & ~3;
}
function isSfntFont(bytes) {
    if (bytes.length < 12)
        return false;
    const signature = bytes.subarray(0, 4).toString("latin1");
    return signature === "\x00\x01\x00\x00" || signature === "OTTO" || signature === "true" || signature === "typ1";
}
async function fileExists(filePath) {
    try {
        await access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function resolveFontForgeCommand() {
    if (cachedFontForgeCommand !== undefined)
        return cachedFontForgeCommand;
    for (const candidate of fontForgeCommandCandidates()) {
        if (path.isAbsolute(candidate)) {
            if (await fileExists(candidate)) {
                cachedFontForgeCommand = candidate;
                return candidate;
            }
            continue;
        }
        const result = await runProcess(candidate, ["-version"]);
        if (result.ok) {
            cachedFontForgeCommand = candidate;
            return candidate;
        }
    }
    cachedFontForgeCommand = null;
    return null;
}
async function runProcess(command, args) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", (error) => {
            resolve({ ok: false, stdout, stderr: error.message });
        });
        child.on("close", (code) => {
            resolve({ ok: code === 0, stdout, stderr });
        });
    });
}
function parseSfntTables(bytes) {
    if (!isSfntFont(bytes))
        throw new Error("Font is not an SFNT font");
    const numTables = bytes.readUInt16BE(4);
    const tableDirEnd = 12 + (numTables * 16);
    if (numTables <= 0 || tableDirEnd > bytes.length)
        throw new Error("Invalid SFNT table directory");
    const tables = [];
    for (let index = 0; index < numTables; index += 1) {
        const recordOffset = 12 + (index * 16);
        const tableOffset = bytes.readUInt32BE(recordOffset + 8);
        const length = bytes.readUInt32BE(recordOffset + 12);
        if (tableOffset + length > bytes.length)
            throw new Error("Invalid SFNT table bounds");
        tables.push({
            tag: bytes.subarray(recordOffset, recordOffset + 4),
            checksum: bytes.readUInt32BE(recordOffset + 4),
            offset: tableOffset,
            length,
            data: bytes.subarray(tableOffset, tableOffset + length)
        });
    }
    return tables;
}
function buildWoff(bytes) {
    const tables = parseSfntTables(bytes);
    const directoryLength = 44 + (tables.length * 20);
    let dataOffset = align4(directoryLength);
    const compressedTables = tables.map((table) => {
        const compressed = deflateRawSync(table.data);
        const data = compressed.length < table.length ? compressed : table.data;
        const offset = dataOffset;
        dataOffset += align4(data.length);
        return { ...table, data, offset, compLength: data.length };
    });
    const woff = Buffer.alloc(dataOffset);
    woff.write("wOFF", 0, "latin1");
    bytes.copy(woff, 4, 0, 4);
    woff.writeUInt32BE(dataOffset, 8);
    woff.writeUInt16BE(tables.length, 12);
    woff.writeUInt16BE(0, 14);
    woff.writeUInt32BE(12 + (tables.length * 16) + tables.reduce((sum, table) => sum + align4(table.length), 0), 16);
    woff.writeUInt16BE(1, 20);
    woff.writeUInt16BE(0, 22);
    woff.writeUInt32BE(0, 24);
    woff.writeUInt32BE(0, 28);
    woff.writeUInt32BE(0, 32);
    woff.writeUInt32BE(0, 36);
    woff.writeUInt32BE(0, 40);
    compressedTables.forEach((table, index) => {
        const recordOffset = 44 + (index * 20);
        table.tag.copy(woff, recordOffset);
        woff.writeUInt32BE(table.offset, recordOffset + 4);
        woff.writeUInt32BE(table.compLength, recordOffset + 8);
        woff.writeUInt32BE(table.length, recordOffset + 12);
        woff.writeUInt32BE(table.checksum, recordOffset + 16);
        table.data.copy(woff, table.offset);
    });
    return woff;
}
function convertedFileName(fileName, extension) {
    return `${fileName.replace(/\.[^.]+$/, "")}.${extension}`;
}
function convertedAsset(source, fileName, format) {
    return {
        ...source,
        resourceName: `${source.resourceName}:${format}`,
        format,
        fileName
    };
}
function rebuiltFileName(fileName) {
    return `${fileName.replace(/\.[^.]+$/, "")}-rebuilt.otf`;
}
async function rebuildFontWithFontForge(font, sourcePath, targetPath) {
    const command = await resolveFontForgeCommand();
    if (!command)
        return null;
    await mkdir(fontForgeScriptDir, { recursive: true });
    const scriptPath = path.join(fontForgeScriptDir, "rebuild-font.pe");
    await writeFile(scriptPath, [
        "Open($1)",
        "Generate($2)",
        "Quit()",
        ""
    ].join("\n"), "utf8");
    const result = await runProcess(command, ["-lang=ff", "-script", scriptPath, sourcePath, targetPath]);
    if (!result.ok) {
        console.warn(`[fontConversionService] FontForge failed to rebuild ${font.fileName}: ${result.stderr || result.stdout}`);
        return null;
    }
    const rebuiltBytes = await readFile(targetPath).catch(() => null);
    if (!rebuiltBytes || !isSfntFont(rebuiltBytes)) {
        console.warn(`[fontConversionService] FontForge output is not a valid OpenType font for ${font.fileName}`);
        return null;
    }
    return {
        ...font,
        resourceName: `${font.resourceName}:rebuilt-opentype`,
        format: "opentype",
        fileName: path.basename(targetPath)
    };
}
export async function convertManifestFontsForWeb(jobId, manifest) {
    if (!manifest.fonts.length)
        return manifest;
    const fontsDir = jobStore.getFontsDir(jobId);
    const rebuiltFonts = [];
    const convertedFonts = [];
    for (const font of manifest.fonts) {
        const sourcePath = path.join(fontsDir, font.fileName);
        const sourceBytes = await readFile(sourcePath).catch(() => null);
        if (!sourceBytes)
            continue;
        let conversionSource = font;
        let conversionBytes = sourceBytes;
        if (!isSfntFont(sourceBytes) && REBUILDABLE_FORMATS.has(font.format)) {
            const rebuiltPath = path.join(fontsDir, rebuiltFileName(font.fileName));
            const rebuilt = await rebuildFontWithFontForge(font, sourcePath, rebuiltPath);
            if (!rebuilt)
                continue;
            const rebuiltBytes = await readFile(rebuiltPath).catch(() => null);
            if (!rebuiltBytes || !isSfntFont(rebuiltBytes))
                continue;
            rebuiltFonts.push(rebuilt);
            conversionSource = rebuilt;
            conversionBytes = rebuiltBytes;
        }
        if (!CONVERTIBLE_FORMATS.has(conversionSource.format) || !isSfntFont(conversionBytes))
            continue;
        const woffFileName = convertedFileName(conversionSource.fileName, "woff");
        const woff2FileName = convertedFileName(conversionSource.fileName, "woff2");
        try {
            await writeFile(path.join(fontsDir, woffFileName), buildWoff(conversionBytes));
            convertedFonts.push(convertedAsset(conversionSource, woffFileName, "woff"));
        }
        catch (error) {
            console.warn(`[fontConversionService] unable to convert ${conversionSource.fileName} to woff`, error);
        }
        try {
            const woff2Bytes = await compressWoff2(conversionBytes);
            await writeFile(path.join(fontsDir, woff2FileName), Buffer.from(woff2Bytes));
            convertedFonts.push(convertedAsset(conversionSource, woff2FileName, "woff2"));
        }
        catch (error) {
            console.warn(`[fontConversionService] unable to convert ${conversionSource.fileName} to woff2`, error);
        }
    }
    if (!rebuiltFonts.length && !convertedFonts.length)
        return manifest;
    const existing = new Set(manifest.fonts.map((font) => `${font.fileName}:${font.format}`));
    const fonts = [
        ...manifest.fonts,
        ...rebuiltFonts.filter((font) => !existing.has(`${font.fileName}:${font.format}`)),
        ...convertedFonts.filter((font) => !existing.has(`${font.fileName}:${font.format}`))
    ];
    return { ...manifest, fonts };
}
