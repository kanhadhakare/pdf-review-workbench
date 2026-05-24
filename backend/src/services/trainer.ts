import { spawn } from "node:child_process";
import path from "node:path";
import { type TrainingStatus } from "../types.js";
import { getFixCount } from "./fixStore.js";

const fixesRoot = path.resolve("E:/pdf-review-workbench/storage/fixes");
const modelsRoot = path.resolve("E:/pdf-review-workbench/storage/models");
const scriptPath = path.resolve("E:/pdf-review-workbench/backend/src/scripts/train_classifiers.py");

const state: TrainingStatus = { isTraining: false, lastTrainedAt: null, fixCountAtLastTrain: 0, totalFixes: 0, nextTrainAt: 50 };

export async function shouldTrain(): Promise<boolean> {
  const totalFixes = await getFixCount();
  state.totalFixes = totalFixes;
  state.nextTrainAt = totalFixes === 0 ? 50 : Math.ceil(totalFixes / 50) * 50;
  return totalFixes > 0 && totalFixes % 50 === 0 && !state.isTraining;
}

export async function triggerTraining(): Promise<boolean> {
  if (!(await shouldTrain())) return false;
  state.isTraining = true;
  return new Promise<boolean>((resolve) => {
    const child = spawn('python', [scriptPath, fixesRoot, modelsRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => process.stdout.write(`[trainer] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`[trainer] ${chunk}`));
    child.on('exit', async (code) => {
      state.isTraining = false;
      if (code === 0) {
        state.lastTrainedAt = new Date().toISOString();
        state.fixCountAtLastTrain = await getFixCount();
        state.totalFixes = state.fixCountAtLastTrain;
        state.nextTrainAt = state.fixCountAtLastTrain + 50;
        resolve(true);
        return;
      }
      resolve(false);
    });
    child.on('error', () => { state.isTraining = false; resolve(false); });
  });
}

export function getTrainingStatus(): TrainingStatus { return { ...state }; }

