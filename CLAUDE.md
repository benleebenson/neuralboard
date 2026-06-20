# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev      # start dev server on localhost:3000
npm run build    # production build
npm run lint     # ESLint
```

No test suite exists. Verify changes by running the dev server.

## Environment variables required

| Variable | Purpose |
|---|---|
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Google OAuth (NextAuth) |
| `AUTH_SECRET` | NextAuth secret |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase DB |
| `OPENAI_API_KEY` | Whisper transcription + GPT-4o beat planning |
| `SERPER_API_KEY` | Google Images search via Serper |
| `RAILWAY_URL` + `NEXT_PUBLIC_RAILWAY_URL` | External Railway backend (video search + yt-dlp) |
| `NEURALBOARD_PASSWORD` | Password header for Railway requests |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PRICE_ID` | Stripe subscriptions |
| `ANTHROPIC_API_KEY` | Claude (auto-picked up by `@anthropic-ai/sdk`) |

## Architecture

**Neural Board** is an AI-powered browser-based video editor deployed on Vercel.

### App Router layout

```
app/
  layout.tsx          — root layout, wraps everything in <SessionProvider>
  providers.tsx       — NextAuth SessionProvider
  page.tsx            — redirects to /editor
  editor/page.tsx     — the entire editor (client component, ~3100 lines)
  admin/page.tsx      — admin dashboard (server component, guarded to ADMIN_EMAIL)
  upgrade/page.tsx    — Stripe subscription page
  api/
    auth/[...nextauth]/  — Google OAuth via next-auth v4
    config/              — returns Railway URL + password to authenticated clients
    transcribe/          — main AI pipeline (see below)
    director/            — GPT-4o beat revision based on user notes
    arrange/             — Claude claude-sonnet-4-6 "detective board" layout
    ytdl/                — proxies YouTube download from Railway backend
    render/complete/     — logs render events to Supabase
    usage/check/         — subscription status check
    stripe/              — checkout, portal, and webhook handlers
    log/                 — event logging
lib/
  auth.ts             — NextAuth config, Google provider, ADMIN_EMAIL constant
  supabase.ts         — Supabase client + all DB helpers (users, events, costs, subscriptions)
```

### Editor (`app/editor/page.tsx`)

The entire editor is a single large client component. Key subsystems:

- **Timeline**: canvas-like div layout; clips have `startTime`, `layer`, `durationSec`. Drag/resize uses pointer capture. Grid snap (`SNAP = 0.1s`) + magnetic snap to clip edges and playhead (`MAGNETIC_SNAP_PX = 10`).
- **Clip types**: `audio | video | image | text`. Text clips render via canvas `drawTextClip`.
- **Playback**: `requestAnimationFrame` loop driven by `performance.now()`. Audio uses Web Audio API — audio clips decode to `AudioBufferSourceNode`, video clips use `MediaElementAudioSourceNode` through a `GainNode`.
- **Volume curves**: per-clip `CurvePoint[]` (time, volume 0–100) interpolated linearly during playback.
- **Preview**: `<canvas>` element redrawn each animation frame; draws visual clips bottom-layer-first. Green screen is chroma-keyed via `applyGreenScreenToImageData` on an offscreen canvas.
- **Crop**: zoom/x/y parameters applied via `cropSourceRect` when drawing to canvas and via CSS `transform` in preview.
- **Export**: also uses canvas + `MediaRecorder` to capture the canvas stream; `MAX_EXPORT_DURATION = 90s`.
- **Undo**: snapshot stack (`EditorSnapshot[]`, max 80 entries) stored in a ref; mutations call `pushUndoSnapshot()` first.
- **State pattern**: React state for render triggers; `useRef` mirrors (`clipsRef`, `isPlayingRef`, etc.) used inside RAF/event handlers to avoid stale closures.
- **YouTube modal**: searches via Railway `/video-search`, downloads via Railway `/ytdl` + `/ytdl-file/:id`.

### AI pipeline (`/api/transcribe`)

1. Receives audio blob → sends to OpenAI Whisper (`verbose_json` with word timestamps)
2. GPT-4o-mini plans "beats" (time ranges + image search queries) from the transcript
3. Serper fetches Google Images for each beat in parallel
4. Returns `{ transcript, duration, beats }` to the editor

The `/api/director` route uses GPT-4o to revise beats based on free-text director notes.
The `/api/arrange` route uses Claude (`claude-sonnet-4-6`) to position beat cards as a "detective board" layout.

### Auth + access control

- Google OAuth only. `ADMIN_EMAIL = "bbtvhq@gmail.com"` in `lib/auth.ts`.
- Non-admin users get **1 free render**; after that they must subscribe ($10/mo via Stripe).
- Subscription status stored in `nb_users.subscription_status` + `subscription_period_end`.
- Middleware at `middleware.ts` only handles `/builder` → `/editor` redirect.

### Database (Supabase)

Three tables (schema in `supabase-schema.sql`):
- `nb_users` — one row per email, tracks subscription, Stripe IDs, last_seen
- `nb_events` — event log: `login | transcribe | render | download`
- `nb_api_costs` — per-call API cost tracking (Whisper, GPT-4o-mini, Serper, Claude)

### External Railway backend

An external service (not in this repo) handles YouTube search (`/video-search`) and download (`/ytdl`, `/ytdl-file/:id`). Requests are authenticated with the `x-neuralboard-password` header. The URL is returned to authenticated clients via `/api/config`.
