import { type ExtractionProfile } from "../types.js";

export type TextNormalizationWarningType =
  | "replacement-character"
  | "mojibake"
  | "private-use"
  | "control-character"
  | "variation-selector"
  | "suspicious-character-ratio";

export interface TextNormalizationWarning {
  type: TextNormalizationWarningType;
  message: string;
  count: number;
}

export interface TextNormalizationResult {
  text: string;
  warnings: TextNormalizationWarning[];
  replacements: Array<{ source: string; target: string; reason: "legacy" | "ligature" | "profile" | "control" | "variation" }>;
}

const LEGACY_MOJIBAKE_MAP: Record<string, string> = {
  "Ã‚Â»": "»",
  "Ã¢â‚¬Â": "”",
  "Ã¢â‚¬Å“": "“",
  "Ã¢â‚¬â„¢": "’",
  "Ã¢â‚¬â€œ": "–",
  "Ã¢â‚¬â€": "—",
  "Ã¯Â¿Â½": ""
};

const LIGATURE_MAP: Record<string, string> = {
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
  "ﬅ": "st",
  "ﬆ": "st"
};

function looksLikeMojibake(value: string): boolean {
  return /Ã[\u0080-\u00BF]|Â[\u0080-\u00BF¿¡]|â[€\u0080-\u00BF]/.test(value);
}

function repairUtf8ReadAsLatin1(value: string): string | null {
  if (!looksLikeMojibake(value)) return null;
  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    if (!repaired || repaired.includes("\uFFFD")) return null;
    return repaired;
  } catch {
    return null;
  }
}

function countMatches(value: string, regex: RegExp): number {
  return [...value.matchAll(regex)].length;
}

function addWarning(warnings: TextNormalizationWarning[], type: TextNormalizationWarningType, message: string, count: number): void {
  if (count > 0) warnings.push({ type, message, count });
}

function replaceAllTracked(
  value: string,
  replacements: TextNormalizationResult["replacements"],
  source: string,
  target: string,
  reason: TextNormalizationResult["replacements"][number]["reason"]
): string {
  if (!source || !value.includes(source)) return value;
  replacements.push({ source, target, reason });
  return value.split(source).join(target);
}

export function normalizePdfText(text: string, profile: ExtractionProfile): TextNormalizationResult {
  const warnings: TextNormalizationWarning[] = [];
  const replacements: TextNormalizationResult["replacements"] = [];
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
