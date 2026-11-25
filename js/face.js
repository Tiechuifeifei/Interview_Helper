// Face tracking with MediaPipe Face Landmarker, entirely in the browser.
// It measures visible movements only (eye contact, blinks, smiles, head
// movement, staying in frame). It never labels emotions.
import { CONFIG } from './config.js';

let landmarkerPromise = null;

export function loadFaceLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FaceLandmarker, FilesetResolver } = await import('../vendor/mediapipe/vision_bundle.mjs');
      const fileset = await FilesetResolver.forVisionTasks(CONFIG.MEDIAPIPE_WASM_PATH);
      const options = (delegate) => ({
        baseOptions: { modelAssetPath: CONFIG.FACE_MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
      try {
        return await FaceLandmarker.createFromOptions(fileset, options('GPU'));
      } catch {
        return await FaceLandmarker.createFromOptions(fileset, options('CPU'));
      }
    })();
    landmarkerPromise.catch(() => { landmarkerPromise = null; });
  }
  return landmarkerPromise;
}

const deg = (r) => (r * 180) / Math.PI;

function headAngles(matrix) {
  // 4x4 column-major. R[row][col] = d[col*4 + row]
  const d = matrix.data;
  const R = (r, c) => d[c * 4 + r];
  const yaw = deg(Math.atan2(R(0, 2), R(2, 2)));
  const pitch = deg(Math.asin(Math.max(-1, Math.min(1, -R(1, 2)))));
  return { yaw, pitch };
}

// Guide box the candidate should stay inside, as fractions of the video frame.
export const FRAME_GUIDE = { x0: 0.25, x1: 0.75, y0: 0.12, y1: 0.88, minWidth: 0.18, maxWidth: 0.6 };

export class FaceTracker {
  constructor(video) {
    this.video = video;
    this.running = false;
    this.state = { present: false, framed: false, eyeContact: false, smile: false, eyesClosed: false };
    this.listeners = new Set();
    this.recording = false;
    this.available = false;
  }

  async start() {
    this.landmarker = await loadFaceLandmarker();
    this.available = true;
    this.running = true;
    this.lastVideoTime = -1;
    const loop = () => {
      if (!this.running) return;
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  tick() {
    const v = this.video;
    if (!v || v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    const now = performance.now();
    if (this.lastProcessed && now - this.lastProcessed < 66) return; // ~15 fps is plenty
    this.lastProcessed = now;
    this.lastVideoTime = v.currentTime;

    let res;
    try { res = this.landmarker.detectForVideo(v, now); } catch { return; }
    const s = { present: false, framed: false, eyeContact: false, smile: false, eyesClosed: false, yaw: 0, pitch: 0 };

    if (res?.faceLandmarks?.length) {
      s.present = true;
      const lm = res.faceLandmarks[0];
      let minX = 1, maxX = 0, minY = 1, maxY = 0;
      for (const p of lm) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
      // Video is shown mirrored, but framing is symmetric so x orientation does not matter.
      const cx = (minX + maxX) / 2, w = maxX - minX;
      const g = FRAME_GUIDE;
      s.box = { minX, maxX, minY, maxY };
      s.framed = cx > g.x0 && cx < g.x1 && minY > g.y0 - 0.08 && maxY < g.y1 + 0.08 && w > g.minWidth && w < g.maxWidth;

      const bs = {};
      for (const c of res.faceBlendshapes?.[0]?.categories || []) bs[c.categoryName] = c.score;
      const avg = (a, b) => ((bs[a] || 0) + (bs[b] || 0)) / 2;
      s.blinkScore = avg('eyeBlinkLeft', 'eyeBlinkRight');
      s.eyesClosed = s.blinkScore > 0.5;
      s.smileScore = avg('mouthSmileLeft', 'mouthSmileRight');
      s.smile = s.smileScore > 0.4;

      if (res.facialTransformationMatrixes?.length) Object.assign(s, headAngles(res.facialTransformationMatrixes[0]));
      const gazeAway = Math.max(
        avg('eyeLookOutLeft', 'eyeLookOutRight'), avg('eyeLookInLeft', 'eyeLookInRight'),
        avg('eyeLookUpLeft', 'eyeLookUpRight'), avg('eyeLookDownLeft', 'eyeLookDownRight'),
      );
      s.eyeContact = Math.abs(s.yaw) < 15 && Math.abs(s.pitch) < 15 && gazeAway < 0.55 && !s.eyesClosed;
    }

    this.state = s;
    if (this.recording) this.record(s, now);
    this.listeners.forEach((fn) => fn(s));
  }

  // --- per-answer accumulation -------------------------------------------
  beginAnswer() {
    this.samples = [];
    this.blinks = 0;
    this.wasClosed = false;
    this.t0 = performance.now();
    this.recording = true;
  }

  record(s, now) {
    const t = (now - this.t0) / 1000;
    if (s.eyesClosed && !this.wasClosed) this.blinks++;
    this.wasClosed = s.eyesClosed;
    this.samples.push({ t: +t.toFixed(2), p: s.present ? 1 : 0, f: s.framed ? 1 : 0, e: s.eyeContact ? 1 : 0, s: s.smile ? 1 : 0, y: +(s.yaw || 0).toFixed(1), x: +(s.pitch || 0).toFixed(1) });
  }

  endAnswer() {
    this.recording = false;
    return { samples: this.samples || [], blinks: this.blinks || 0 };
  }
}
