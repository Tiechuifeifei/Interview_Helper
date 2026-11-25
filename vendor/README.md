# Vendored libraries

Copied from npm so the app does not depend on a third-party CDN.

| Folder | Package | Version | Licence |
|---|---|---|---|
| `mediapipe/` | `@mediapipe/tasks-vision` | 1.2.3 | Apache-2.0 |
| `supabase/` | `@supabase/supabase-js` (UMD build) | 2.119.2 | MIT |

The face model file (`face_landmarker.task`) is not stored here. It is loaded from Google's
MediaPipe model bucket at runtime (see `FACE_MODEL_URL` in `js/config.js`).
