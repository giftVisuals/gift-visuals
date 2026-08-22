// Groq API wrapper.
//
// Groq is the AI reasoning layer (chat completion -> structured edit plan)
// AND hosts a Whisper-compatible transcription endpoint used as the
// "hearing" layer. Never hardcode the API key — GROQ_API_KEY must come from
// the environment (Railway variables in production).

const GROQ_API_BASE = "https://api.groq.com/openai/v1";
const REASONING_MODEL = process.env.GROQ_REASONING_MODEL || "llama-3.3-70b-versatile";
const TRANSCRIPTION_MODEL = process.env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3";

function getApiKey() {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    const err = new Error("GROQ_API_KEY is not configured on the server.");
    err.code = "MISSING_GROQ_KEY";
    throw err;
  }
  return key;
}

/**
 * Transcribes an audio/video file's speech using Groq's Whisper-compatible endpoint.
 * @param {string} filePath - path to an audio or video file on disk
 * @returns {Promise<{ text: string, segments: Array<{start:number,end:number,text:string}> }>}
 */
async function transcribe(filePath) {
  const fs = require("fs");
  const apiKey = getApiKey();

  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(filePath)]), require("path").basename(filePath));
  form.append("model", TRANSCRIPTION_MODEL);
  form.append("response_format", "verbose_json");

  const res = await fetch(`${GROQ_API_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq transcription failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const segments = Array.isArray(data.segments)
    ? data.segments.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }))
    : [];

  return { text: data.text || "", segments };
}

const EDIT_PLAN_SYSTEM_PROMPT = `You are a professional video editor's brain inside Gift Visuals, an AI video editing platform.
You receive structured context about a user's uploaded media (videos and images), any speech transcript, and their creative
direction. You must output ONLY a single JSON object describing an edit plan — no prose, no markdown fences.

Rules:
- Prefer professional, purposeful editing over decoration. Do not add an effect unless it improves the result.
- Cut dead air and long silences when smartCuts is enabled.
- Use the transcript to time captions and emphasis, and to find natural sentence boundaries for cuts.
- Only reference assetId values that were given to you in the asset list.
- Every single asset in the asset list MUST end up somewhere in the final timeline — never silently drop one.
  - Assets with type "video" belong ONLY in "cuts" (a video asset id must never appear in "images").
  - Assets with type "image" belong ONLY in "images" (an image asset id must never appear in "cuts", "zooms", or "speedChanges" — images have no internal timeline to cut or speed up).
  - If there are no video assets at all, "cuts" MUST be an empty array and every image must still appear in "images" — build a slideshow entirely from the photos rather than returning nothing. A creative request implying motion or action that the photos can't literally show (e.g. "make them run") should be interpreted as a request for energetic pacing/zoom/music, not a reason to omit the images.
  - The plan is considered a failure if "cuts" and "images" are both empty while assets were provided.
- All time values for "cuts", "zooms", and "speedChanges" are in seconds relative to that SOURCE video asset's own timeline. All time values for "captions" are in seconds relative to the FINAL rendered timeline (i.e. after cuts/concatenation), starting at 0.
- Respect the requested aspect ratio and output constraints exactly.
- Output JSON with this exact shape (omit nothing, use empty arrays/defaults where not applicable):
{
  "project": { "style": "ai-decide|social|cinematic|fast-paced|professional", "aspectRatio": "original|16:9|9:16|1:1" },
  "cuts": [{ "assetId": "string", "start": 0, "end": 0 }],
  "zooms": [{ "assetId": "string", "start": 0, "end": 0, "scale": 1.2 }],
  "speedChanges": [{ "assetId": "string", "start": 0, "end": 0, "factor": 1.0 }],
  "captions": [{ "start": 0, "end": 0, "text": "string" }],
  "images": [{ "assetId": "string", "insertAt": 0, "durationSeconds": 3 }],
  "transitions": [{ "type": "cut|fade|crossfade|slide|wipe", "atSecond": 0, "durationSeconds": 0.5 }],
  "audio": { "ducking": false, "voiceEnhancement": false, "music": false, "musicVolume": 0.25, "soundEffects": false },
  "color": { "treatment": "none|warm|cool|cinematic|vibrant" },
  "output": { "resolution": "480p|720p|1080p|4k", "fps": 30, "durationSeconds": null }
}`;

/**
 * Asks Groq's reasoning model to produce a structured edit plan.
 * @param {object} context - { assets, transcript, userPrompt, editingOptions, targetAspectRatio }
 * @returns {Promise<object>} raw parsed JSON (NOT yet schema-validated — caller must validate)
 */
async function generateEditPlan(context) {
  const apiKey = getApiKey();

  const userMessage = JSON.stringify({
    assets: context.assets,
    transcript: context.transcript || null,
    creativeDirection: context.userPrompt || null,
    editingOptions: context.editingOptions || {},
    targetAspectRatio: context.targetAspectRatio || "original",
  });

  const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: REASONING_MODEL,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EDIT_PLAN_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq reasoning request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned an empty edit plan.");

  try {
    return JSON.parse(content);
  } catch {
    throw new Error("Groq returned an edit plan that was not valid JSON.");
  }
}

/**
 * Asks Groq to review a rendered result summary and decide pass/fail, optionally
 * suggesting a simplified plan adjustment. Used by the quality-check retry loop.
 */
async function qualityCheck(context) {
  const apiKey = getApiKey();
  const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: REASONING_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'You review whether a rendered video edit succeeded. Output ONLY JSON: {"pass": true|false, "reason": "string", "suggestedAdjustments": "string|null"}',
        },
        { role: "user", content: JSON.stringify(context) },
      ],
    }),
  });

  if (!res.ok) return { pass: true, reason: "Quality check unavailable; accepting render." };
  const data = await res.json();
  try {
    return JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch {
    return { pass: true, reason: "Quality check response unparsable; accepting render." };
  }
}

module.exports = { transcribe, generateEditPlan, qualityCheck, REASONING_MODEL, TRANSCRIPTION_MODEL };
