import { saveProfile } from "./profileStore.js";
const NEW_WEIGHT = 0.15;
const OLD_WEIGHT = 0.85;
const wma = (current, next) => Number(((current * OLD_WEIGHT) + (next * NEW_WEIGHT)).toFixed(3));
function charPairs(beforeText, afterText) {
    const pairs = [];
    const length = Math.max(beforeText.length, afterText.length);
    for (let index = 0; index < length; index += 1) {
        const beforeChar = beforeText[index] ?? "";
        const afterChar = afterText[index] ?? "";
        if (beforeChar && afterChar && beforeChar !== afterChar)
            pairs.push([beforeChar, afterChar]);
    }
    return pairs;
}
export async function updateProfileFromFix(profile, fix, leftMarginPx = 0) {
    const next = { ...profile, sampleCount: profile.sampleCount + 1, lastUpdated: new Date().toISOString(), encodingMap: { ...profile.encodingMap }, headingCutoffs: [...profile.headingCutoffs] };
    switch (fix.type) {
        case 'move': {
            const dx = (fix.after.x ?? 0) - (fix.before.x ?? 0);
            const dy = (fix.after.y ?? 0) - (fix.before.y ?? 0);
            if (Math.abs(dx) > 2)
                next.coordOffsetX = wma(next.coordOffsetX, next.coordOffsetX + dx);
            if (Math.abs(dy) > 2) {
                next.coordOffsetY = wma(next.coordOffsetY, next.coordOffsetY + dy);
                next.baselineDrift = wma(next.baselineDrift, next.baselineDrift + dy);
            }
            break;
        }
        case 'merge': {
            const indented = Boolean(fix.before.isFirstLineIndented || fix.after.isFirstLineIndented);
            if (indented) {
                const observed = (fix.before.x ?? 0) - leftMarginPx;
                next.indentedParaXOffset = wma(next.indentedParaXOffset, observed);
            }
            else {
                next.xGapTolerance = wma(next.xGapTolerance, next.xGapTolerance + 2);
                const y1 = fix.before.y ?? 0;
                const y2 = fix.after.y ?? y1;
                if (Math.abs(y2 - y1) > next.yBandTolerance)
                    next.yBandTolerance = wma(next.yBandTolerance, Math.abs(y2 - y1));
            }
            break;
        }
        case 'split':
            next.xGapTolerance = wma(next.xGapTolerance, Math.max(1, next.xGapTolerance - 2));
            break;
        case 'tag-change': {
            const tag = fix.after.tag;
            const size = fix.after.fontSize ?? fix.before.fontSize ?? 12;
            if (tag === 'h1')
                next.headingCutoffs[0] = wma(next.headingCutoffs[0], size);
            else if (tag === 'h2')
                next.headingCutoffs[1] = wma(next.headingCutoffs[1], size);
            else if (tag === 'h3')
                next.headingCutoffs[2] = wma(next.headingCutoffs[2], size);
            else if (tag === 'artifact')
                next.artifactThreshold = wma(next.artifactThreshold, Math.max(0.1, next.artifactThreshold - 0.05));
            else if (tag === 'p' && fix.after.isFirstLineIndented)
                next.firstLineIndentPx = wma(next.firstLineIndentPx, fix.after.styles?.textIndent ?? fix.before.styles?.textIndent ?? 0);
            break;
        }
        case 'delete':
            next.artifactThreshold = wma(next.artifactThreshold, Math.max(0.1, next.artifactThreshold - 0.03));
            break;
        case 'text-correct': {
            for (const [beforeChar, afterChar] of charPairs(fix.before.text ?? '', fix.after.text ?? ''))
                next.encodingMap[beforeChar] = afterChar;
            break;
        }
        case 'style-change': {
            const indent = fix.after.styles?.textIndent;
            if (typeof indent === 'number') {
                next.firstLineIndentPx = wma(next.firstLineIndentPx, indent);
                next.defaultTextIndent = wma(next.defaultTextIndent, indent);
                const x = fix.after.x ?? fix.before.x ?? leftMarginPx;
                next.indentedParaXOffset = wma(next.indentedParaXOffset, x - leftMarginPx);
            }
            break;
        }
        case 'resize': break;
        case 'create-group': break;
    }
    await saveProfile(next);
    return next;
}
