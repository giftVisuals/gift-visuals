# Gift Visuals

AI-powered video creation and editing platform. Upload videos and photos, optionally tell it what you want, and Gift Visuals edits like a professional — smart cuts, captions, pacing, transitions, and HD rendering.

## Architecture

```
index.html        Frontend: landing, icon-first glass nav, Firebase auth, Create workspace,
                   Projects, Plans, Profile/Plan/Billing. Vanilla JS, no build step.
server.js          Express entry point. Serves the frontend + mounts the API.
routes/api.js       Upload, usage estimate, render, job status/download endpoints.
config/plans.js      Central plan definitions (media limits, weekly usage, priority).
config/reset.js      Weekly usage reset window, computed server-side in Africa/Lagos time.
lib/usage.js         AI Usage Unit (AUU) cost estimation for a render job.
lib/usageStore.js     Server-side usage ledger + enforcement (never trusts the client).
lib/firebaseAuth.js   Verifies Firebase ID tokens using Google's public JWKs — no
                       service-account key required or created.
lib/editPlanSchema.js  Validates the AI's structured edit-plan JSON before it ever
                        reaches ffmpeg.
lib/groq.js            Groq API wrapper: Whisper-compatible transcription + the
                        reasoning call that produces the edit plan.
lib/ffmpegEngine.js    Translates a validated edit plan into real ffmpeg operations
                        via execFile (argument arrays only — no shell, no arbitrary
                        commands).
lib/queue.js           In-memory priority job queue (Max > Pro > Free).
```

### Pipeline

Upload → ffprobe metadata → Whisper transcription (Groq) → Groq reasoning call
produces a structured edit plan → plan is schema-validated → ffmpeg renders
segments (cuts, speed changes, zooms, image-to-video with Ken Burns motion) →
concat/crossfade → caption burn-in → color treatment → voice enhancement /
music mixing → final encode → AI quality-check pass (retries once with a
fresh plan on failure, capped at 2 total passes) → download.

## What's fully working today

- Full pipeline runs end-to-end against real ffmpeg on this machine (verified — see Testing below): upload validation, ffprobe, cuts, speed ramps, zoom (Ken Burns on images), crossfade transitions, caption burn-in, color treatment presets, voice enhancement (noise reduction + loudness normalization), music mixing with optional ducking, aspect ratio conversion, final H.264/AAC encode with faststart.
- Firebase email/password + Google auth, logout, password reset, auth-state-aware UI, friendly auth error messages.
- Server-side ID token verification (no Admin SDK / no service-account key).
- Server-side usage ledger + weekly reset computed against Africa/Lagos (not the browser clock), enforced before any expensive processing starts.
- Central, single-source plan config (`config/plans.js`) — free/pro/max limits, priority, are read from one place everywhere.
- Priority job queue (Max > Pro > Free) with live progress/status polling.
- Icon-first glass navigation with fluid expand animation, no emoji anywhere in the UI.
- Anonymous browsing of every page; auth is only required at the moment of rendering.

## What needs your input before it's "done done"

- **GROQ_API_KEY** — required for transcription + the reasoning/edit-plan call. Without it, uploads and the UI work, but rendering fails with a friendly error (by design — it never fakes an AI response).
- **Computer-vision scene/face/object analysis** (item 3 in the spec) is intentionally not implemented — this build's "AI analyzes video" step is the Groq reasoning model working from transcript + technical metadata (duration/resolution/fps), not frame-level CV. Wiring real OpenCV/frame analysis in is a distinct, sizeable follow-up; nothing in the current UI claims it's doing this.
- **Persistence**: usage/plan/projects currently live in memory (documented in `lib/usageStore.js` and the API's draft store). They reset on server restart. Firestore wiring is the natural next step — the spec explicitly says database expansion can come later, and the code is structured so only the storage layer needs to change.
- **The `/api/dev/set-plan` endpoint** is a deliberate, labeled stand-in for real billing (there is no payment processor yet, per spec). Lock it down or remove it once payments exist.
- **Railway env vars**: `GROQ_API_KEY` (required), `PORT` (Railway sets this automatically), optionally `GROQ_REASONING_MODEL` / `GROQ_TRANSCRIPTION_MODEL` / `RENDER_CONCURRENCY` / `FIREBASE_PROJECT_ID`.
- **Railway builder**: the repo ships a `Dockerfile` that installs ffmpeg explicitly — Railway should auto-detect and use it. If your service was previously pinned to a different builder (Nixpacks/Railpack) in its Settings → Build, switch it to "Dockerfile" so ffmpeg actually gets installed; without it, rendering fails with `spawn ffmpeg ENOENT`.
- **Vercel**: `vercel.json` is present for compatibility, but Vercel's serverless functions do not ship an ffmpeg binary and enforce short execution limits — actual video rendering will not work there. Railway remains the real backend, as specified.

## AI Generate (Beta) — free, self-hosted video generation

`colab/gift_visuals_ai_generate.ipynb` turns a free Google Colab GPU (T4) into a personal AI video generation
server (AnimateDiff, with optional image conditioning via IP-Adapter), exposed over a free ngrok tunnel. The
Create page's "AI Generate (Beta)" panel calls that server **directly from the browser** — it never touches
this app's backend, so no server-side changes or costs are involved.

This is real generation (new video synthesized from a prompt), not an editing effect — a genuinely different
capability from the main AI Edit pipeline above. It is also genuinely limited by what a free GPU can do:
short clips (2-4s), lower resolution, generation often taking a few minutes, and the Colab session
disconnecting after a period of inactivity (just rerun the notebook and paste the new URL/token into the app
when that happens). Treat it as a personal experimentation feature, not an always-on product feature for
other users — free Colab is explicitly not meant to run as a persistent backend.

Setup: open the notebook in Colab, set the runtime to a T4 GPU, get a free ngrok authtoken, run every cell,
then paste the printed URL and access token into the app.

## Local development

```bash
npm install
GROQ_API_KEY=your-key npm start
```

Requires `ffmpeg`/`ffprobe` on PATH (the included `Dockerfile` installs it for Railway; install locally with your OS package manager, e.g. `apt-get install ffmpeg`).
