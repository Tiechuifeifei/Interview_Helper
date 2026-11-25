// ---------------------------------------------------------------------------
// App configuration. Edit this file after you set up Supabase (see README).
// ---------------------------------------------------------------------------
// Leave SUPABASE_URL empty to run in DEMO MODE: everything (recordings,
// analysis, coach feedback) is stored only in this browser, and you can
// switch between the student and coach views on the home page.

export const CONFIG = {
  // Supabase project (Settings → API). The anon key is safe to publish;
  // access is controlled by the Row Level Security rules in supabase/schema.sql.
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',

  // Name of the Supabase Edge Function that calls Gemini.
  FEEDBACK_FUNCTION: 'feedback',

  // Used only for local development without Supabase. A key typed into the
  // Settings panel is kept in this browser's localStorage. Never commit a key.
  GEMINI_MODEL: 'gemini-3.6-flash',

  // Interview settings
  EXPERT_QUESTION_COUNT: 3,
  EXPERT_PREP_SECONDS: 30,
  EXPERT_MIN_ANSWER_SECONDS: 20, // "Finish answer" becomes available after this
  PEER_MAX_ANSWER_SECONDS: 180,

  // Recording quality (480p keeps a 2-minute answer around 9–10 MB)
  VIDEO_WIDTH: 640,
  VIDEO_HEIGHT: 480,
  VIDEO_BITS_PER_SECOND: 600_000,

  SPEECH_LANG: 'en-GB',

  // MediaPipe face model
  FACE_MODEL_URL:
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  MEDIAPIPE_WASM_PATH: new URL('../vendor/mediapipe/wasm', import.meta.url).href,
};

export const isDemoMode = () => !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY;
