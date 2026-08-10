export const AI_FEATURES_ENABLED = false;
// Play Mode, Live Control, streaming/guest-join, and their collision-physics runtime are hidden
// while the standard editor stabilizes. The code paths stay intact — flip this back on to restore
// entry points once the standard choreography → pose → grounding pipeline is solid.
export const LIVE_FEATURES_ENABLED = false;
export const STREAM_OWNER_USER_ID = process.env.NEXT_PUBLIC_STREAM_OWNER_USER_ID ?? "owner";
export const STREAM_OWNER_NAME = process.env.NEXT_PUBLIC_STREAM_OWNER_NAME ?? "Neural Board";
export const DEBUG_STREAM = process.env.NEXT_PUBLIC_DEBUG_STREAM === "1" || process.env.NEXT_PUBLIC_DEBUG_STREAM === "true";
