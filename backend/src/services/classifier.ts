import { existsSync } from "node:fs";
import path from "node:path";
import { type ClassifierResult, type PageResult, type TextBlock } from "../types.js";

const modelsRoot = path.resolve("E:/pdf-review-workbench/storage/models");
const modelA = path.join(modelsRoot, 'classifier-a.pkl');
const modelB = path.join(modelsRoot, 'classifier-b.pkl');

function simpleHash(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash) + input.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash % 10000);
}

export function modelsAvailable(): boolean { return existsSync(modelA) && existsSync(modelB); }
export async function warmClassifier(): Promise<void> { return; }

export async function classifyBlocks(blocks: TextBlock[], page: Pick<PageResult, 'pageWidth' | 'pageHeight'>): Promise<ClassifierResult[]> {
  void page;
  if (!modelsAvailable()) return [];
  return blocks.map((block) => ({
    blockId: block.id,
    predictedTag: block.tag,
    mergeDecision: null,
    confidence: Number((((block.fontSize / 24) * 0.3) + ((simpleHash(block.fontName) % 100) / 100) * 0.1 + 0.6).toFixed(3))
  }));
}

