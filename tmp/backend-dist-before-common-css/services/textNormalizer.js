const LEGACY_MOJIBAKE_MAP = {
    "\u00e2\u20ac\u0153": "\u201c",
    "\u00e2\u20ac\u009d": "\u201d",
    "\u00e2\u20ac\u2122": "\u2019",
    "\u00e2\u20ac\u02dc": "\u2018",
    "\u00e2\u20ac\u201c": "\u2013",
    "\u00e2\u20ac\u201d": "\u2014",
    "\u00e2\u20ac\u00a2": "\u2022",
    "\u00e2\u20ac\u00a6": "\u2026",
    "\u00e2\u2013\u00a0": "\u25a0",
    "\u00c2\u00ae": "\u00ae",
    "\u00c2\u00a9": "\u00a9",
    "\u00c2\u00b0": "\u00b0",
    "\u00c2\u00b1": "\u00b1",
    "\u00c2\u00b7": "\u00b7",
    "\u00c2\u00a0": " ",
    "Ã‚Â»": "»",
    "Ã¢â‚¬Â": "”",
    "Ã¢â‚¬Å“": "“",
    "Ã¢â‚¬â„¢": "’",
    "Ã¢â‚¬â€œ": "–",
    "Ã¢â‚¬â€": "—",
    "Ã¯Â¿Â½": ""
};
const LIGATURE_MAP = {
    "ﬀ": "ff",
    "ﬁ": "fi",
    "ﬂ": "fl",
    "ﬃ": "ffi",
    "ﬄ": "ffl",
    "ﬅ": "st",
    "ﬆ": "st"
};
function looksLikeMojibake(value) {
    return /Ã[\u0080-\u00BF]|Â[\u0080-\u00BF¿¡]|â[€\u0080-\u00BF]/.test(value);
}
function repairUtf8ReadAsLatin1(value) {
    if (!looksLikeMojibake(value))
        return null;
    try {
        const repaired = Buffer.from(value, "latin1").toString("utf8");
        if (!repaired || repaired.includes("\uFFFD"))
            return null;
        return repaired;
    }
    catch {
        return null;
    }
}
function countMatches(value, regex) {
    return [...value.matchAll(regex)].length;
}
function addWarning(warnings, type, message, count) {
    if (count > 0)
        warnings.push({ type, message, count });
}
function replaceAllTracked(value, replacements, source, target, reason) {
    if (!source || !value.includes(source))
        return value;
    replacements.push({ source, target, reason });
    return value.split(source).join(target);
}
export function normalizePdfText(text, profile) {
    const warnings = [];
    const replacements = [];
    let value = String(text ?? "").normalize("NFC");
    addWarning(warnings, "replacement-character", "PDF text contains Unicode replacement characters.", countMatches(value, /\uFFFD/g));
    addWarning(warnings, "mojibake", "PDF text contains common mojibake markers.", countMatches(value, /Ã|Â|â€|ï¿½/g));
    addWarning(warnings, "private-use", "PDF text contains private-use characters that may indicate broken font encoding.", countMatches(value, /[\uE000-\uF8FF]/g));
    addWarning(warnings, "control-character", "PDF text contains control characters.", countMatches(value, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g));
    addWarning(warnings, "variation-selector", "PDF text contains variation selectors.", countMatches(value, /[\uFE00-\uFE0F]/g));
    for (const [source, target] of Object.entries(LEGACY_MOJIBAKE_MAP)) {
        value = replaceAllTracked(value, replacements, source, target, "legacy");
    }
    const latin1Repaired = repairUtf8ReadAsLatin1(value);
    if (latin1Repaired && latin1Repaired !== value) {
        replacements.push({ source: value, target: latin1Repaired, reason: "legacy" });
        value = latin1Repaired;
    }
    for (const [source, target] of Object.entries(LIGATURE_MAP)) {
        value = replaceAllTracked(value, replacements, source, target, "ligature");
    }
    for (const [source, target] of Object.entries(profile.encodingMap ?? {})) {
        value = replaceAllTracked(value, replacements, source, target, "profile");
    }
    value = value
        .replace(/[\uFE00-\uFE0F]/g, (source) => {
        replacements.push({ source, target: "", reason: "variation" });
        return "";
    })
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, (source) => {
        replacements.push({ source, target: "", reason: "control" });
        return "";
    })
        .replace(/\s+/g, " ")
        .trim()
        .normalize("NFC");
    if (/^(?:[A-Z0-9]\s+){2,}[A-Z0-9]$/.test(value)) {
        value = value.replace(/\s+/g, "");
    }
    const suspiciousCount = countMatches(value, /[\uFFFD\uE000-\uF8FF]/g) + countMatches(value, /Ã|Â|â€/g);
    const suspiciousRatio = value.length > 0 ? suspiciousCount / value.length : 0;
    addWarning(warnings, "suspicious-character-ratio", "PDF text has a high suspicious-character ratio.", suspiciousRatio >= 0.08 ? suspiciousCount : 0);
    return { text: value, warnings, replacements };
}
