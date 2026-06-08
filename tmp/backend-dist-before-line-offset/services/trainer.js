import { spawn } from "node:child_process";
import { preferredPythonCommand, trainerScriptPath, fixesStorageRoot, modelsStorageRoot } from "../config/runtime.js";
import { getFixCount } from "./fixStore.js";
const fixesRoot = fixesStorageRoot;
const modelsRoot = modelsStorageRoot;
const scriptPath = trainerScriptPath;
const pythonCommand = preferredPythonCommand();
const state = { isTraining: false, lastTrainedAt: null, fixCountAtLastTrain: 0, totalFixes: 0, nextTrainAt: 50 };
export async function shouldTrain() {
    const totalFixes = await getFixCount();
    state.totalFixes = totalFixes;
    state.nextTrainAt = totalFixes === 0 ? 50 : Math.ceil(totalFixes / 50) * 50;
    return totalFixes > 0 && totalFixes % 50 === 0 && !state.isTraining;
}
export async function triggerTraining() {
    if (!(await shouldTrain()))
        return false;
    state.isTraining = true;
    return new Promise((resolve) => {
        const child = spawn(pythonCommand, [scriptPath, fixesRoot, modelsRoot], { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", (chunk) => process.stdout.write(`[trainer] ${chunk}`));
        child.stderr.on("data", (chunk) => process.stderr.write(`[trainer] ${chunk}`));
        child.on("exit", async (code) => {
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
        child.on("error", () => { state.isTraining = false; resolve(false); });
    });
}
export function getTrainingStatus() { return { ...state }; }
