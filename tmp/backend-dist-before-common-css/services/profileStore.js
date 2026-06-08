import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { profilesStorageRoot } from "../config/runtime.js";
const PROFILES_ROOT = profilesStorageRoot;
const cache = new Map();
function defaultProfile(fingerprint) {
    return {
        fingerprint,
        sampleCount: 0,
        yBandTolerance: 3,
        xGapTolerance: 12,
        baselineDrift: 0,
        coordOffsetX: 0,
        coordOffsetY: 0,
        encodingMap: {},
        artifactThreshold: 0.5,
        headingCutoffs: [18, 14, 12],
        firstLineIndentPx: 0,
        indentedParaXOffset: 0,
        defaultTextIndent: 0,
        lastUpdated: new Date(0).toISOString()
    };
}
async function ensureRoot() { await mkdir(PROFILES_ROOT, { recursive: true }); }
function getPath(fingerprint) { return path.join(PROFILES_ROOT, `${fingerprint}.json`); }
export async function loadProfile(fingerprint) {
    if (cache.has(fingerprint))
        return cache.get(fingerprint);
    await ensureRoot();
    try {
        const content = await readFile(getPath(fingerprint), "utf8");
        const parsed = JSON.parse(content);
        cache.set(fingerprint, parsed);
        return parsed;
    }
    catch {
        const profile = defaultProfile(fingerprint);
        cache.set(fingerprint, profile);
        return profile;
    }
}
export async function saveProfile(profile) {
    await ensureRoot();
    cache.set(profile.fingerprint, profile);
    await writeFile(getPath(profile.fingerprint), JSON.stringify(profile, null, 2), "utf8");
}
export async function listProfiles() {
    await ensureRoot();
    const files = await readdir(PROFILES_ROOT);
    const profiles = [];
    for (const file of files) {
        if (!file.endsWith(".json"))
            continue;
        const profile = await loadProfile(file.replace(/\.json$/, ""));
        profiles.push({ fingerprint: profile.fingerprint, sampleCount: profile.sampleCount, lastUpdated: profile.lastUpdated });
    }
    return profiles.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
}
export async function warmProfiles() { await listProfiles(); }
