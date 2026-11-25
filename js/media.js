// Camera, microphone, recording and live audio analysis (volume, silence, pitch).
import { CONFIG } from './config.js';

export async function openMedia({ video = true } = {}) {
  const constraints = {
    audio: { echoCancellation: true, noiseSuppression: true },
    video: video
      ? { width: { ideal: CONFIG.VIDEO_WIDTH }, height: { ideal: CONFIG.VIDEO_HEIGHT }, facingMode: 'user' }
      : false,
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

export function describeMediaError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError') return 'Permission was denied. Allow camera and microphone access in your browser settings, then reload.';
  if (name === 'NotFoundError') return 'No camera or microphone was found.';
  if (name === 'NotReadableError') return 'Your camera or microphone is being used by another app.';
  return `Could not access your camera or microphone (${name || err?.message || 'unknown error'}).`;
}

function pickMimeType(hasVideo) {
  const options = hasVideo
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return options.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

export class Recorder {
  constructor(stream) {
    this.stream = stream;
    this.hasVideo = stream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');
    this.chunks = [];
    this.mimeType = pickMimeType(this.hasVideo);
  }
  start() {
    const tracks = [...this.stream.getAudioTracks()];
    if (this.hasVideo) tracks.push(...this.stream.getVideoTracks());
    const recStream = new MediaStream(tracks);
    this.rec = new MediaRecorder(recStream, {
      mimeType: this.mimeType || undefined,
      videoBitsPerSecond: CONFIG.VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: 64_000,
    });
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.startedAt = performance.now();
    this.rec.start(1000);
  }
  stop() {
    return new Promise((resolve) => {
      if (!this.rec || this.rec.state === 'inactive') return resolve(null);
      this.rec.onstop = () => {
        const type = this.rec.mimeType || this.mimeType || (this.hasVideo ? 'video/webm' : 'audio/webm');
        resolve(new Blob(this.chunks, { type }));
      };
      this.rec.stop();
    });
  }
}

// ---------------------------------------------------------------------------
// Live audio analysis: loudness for silence/pause detection, plus a simple
// autocorrelation pitch tracker used for "pitch variation" (coach view only).
// ---------------------------------------------------------------------------
export class AudioAnalyser {
  constructor(stream) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.node = this.ctx.createAnalyser();
    this.node.fftSize = 2048;
    this.source.connect(this.node);
    this.buf = new Float32Array(this.node.fftSize);
    this.noiseFloor = 0.01;
    this.level = 0;
  }

  resume() {
    return this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
  }

  // RMS of the current frame (0..1)
  read() {
    this.node.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    this.level = Math.sqrt(sum / this.buf.length);
    return this.level;
  }

  // Track background noise while the candidate is (probably) silent.
  calibrate(level) {
    this.noiseFloor = this.noiseFloor * 0.95 + Math.min(level, 0.05) * 0.05;
  }

  isSpeech(level) {
    return level > Math.max(0.015, this.noiseFloor * 3);
  }

  // Fundamental frequency in Hz, or null when not voiced.
  pitch() {
    const buf = this.buf;
    const sr = this.ctx.sampleRate;
    const minLag = Math.floor(sr / 400);
    const maxLag = Math.floor(sr / 70);
    let best = -1;
    let bestLag = -1;
    let energy = 0;
    for (let i = 0; i < buf.length; i++) energy += buf[i] * buf[i];
    if (energy < 1e-3) return null;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      for (let i = 0; i + lag < buf.length; i++) c += buf[i] * buf[i + lag];
      if (c > best) { best = c; bestLag = lag; }
    }
    if (bestLag < 0 || best / energy < 0.5) return null;
    return sr / bestLag;
  }

  close() {
    try { this.source.disconnect(); this.ctx.close(); } catch { /* ignore */ }
  }
}

export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
