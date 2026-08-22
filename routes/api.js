const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs/promises");
const os = require("os");
const crypto = require("crypto");

const { requireAuth } = require("../lib/firebaseAuth");
const { PLANS, getPlan, PLAN_IDS, isValidPlan } = require("../config/plans");
const { getResetWindow } = require("../config/reset");
const usageStore = require("../lib/usageStore");
const { estimateUsage } = require("../lib/usage");
const ffmpegEngine = require("../lib/ffmpegEngine");
const groq = require("../lib/groq");
const { validateEditPlan } = require("../lib/editPlanSchema");
const { JobQueue } = require("../lib/queue");

const router = express.Router();
const queue = new JobQueue({ concurrency: Number(process.env.RENDER_CONCURRENCY) || 1 });

// Express 4 does not forward a rejected promise from an async handler to the
// error middleware — an unexpected throw would otherwise just hang the
// request. Wrap every async route handler with this so failures always reach
// the centralized error boundary in server.js instead.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const UPLOAD_ROOT = path.join(os.tmpdir(), "gift-visuals-uploads");

const ALLOWED_VIDEO_MIME = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"]);
const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        const dir = path.join(UPLOAD_ROOT, req.draft.id);
        await fs.mkdir(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 4096 * 1024 * 1024, files: 70 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_VIDEO_MIME.has(file.mimetype) || ALLOWED_IMAGE_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("UNSUPPORTED_FILE_TYPE"));
    }
  },
});

/** @type {Map<string, { uid: string, createdAt: number, assets: Array }>} */
const drafts = new Map();
const DRAFT_TTL_MS = 6 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, draft] of drafts) {
    if (now - draft.createdAt > DRAFT_TTL_MS) {
      fs.rm(path.join(UPLOAD_ROOT, id), { recursive: true, force: true }).catch(() => {});
      drafts.delete(id);
    }
  }
}, 30 * 60 * 1000).unref();

function loadDraft(req, res, next) {
  const draft = drafts.get(req.params.draftId);
  if (!draft || draft.uid !== req.user.uid) {
    return res.status(404).json({ error: "This project could not be found.", code: "DRAFT_NOT_FOUND" });
  }
  req.draft = draft;
  next();
}

function publicError(res, status, message, code) {
  res.status(status).json({ error: message, code });
}

// ---- Public ----

router.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

router.get("/plans", (req, res) => {
  res.json({ plans: PLANS });
});

// ---- Auth-required ----

router.get("/usage", requireAuth(), (req, res) => {
  res.json(usageStore.getStatus(req.user.uid));
});

// Demo-only plan switch: there is no payment processor yet (per product spec,
// billing is a placeholder). This exists purely so plan-gated behavior
// (media limits, usage caps, priority) can be exercised end-to-end before
// real billing exists. It must be removed or protected once billing ships.
router.post("/dev/set-plan", requireAuth(), express.json(), (req, res) => {
  const { planId } = req.body || {};
  if (!isValidPlan(planId)) return publicError(res, 400, "Unknown plan.", "INVALID_PLAN");
  res.json(usageStore.setPlan(req.user.uid, planId));
});

router.post("/drafts", requireAuth(), (req, res) => {
  const id = crypto.randomUUID();
  drafts.set(id, { id, uid: req.user.uid, createdAt: Date.now(), assets: [] });
  res.json({ draftId: id });
});

router.post(
  "/drafts/:draftId/media",
  requireAuth(),
  (req, res, next) => {
    const draft = drafts.get(req.params.draftId);
    if (!draft || draft.uid !== req.user.uid) {
      return publicError(res, 404, "This project could not be found.", "DRAFT_NOT_FOUND");
    }
    req.draft = draft;
    next();
  },
  (req, res, next) => upload.array("media", 70)(req, res, (err) => {
    if (err) {
      if (err.message === "UNSUPPORTED_FILE_TYPE") {
        return publicError(res, 400, "Only MP4/MOV/WebM video and JPG/PNG/WebP images are supported.", "UNSUPPORTED_FILE_TYPE");
      }
      if (err.code === "LIMIT_FILE_SIZE") {
        return publicError(res, 400, "One of your files is too large for your current plan.", "FILE_TOO_LARGE");
      }
      return publicError(res, 400, "Upload failed.", "UPLOAD_FAILED");
    }
    next();
  }),
  asyncHandler(async (req, res) => {
    const plan = getPlan(usageStore.getStatus(req.user.uid).planId);
    const files = req.files || [];

    if (req.draft.assets.length + files.length > plan.mediaLimit) {
      await Promise.all(files.map((f) => fs.rm(f.path, { force: true })));
      return publicError(
        res,
        400,
        `Your ${plan.name} plan allows up to ${plan.mediaLimit} combined uploads.`,
        "MEDIA_LIMIT_EXCEEDED"
      );
    }

    const maxBytes = plan.maxUploadFileSizeMb * 1024 * 1024;
    const oversized = files.find((f) => f.size > maxBytes);
    if (oversized) {
      await Promise.all(files.map((f) => fs.rm(f.path, { force: true })));
      return publicError(res, 400, `Files must be under ${plan.maxUploadFileSizeMb}MB on your plan.`, "FILE_TOO_LARGE");
    }

    const newAssets = [];
    for (const file of files) {
      const isVideo = ALLOWED_VIDEO_MIME.has(file.mimetype);
      const asset = {
        id: crypto.randomUUID(),
        type: isVideo ? "video" : "image",
        originalName: file.originalname,
        path: file.path,
        sizeBytes: file.size,
        durationSeconds: 0,
        width: 0,
        height: 0,
        fps: 0,
      };
      if (isVideo) {
        try {
          const info = await ffmpegEngine.probe(file.path);
          Object.assign(asset, info);
        } catch {
          await fs.rm(file.path, { force: true });
          continue;
        }
      }
      newAssets.push(asset);
    }

    req.draft.assets.push(...newAssets);
    res.json({
      assets: req.draft.assets.map(stripInternalPaths),
      mediaLimit: plan.mediaLimit,
    });
  })
);

router.delete("/drafts/:draftId/media/:assetId", requireAuth(), loadDraft, asyncHandler(async (req, res) => {
  const idx = req.draft.assets.findIndex((a) => a.id === req.params.assetId);
  if (idx === -1) return publicError(res, 404, "Asset not found.", "ASSET_NOT_FOUND");
  const [removed] = req.draft.assets.splice(idx, 1);
  await fs.rm(removed.path, { force: true }).catch(() => {});
  res.json({ assets: req.draft.assets.map(stripInternalPaths) });
}));

router.post("/drafts/:draftId/reorder", requireAuth(), loadDraft, express.json(), (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return publicError(res, 400, "order must be an array of asset ids.", "BAD_REQUEST");
  const byId = new Map(req.draft.assets.map((a) => [a.id, a]));
  const reordered = order.map((id) => byId.get(id)).filter(Boolean);
  if (reordered.length !== req.draft.assets.length) {
    return publicError(res, 400, "order must include every existing asset exactly once.", "BAD_REQUEST");
  }
  req.draft.assets = reordered;
  res.json({ assets: req.draft.assets.map(stripInternalPaths) });
});

router.post("/drafts/:draftId/estimate", requireAuth(), loadDraft, express.json(), (req, res) => {
  const { options } = req.body || {};
  const estimate = estimateUsage({ assets: req.draft.assets, options, qualityCheckMaxPasses: 2 });
  const status = usageStore.getStatus(req.user.uid);
  res.json({ estimate, remainingUnits: status.remainingUnits, sufficientBalance: estimate.totalUnits <= status.remainingUnits });
});

router.post("/drafts/:draftId/render", requireAuth(), loadDraft, express.json(), asyncHandler(async (req, res) => {
  const { prompt, options, targetAspectRatio } = req.body || {};
  const uid = req.user.uid;

  if (req.draft.assets.length === 0) {
    return publicError(res, 400, "Upload at least one video or photo first.", "NO_MEDIA");
  }

  const plan = getPlan(usageStore.getStatus(uid).planId);
  const estimate = estimateUsage({ assets: req.draft.assets, options, qualityCheckMaxPasses: 2 });

  try {
    usageStore.assertCanConsume(uid, estimate.totalUnits);
  } catch (err) {
    if (err.code === "USAGE_LIMIT_EXCEEDED") {
      const { nextReset } = getResetWindow();
      return publicError(
        res,
        429,
        `You've used your weekly AI usage. It resets ${nextReset.toISOString()}.`,
        "USAGE_LIMIT_EXCEEDED"
      );
    }
    throw err;
  }

  const assetsSnapshot = req.draft.assets.map((a) => ({ ...a }));
  const job = queue.enqueue({
    priority: plan.priority,
    meta: { uid, draftId: req.draft.id, estimatedUnits: estimate.totalUnits },
    handler: (jobHandle) => processRenderJob({ jobHandle, uid, assets: assetsSnapshot, prompt, options, targetAspectRatio, plan, estimatedUnits: estimate.totalUnits }),
  });

  res.json({ jobId: job.id, status: job.status, estimatedUnits: estimate.totalUnits, priority: plan.priority });
}));

router.get("/jobs/:jobId", requireAuth(), (req, res) => {
  const job = queue.getJob(req.params.jobId);
  if (!job || job.meta.uid !== req.user.uid) return publicError(res, 404, "Job not found.", "JOB_NOT_FOUND");
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    result: job.result ? { durationSeconds: job.result.durationSeconds, usageConsumed: job.result.usageConsumed } : null,
  });
});

router.get("/jobs/:jobId/download", requireAuth(), (req, res) => {
  const job = queue.getJob(req.params.jobId);
  if (!job || job.meta.uid !== req.user.uid) return publicError(res, 404, "Job not found.", "JOB_NOT_FOUND");
  if (job.status !== "completed" || !job.result?.outputPath) {
    return publicError(res, 400, "This video isn't ready yet.", "JOB_NOT_READY");
  }
  res.download(job.result.outputPath, "gift-visuals-edit.mp4");
});

async function processRenderJob({ jobHandle, uid, assets, prompt, options, targetAspectRatio, plan, estimatedUnits }) {
  queue.updateProgress(jobHandle.id, 5);
  const assetsById = new Map(assets.map((a) => [a.id, { path: a.path, type: a.type }]));

  let transcript = null;
  const firstVideoWithAudio = assets.find((a) => a.type === "video" && a.hasAudio);
  if (firstVideoWithAudio) {
    try {
      const result = await groq.transcribe(firstVideoWithAudio.path);
      transcript = result;
    } catch (err) {
      transcript = null; // Non-fatal: the AI edits without a transcript instead of failing the job.
    }
  }
  queue.updateProgress(jobHandle.id, 25);

  const context = {
    assets: assets.map((a) => ({
      id: a.id,
      type: a.type,
      durationSeconds: a.durationSeconds,
      width: a.width,
      height: a.height,
      fps: a.fps,
    })),
    transcript,
    userPrompt: prompt || null,
    editingOptions: options || {},
    targetAspectRatio: targetAspectRatio || "original",
  };

  const maxPasses = 2;
  let lastError = null;
  for (let pass = 1; pass <= maxPasses; pass++) {
    try {
      const rawPlan = await groq.generateEditPlan(context);
      const { valid, errors, plan: validatedPlan } = validateEditPlan(rawPlan, {
        assetIds: assets.map((a) => a.id),
        maxOutputSeconds: plan.maxOutputSeconds,
      });
      if (!valid) throw new Error(`AI edit plan failed validation: ${errors.join("; ")}`);

      queue.updateProgress(jobHandle.id, 45);
      const rendered = await ffmpegEngine.renderEditPlan({
        plan: validatedPlan,
        assetsById,
        jobId: jobHandle.id,
      });
      queue.updateProgress(jobHandle.id, 85);

      const qc = await groq.qualityCheck({
        durationSeconds: rendered.durationSeconds,
        requestedDurationSeconds: validatedPlan.output.durationSeconds,
        pass,
      }).catch(() => ({ pass: true }));

      if (qc.pass || pass === maxPasses) {
        usageStore.consume(uid, estimatedUnits);
        queue.updateProgress(jobHandle.id, 100);
        return { outputPath: rendered.outputPath, durationSeconds: rendered.durationSeconds, usageConsumed: estimatedUnits };
      }
      await ffmpegEngine.cleanupWorkDir(rendered.workDir);
    } catch (err) {
      lastError = err;
    }
  }

  const failure = new Error(lastError ? lastError.message : "Render failed after retries.");
  failure.userMessage = "We couldn't finish this video. Please try again.";
  throw failure;
}

function stripInternalPaths(asset) {
  const { path: _p, ...rest } = asset;
  return rest;
}

module.exports = router;
