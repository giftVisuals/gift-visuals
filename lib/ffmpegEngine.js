// Safe execution engine: translates a VALIDATED edit-plan JSON object into
// real ffmpeg operations. The AI never touches this layer directly — it only
// ever produces JSON (see lib/groq.js + lib/editPlanSchema.js). Every ffmpeg
// invocation here uses execFile with an argument array — never a shell
// string — so there is no command-injection surface even from
// attacker-controlled filenames or caption text.

const { execFile } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 64, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`${bin} failed: ${err.message}`);
        e.stderr = stderr;
        reject(e);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function probe(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const data = JSON.parse(stdout);
  const videoStream = (data.streams || []).find((s) => s.codec_type === "video");
  const audioStream = (data.streams || []).find((s) => s.codec_type === "audio");
  const durationSeconds = Number(data.format?.duration) || (videoStream ? Number(videoStream.duration) : 0) || 0;

  let fps = 30;
  if (videoStream?.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
    if (den) fps = num / den;
  }

  return {
    durationSeconds,
    width: videoStream?.width || 0,
    height: videoStream?.height || 0,
    fps,
    hasAudio: Boolean(audioStream),
  };
}

const RESOLUTIONS = {
  "480p": { w: 854, h: 480 },
  "720p": { w: 1280, h: 720 },
  "1080p": { w: 1920, h: 1080 },
  "4k": { w: 3840, h: 2160 },
};

function targetDimensions(resolutionKey, aspectRatio) {
  const base = RESOLUTIONS[resolutionKey] || RESOLUTIONS["1080p"];
  if (aspectRatio === "9:16") return { w: base.h, h: base.w };
  if (aspectRatio === "1:1") return { w: base.h, h: base.h };
  return { w: base.w, h: base.h }; // "original" and "16:9" both target the standard landscape frame
}

function scaleCropFilter(w, h) {
  // Scale to cover the target box, then center-crop — avoids letterboxing
  // while preserving as much of the frame as possible.
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
}

async function makeWorkDir(jobId) {
  const dir = path.join(os.tmpdir(), "gift-visuals", jobId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Renders one plan "cut" (a trimmed, optionally sped-up/zoomed segment of a source video) into a normalized clip. */
async function renderVideoSegment({ sourcePath, start, end, speedFactor = 1, zoom, targetW, targetH, fps, outPath }) {
  const duration = end - start;
  const filters = [];

  filters.push(scaleCropFilter(targetW, targetH));

  const hasZoom = Boolean(zoom && zoom.scale > 1);
  if (hasZoom) {
    // zoompan's `d` normally holds/repeats each input frame `d` times (the
    // Ken Burns-on-a-still-image pattern used in renderImageSegment). For a
    // continuous zoom over live footage we need it to pass every frame
    // through once instead — d=1 — while driving the zoom level off `on`
    // (the output frame counter), so the animation still tracks real time.
    // zoompan already fixes the output framerate via its own `fps` option —
    // chaining a second `fps` filter after it corrupts duration metadata, so
    // we deliberately don't add one below when zoom is active.
    const totalFrames = Math.max(1, Math.round(duration * fps));
    const growth = (zoom.scale - 1).toFixed(6);
    filters.push(
      `zoompan=z='min(1+${growth}*on/${totalFrames},${zoom.scale})':d=1:s=${targetW}x${targetH}:fps=${fps}`
    );
  }

  if (speedFactor !== 1) {
    filters.push(`setpts=${(1 / speedFactor).toFixed(6)}*PTS`);
  }
  if (!hasZoom) {
    filters.push(`fps=${fps}`);
  }

  const audioFilters = speedFactor !== 1 ? [`atempo=${clampAtempo(speedFactor)}`] : [];

  const args = [
    "-y",
    "-ss", String(start),
    "-t", String(duration),
    "-i", sourcePath,
    "-vf", filters.join(","),
    ...(audioFilters.length ? ["-af", audioFilters.join(",")] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-ar", "48000",
    "-pix_fmt", "yuv420p",
    outPath,
  ];
  await run("ffmpeg", args);
}

function clampAtempo(factor) {
  // atempo only supports 0.5-2.0 per instance; values outside that are chained.
  return Math.min(Math.max(factor, 0.5), 2).toFixed(3);
}

/** Renders a still image into a short video clip (with a subtle Ken Burns zoom when aiMotion is on). */
async function renderImageSegment({ imagePath, durationSeconds, targetW, targetH, fps, aiMotion, outPath }) {
  const frames = Math.max(1, Math.round(durationSeconds * fps));
  const base = scaleCropFilter(targetW * 2, targetH * 2); // upscale first so zoompan has room to move
  const motion = aiMotion
    ? `zoompan=z='min(zoom+0.0008,1.15)':d=${frames}:s=${targetW}x${targetH}:fps=${fps}`
    : `zoompan=z=1:d=${frames}:s=${targetW}x${targetH}:fps=${fps}`;

  const args = [
    "-y",
    "-loop", "1",
    "-i", imagePath,
    "-t", String(durationSeconds),
    "-vf", `${base},${motion},format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-an",
    outPath,
  ];
  await run("ffmpeg", args);

  // Add a silent audio track so concat has a consistent stream layout across all segments.
  const withAudioPath = outPath.replace(/\.mp4$/, ".withaudio.mp4");
  await run("ffmpeg", [
    "-y",
    "-i", outPath,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-shortest",
    "-c:v", "copy",
    "-c:a", "aac",
    withAudioPath,
  ]);
  await fs.rename(withAudioPath, outPath);
}

async function writeSrt(captions, outPath) {
  const toTimestamp = (s) => {
    const ms = Math.round(s * 1000);
    const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
    const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
    const msec = String(ms % 1000).padStart(3, "0");
    return `${h}:${m}:${sec},${msec}`;
  };
  const body = captions
    .map((c, i) => `${i + 1}\n${toTimestamp(c.start)} --> ${toTimestamp(c.end)}\n${c.text}\n`)
    .join("\n");
  await fs.writeFile(outPath, body, "utf8");
}

const COLOR_FILTERS = {
  none: null,
  warm: "eq=gamma_r=1.05:gamma_b=0.95:saturation=1.1",
  cool: "eq=gamma_b=1.05:gamma_r=0.95:saturation=1.05",
  cinematic: "eq=contrast=1.08:saturation=0.92:gamma=0.97",
  vibrant: "eq=saturation=1.35:contrast=1.05",
};

/**
 * Executes a validated edit plan end-to-end and produces a final rendered file.
 * @param {object} params
 * @param {object} params.plan - validated plan from lib/editPlanSchema.js
 * @param {Map<string,{path:string,type:'video'|'image'}>} params.assetsById
 * @param {string} params.jobId
 * @param {string} [params.musicPath]
 * @returns {Promise<{ outputPath: string, workDir: string, durationSeconds: number }>}
 */
async function renderEditPlan({ plan, assetsById, jobId, musicPath }) {
  const workDir = await makeWorkDir(jobId);
  const { w: targetW, h: targetH } = targetDimensions(plan.output.resolution, plan.project.aspectRatio);
  const fps = plan.output.fps;

  const timeline = buildTimeline(plan, assetsById);
  if (timeline.length === 0) throw new EngineError("Edit plan produced no renderable segments.");

  const segmentPaths = [];
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    const outPath = path.join(workDir, `seg-${String(i).padStart(3, "0")}.mp4`);
    if (item.kind === "video") {
      await renderVideoSegment({
        sourcePath: item.sourcePath,
        start: item.start,
        end: item.end,
        speedFactor: item.speedFactor,
        zoom: item.zoom,
        targetW,
        targetH,
        fps,
        outPath,
      });
    } else {
      await renderImageSegment({
        imagePath: item.sourcePath,
        durationSeconds: item.durationSeconds,
        targetW,
        targetH,
        fps,
        aiMotion: item.aiMotion,
        outPath,
      });
    }
    segmentPaths.push(outPath);
  }

  const concatPath = path.join(workDir, "concat.mp4");
  await concatSegments(segmentPaths, plan.transitions, concatPath, workDir);

  let currentPath = concatPath;

  if (plan.captions.length > 0) {
    const srtPath = path.join(workDir, "captions.srt");
    await writeSrt(plan.captions, srtPath);
    const captionedPath = path.join(workDir, "captioned.mp4");
    const escapedSrt = srtPath.replace(/([\\':])/g, "\\$1");
    await run("ffmpeg", [
      "-y", "-i", currentPath,
      "-vf", `subtitles=${escapedSrt}:force_style='FontName=Arial,FontSize=20,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=2,Alignment=2'`,
      "-c:a", "copy",
      captionedPath,
    ]);
    currentPath = captionedPath;
  }

  const colorFilter = COLOR_FILTERS[plan.color.treatment];
  if (colorFilter) {
    const colorPath = path.join(workDir, "color.mp4");
    await run("ffmpeg", ["-y", "-i", currentPath, "-vf", colorFilter, "-c:a", "copy", colorPath]);
    currentPath = colorPath;
  }

  if (plan.audio.voiceEnhancement) {
    const enhancedPath = path.join(workDir, "voice-enhanced.mp4");
    await run("ffmpeg", [
      "-y", "-i", currentPath,
      "-af", "afftdn=nr=12,loudnorm=I=-16:TP=-1.5:LRA=11",
      "-c:v", "copy",
      enhancedPath,
    ]);
    currentPath = enhancedPath;
  }

  if (plan.audio.music && musicPath) {
    const mixedPath = path.join(workDir, "mixed.mp4");
    const musicVolume = plan.audio.musicVolume;
    const duckFilter = plan.audio.ducking
      ? `[1:a]volume=${musicVolume}[music];[0:a][music]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=200[aout]`
      : `[1:a]volume=${musicVolume}[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`;
    await run("ffmpeg", [
      "-y",
      "-i", currentPath,
      "-i", musicPath,
      "-filter_complex", duckFilter,
      "-map", "0:v",
      "-map", "[aout]",
      "-c:v", "copy",
      mixedPath,
    ]);
    currentPath = mixedPath;
  }

  const finalPath = path.join(workDir, `final-${jobId}.mp4`);
  await run("ffmpeg", [
    "-y", "-i", currentPath,
    "-c:v", "libx264", "-preset", "medium", "-crf", "19",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    finalPath,
  ]);

  const finalInfo = await probe(finalPath);
  return { outputPath: finalPath, workDir, durationSeconds: finalInfo.durationSeconds };
}

/** Flattens the validated plan into an ordered list of renderable segments. */
function buildTimeline(plan, assetsById) {
  const timeline = [];

  for (const cut of plan.cuts) {
    const asset = assetsById.get(cut.assetId);
    if (!asset || asset.type !== "video") continue;
    const speedChange = plan.speedChanges.find(
      (s) => s.assetId === cut.assetId && s.start <= cut.start && s.end >= cut.end
    );
    const zoom = plan.zooms.find((z) => z.assetId === cut.assetId && z.start <= cut.start && z.end >= cut.end);
    timeline.push({
      kind: "video",
      sourcePath: asset.path,
      start: cut.start,
      end: cut.end,
      speedFactor: speedChange ? speedChange.factor : 1,
      zoom: zoom || null,
    });
  }

  for (const image of plan.images) {
    const asset = assetsById.get(image.assetId);
    if (!asset || asset.type !== "image") continue;
    timeline.splice(Math.min(image.insertAt, timeline.length), 0, {
      kind: "image",
      sourcePath: asset.path,
      durationSeconds: image.durationSeconds,
      aiMotion: true,
    });
  }

  return timeline;
}

async function concatSegments(segmentPaths, transitions, outPath, workDir) {
  const hasCrossfade = transitions.some((t) => t.type === "crossfade" || t.type === "fade");

  if (!hasCrossfade || segmentPaths.length === 1) {
    const listPath = path.join(workDir, "concat-list.txt");
    const listBody = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    await fs.writeFile(listPath, listBody, "utf8");
    await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath]);
    return;
  }

  // Crossfade path: chain xfade/acrossfade across all segments sequentially.
  let currentPath = segmentPaths[0];
  const transitionDuration = 0.5;
  for (let i = 1; i < segmentPaths.length; i++) {
    const nextPath = segmentPaths[i];
    const durA = (await probe(currentPath)).durationSeconds;
    const offset = Math.max(0, durA - transitionDuration);
    const stepOut = path.join(workDir, `xfade-${i}.mp4`);
    await run("ffmpeg", [
      "-y",
      "-i", currentPath,
      "-i", nextPath,
      "-filter_complex",
      `[0:v][1:v]xfade=transition=fade:duration=${transitionDuration}:offset=${offset}[v];` +
        `[0:a][1:a]acrossfade=d=${transitionDuration}[a]`,
      "-map", "[v]",
      "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac",
      stepOut,
    ]);
    currentPath = stepOut;
  }
  await fs.copyFile(currentPath, outPath);
}

async function extractAudio(filePath, outPath) {
  await run("ffmpeg", ["-y", "-i", filePath, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", outPath]);
}

async function cleanupWorkDir(workDir) {
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
}

/** Removes every intermediate render file in workDir except the one given (the final output). */
async function cleanupIntermediates(workDir, keepPath) {
  const entries = await fs.readdir(workDir).catch(() => []);
  await Promise.all(
    entries.map((name) => {
      const full = path.join(workDir, name);
      if (full === keepPath) return Promise.resolve();
      return fs.rm(full, { recursive: true, force: true }).catch(() => {});
    })
  );
}

class EngineError extends Error {}

module.exports = { probe, extractAudio, renderEditPlan, cleanupWorkDir, cleanupIntermediates, targetDimensions, buildTimeline, EngineError };
