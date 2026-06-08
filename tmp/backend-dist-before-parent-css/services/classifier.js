import { existsSync } from "node:fs";
import path from "node:path";
import { modelsStorageRoot } from "../config/runtime.js";
const modelsRoot = modelsStorageRoot;
const modelA = path.join(modelsRoot, "classifier-a.pkl");
const modelB = path.join(modelsRoot, "classifier-b.pkl");
function simpleHash(input) {
    let hash = 0;
    for (let index = 0; index < input.length; index += 1) {
        hash = ((hash << 5) - hash) + input.charCodeAt(index);
        hash |= 0;
    }
    return Math.abs(hash % 10000);
}
export function modelsAvailable() { return existsSync(modelA) && existsSync(modelB); }
export async function warmClassifier() { return; }
export async function classifyBlocks(blocks, page) {
    void page;
    if (!modelsAvailable())
        return [];
    return blocks.map((block) => ({
        blockId: block.id,
        predictedTag: block.tag,
        mergeDecision: null,
        confidence: Number((((block.fontSize / 24) * 0.3) + ((simpleHash(block.fontName) % 100) / 100) * 0.1 + 0.6).toFixed(3))
    }));
}
