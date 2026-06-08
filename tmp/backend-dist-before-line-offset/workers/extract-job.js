import { extractPDF } from "../services/extractor.js";
import { jobStore } from "../services/jobStore.js";
import { loadProfile } from "../services/profileStore.js";
import { ExtractionStatus } from "../types.js";
async function main() {
    const [, , jobId, dpiArg] = process.argv;
    if (!jobId) {
        throw new Error("Missing required jobId argument");
    }
    const dpi = Number(dpiArg ?? "150");
    if (!Number.isFinite(dpi) || dpi <= 0) {
        throw new Error(`Invalid DPI argument: ${dpiArg ?? "undefined"}`);
    }
    const job = await jobStore.getJob(jobId);
    if (!job) {
        throw new Error(`Job ${jobId} not found`);
    }
    const profile = await loadProfile(job.pdfFingerprint);
    await extractPDF(job, profile, dpi, { enableOcrValidation: Boolean(job.enableOcrValidation) });
}
void main()
    .then(() => {
    process.exitCode = 0;
})
    .catch(async (error) => {
    const [, , jobId] = process.argv;
    const message = error instanceof Error ? error.message : "Unknown extraction worker failure";
    console.error(`[extract-worker] ${message}`);
    if (jobId) {
        try {
            const job = await jobStore.getJob(jobId);
            if (job && job.status !== "done" && job.status !== "failed") {
                await jobStore.updateJob(jobId, {
                    status: ExtractionStatus.failed,
                    errorMessage: message
                });
            }
        }
        catch (updateError) {
            console.error("[extract-worker] unable to persist failure state:", updateError);
        }
    }
    process.exitCode = 1;
});
