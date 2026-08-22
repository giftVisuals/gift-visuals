// AI Usage Unit (AUU) estimation.
//
// Gift Visuals does NOT charge per-video. It charges per unit of actual AI
// compute/processing difficulty. This module is the single source of truth
// for that calculation so the cost model can be tuned without touching
// routes or the render pipeline.
//
// The formula below is intentionally simple and tunable — swap the WEIGHTS
// constants as real render telemetry comes in.

const WEIGHTS = Object.freeze({
  perSecondOfFootage: 0.6,
  perAsset: 4,
  perImageAsset: 1.5,
  resolutionMultiplier: {
    sd: 1,
    hd: 1.3,
    fhd: 1.8,
    uhd4k: 3.2,
  },
  fpsMultiplier: {
    low: 1, // <=30fps
    high: 1.2, // >30fps
  },
  transcriptionPerSecond: 0.15,
  sceneAnalysisPerAsset: 3,
  captionsFlat: 5,
  smartCutsFlat: 6,
  aiMotionFlat: 8,
  voiceEnhancementFlat: 4,
  musicFlat: 2,
  soundEffectsFlat: 3,
  qualityCheckPassFlat: 5,
});

function resolutionBucket(width = 0, height = 0) {
  const pixels = width * height;
  if (pixels >= 3840 * 2160 * 0.9) return "uhd4k";
  if (pixels >= 1920 * 1080 * 0.9) return "fhd";
  if (pixels >= 1280 * 720 * 0.9) return "hd";
  return "sd";
}

/**
 * @param {object} job
 * @param {Array<{type:'video'|'image', durationSeconds?:number, width?:number, height?:number, fps?:number}>} job.assets
 * @param {object} job.options - editing options selected by the user (captions, smartCuts, aiMotion, voiceEnhancement, music, soundEffects)
 * @param {number} [job.qualityCheckMaxPasses]
 * @returns {{ totalUnits: number, breakdown: object }}
 */
function estimateUsage(job) {
  const assets = job.assets || [];
  const options = job.options || {};

  let totalDurationSeconds = 0;
  let maxResBucket = "sd";
  let hasHighFps = false;
  let videoCount = 0;
  let imageCount = 0;

  const resOrder = ["sd", "hd", "fhd", "uhd4k"];

  for (const asset of assets) {
    if (asset.type === "video") {
      videoCount += 1;
      totalDurationSeconds += Number(asset.durationSeconds) || 0;
      const bucket = resolutionBucket(asset.width, asset.height);
      if (resOrder.indexOf(bucket) > resOrder.indexOf(maxResBucket)) maxResBucket = bucket;
      if ((asset.fps || 0) > 30) hasHighFps = true;
    } else if (asset.type === "image") {
      imageCount += 1;
    }
  }

  const footageCost = totalDurationSeconds * WEIGHTS.perSecondOfFootage;
  const assetCost = assets.length * WEIGHTS.perAsset;
  const imageCost = imageCount * WEIGHTS.perImageAsset;
  const resMultiplier = WEIGHTS.resolutionMultiplier[maxResBucket];
  const fpsMultiplier = hasHighFps ? WEIGHTS.fpsMultiplier.high : WEIGHTS.fpsMultiplier.low;
  const transcriptionCost = totalDurationSeconds * WEIGHTS.transcriptionPerSecond;
  const sceneAnalysisCost = assets.length * WEIGHTS.sceneAnalysisPerAsset;

  let featureCost = 0;
  if (options.captions) featureCost += WEIGHTS.captionsFlat;
  if (options.smartCuts) featureCost += WEIGHTS.smartCutsFlat;
  if (options.aiMotion) featureCost += WEIGHTS.aiMotionFlat;
  if (options.voiceEnhancement) featureCost += WEIGHTS.voiceEnhancementFlat;
  if (options.music) featureCost += WEIGHTS.musicFlat;
  if (options.soundEffects) featureCost += WEIGHTS.soundEffectsFlat;

  const qualityCheckCost = WEIGHTS.qualityCheckPassFlat * Math.max(1, job.qualityCheckMaxPasses || 1);

  const base = footageCost + assetCost + imageCost + transcriptionCost + sceneAnalysisCost + featureCost + qualityCheckCost;
  const totalUnits = Math.ceil(base * resMultiplier * fpsMultiplier);

  return {
    totalUnits,
    breakdown: {
      footageCost: round(footageCost),
      assetCost: round(assetCost),
      imageCost: round(imageCost),
      transcriptionCost: round(transcriptionCost),
      sceneAnalysisCost: round(sceneAnalysisCost),
      featureCost: round(featureCost),
      qualityCheckCost: round(qualityCheckCost),
      resMultiplier,
      fpsMultiplier,
      videoCount,
      imageCount,
      totalDurationSeconds: round(totalDurationSeconds),
      maxResBucket,
    },
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { estimateUsage, WEIGHTS };
