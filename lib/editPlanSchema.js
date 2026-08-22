// Structured validation for AI-generated edit plans.
//
// The AI (Groq) NEVER generates shell commands or ffmpeg arguments directly.
// It generates JSON matching this schema. This module is the gate: nothing
// reaches lib/ffmpegEngine.js that hasn't been validated field-by-field here.

const ASPECT_RATIOS = new Set(["original", "16:9", "9:16", "1:1"]);
const STYLES = new Set(["ai-decide", "social", "cinematic", "fast-paced", "professional"]);

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function fail(errors, msg) {
  errors.push(msg);
}

/**
 * Validates and normalizes a raw edit-plan object.
 * @returns {{ valid: boolean, errors: string[], plan?: object }}
 */
function validateEditPlan(raw, context = {}) {
  const errors = [];
  const assetIds = new Set(context.assetIds || []);
  const maxOutputSeconds = context.maxOutputSeconds ?? Infinity;

  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["Edit plan must be an object."] };
  }

  const project = raw.project || {};
  const style = STYLES.has(project.style) ? project.style : "ai-decide";
  const aspectRatio = ASPECT_RATIOS.has(project.aspectRatio) ? project.aspectRatio : "original";

  const cuts = Array.isArray(raw.cuts) ? raw.cuts.filter((c) => validateCut(c, assetIds, errors)) : [];
  const zooms = Array.isArray(raw.zooms) ? raw.zooms.filter((z) => validateZoom(z, assetIds, errors)) : [];
  const speedChanges = Array.isArray(raw.speedChanges)
    ? raw.speedChanges.filter((s) => validateSpeedChange(s, assetIds, errors))
    : [];
  const captions = Array.isArray(raw.captions) ? raw.captions.filter((c) => validateCaption(c, errors)) : [];
  const images = Array.isArray(raw.images) ? raw.images.filter((i) => validateImage(i, assetIds, errors)) : [];
  const transitions = Array.isArray(raw.transitions)
    ? raw.transitions.filter((t) => validateTransition(t, errors))
    : [];

  const audio = validateAudio(raw.audio, errors);
  const color = validateColor(raw.color, errors);
  const output = validateOutput(raw.output, errors, maxOutputSeconds);

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    plan: { project: { style, aspectRatio }, cuts, zooms, speedChanges, captions, images, transitions, audio, color, output },
  };
}

function validateCut(c, assetIds, errors) {
  if (!c || !assetIds.has(c.assetId)) return fail(errors, "cuts[]: unknown assetId"), false;
  if (!isFiniteNumber(c.start) || !isFiniteNumber(c.end) || c.end <= c.start) {
    return fail(errors, "cuts[]: start/end must be numbers with end > start"), false;
  }
  return true;
}

function validateZoom(z, assetIds, errors) {
  if (!z || !assetIds.has(z.assetId)) return fail(errors, "zooms[]: unknown assetId"), false;
  if (!isFiniteNumber(z.start) || !isFiniteNumber(z.end) || z.end <= z.start) {
    return fail(errors, "zooms[]: invalid time range"), false;
  }
  if (!isFiniteNumber(z.scale) || z.scale < 1 || z.scale > 3) {
    return fail(errors, "zooms[]: scale must be between 1 and 3"), false;
  }
  return true;
}

function validateSpeedChange(s, assetIds, errors) {
  if (!s || !assetIds.has(s.assetId)) return fail(errors, "speedChanges[]: unknown assetId"), false;
  if (!isFiniteNumber(s.start) || !isFiniteNumber(s.end) || s.end <= s.start) {
    return fail(errors, "speedChanges[]: invalid time range"), false;
  }
  if (!isFiniteNumber(s.factor) || s.factor < 0.25 || s.factor > 4) {
    return fail(errors, "speedChanges[]: factor must be between 0.25 and 4"), false;
  }
  return true;
}

function validateCaption(c, errors) {
  if (!c || typeof c.text !== "string" || c.text.length === 0 || c.text.length > 200) {
    return fail(errors, "captions[]: text required, max 200 chars"), false;
  }
  if (!isFiniteNumber(c.start) || !isFiniteNumber(c.end) || c.end <= c.start) {
    return fail(errors, "captions[]: invalid time range"), false;
  }
  return true;
}

function validateImage(i, assetIds, errors) {
  if (!i || !assetIds.has(i.assetId)) return fail(errors, "images[]: unknown assetId"), false;
  if (!isFiniteNumber(i.insertAt) || i.insertAt < 0) return fail(errors, "images[]: invalid insertAt"), false;
  if (!isFiniteNumber(i.durationSeconds) || i.durationSeconds <= 0 || i.durationSeconds > 30) {
    return fail(errors, "images[]: durationSeconds must be 0-30s"), false;
  }
  return true;
}

const TRANSITION_TYPES = new Set(["cut", "fade", "crossfade", "slide", "wipe"]);
function validateTransition(t, errors) {
  if (!t || !TRANSITION_TYPES.has(t.type)) return fail(errors, "transitions[]: invalid type"), false;
  if (!isFiniteNumber(t.atSecond) || t.atSecond < 0) return fail(errors, "transitions[]: invalid atSecond"), false;
  const duration = isFiniteNumber(t.durationSeconds) ? Math.min(Math.max(t.durationSeconds, 0.1), 2) : 0.5;
  t.durationSeconds = duration;
  return true;
}

function validateAudio(a, errors) {
  const audio = a && typeof a === "object" ? a : {};
  return {
    ducking: Boolean(audio.ducking),
    voiceEnhancement: Boolean(audio.voiceEnhancement),
    music: Boolean(audio.music),
    musicVolume: isFiniteNumber(audio.musicVolume) ? Math.min(Math.max(audio.musicVolume, 0), 1) : 0.25,
    soundEffects: Boolean(audio.soundEffects),
  };
}

function validateColor(c, errors) {
  const color = c && typeof c === "object" ? c : {};
  const treatment = ["none", "warm", "cool", "cinematic", "vibrant"].includes(color.treatment)
    ? color.treatment
    : "none";
  return { treatment };
}

function validateOutput(o, errors, maxOutputSeconds) {
  const out = o && typeof o === "object" ? o : {};
  const resolution = ["480p", "720p", "1080p", "4k"].includes(out.resolution) ? out.resolution : "1080p";
  const fps = [24, 25, 30, 60].includes(out.fps) ? out.fps : 30;
  let durationSeconds = isFiniteNumber(out.durationSeconds) ? out.durationSeconds : null;
  if (durationSeconds !== null && durationSeconds > maxOutputSeconds) {
    fail(errors, `output.durationSeconds exceeds plan limit of ${maxOutputSeconds}s`);
  }
  return { resolution, fps, durationSeconds };
}

module.exports = { validateEditPlan, ASPECT_RATIOS, STYLES };
