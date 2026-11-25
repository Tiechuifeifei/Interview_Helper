// Captures one answer: recording + transcript + audio/face measurements,
// then turns them into metrics and a timeline of events for the coach.
import { Recorder } from './media.js';
import { Transcriber } from './speech.js';

const FILLERS = /\b(u+m+|u+h+m*|e+r+m+|e+r+|a+h+|hmm+)\b/gi;
const FILLER_PHRASES = ['you know', 'i mean', 'kind of', 'sort of', 'basically', 'literally', 'actually'];

export class AnswerCapture {
  constructor({ stream, analyser, face, onTranscript }) {
    this.stream = stream;
    this.analyser = analyser;
    this.face = face; // FaceTracker or null
    this.onTranscript = onTranscript;
  }

  start() {
    this.recorder = new Recorder(this.stream);
    this.transcriber = new Transcriber({ onUpdate: this.onTranscript });
    this.audio = []; // { t, speech, db }
    this.pitches = []; // { t, hz }
    this.t0 = performance.now();
    this.recorder.start();
    this.transcriber.start();
    const faceOn = this.face?.available && this.stream.getVideoTracks().some((t) => t.enabled);
    this.faceUsed = !!faceOn;
    if (faceOn) this.face.beginAnswer();
    this.timer = setInterval(() => this.sampleAudio(), 50);
  }

  sampleAudio() {
    const level = this.analyser.read();
    const t = (performance.now() - this.t0) / 1000;
    const speech = this.analyser.isSpeech(level);
    if (!speech) this.analyser.calibrate(level);
    this.audio.push({ t, speech, db: 20 * Math.log10(level + 1e-6) });
    if (speech && this.audio.length % 2 === 0) {
      const hz = this.analyser.pitch();
      if (hz) this.pitches.push({ t, hz });
    }
  }

  get elapsed() { return (performance.now() - this.t0) / 1000; }

  async stop() {
    clearInterval(this.timer);
    const duration = this.elapsed;
    const [blob, transcript] = await Promise.all([this.recorder.stop(), this.transcriber.stop()]);
    const faceData = this.faceUsed ? this.face.endAnswer() : null;
    const analysis = computeMetrics({ duration, transcript, audio: this.audio, pitches: this.pitches, face: faceData, hasVideo: this.recorder.hasVideo });
    return {
      blob,
      mimeType: blob?.type || '',
      hasVideo: this.recorder.hasVideo,
      transcript,
      duration,
      ...analysis,
    };
  }
}

// --------------------------------------------------------------------------
function segments(items, predicate, minDur) {
  const out = [];
  let start = null;
  for (let i = 0; i < items.length; i++) {
    const on = predicate(items[i]);
    if (on && start === null) start = items[i].t;
    const last = i === items.length - 1;
    if ((!on || last) && start !== null) {
      const end = items[i].t;
      if (end - start >= minDur) out.push({ t: +start.toFixed(1), dur: +(end - start).toFixed(1) });
      start = null;
    }
  }
  return out;
}

const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
const std = (arr) => {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
};

export function computeMetrics({ duration, transcript, audio, pitches, face, hasVideo = !!face }) {
  const text = (transcript || '').toLowerCase();
  const words = text.split(/\s+/).filter(Boolean).length;
  const fillerCount = (text.match(FILLERS) || []).length;
  const fillerPhrases = {};
  for (const p of FILLER_PHRASES) {
    const n = (text.match(new RegExp(`\\b${p}\\b`, 'g')) || []).length;
    if (n) fillerPhrases[p] = n;
  }

  // Speaking window and pauses from audio energy
  const speechFrames = audio.filter((a) => a.speech);
  const firstSpeech = speechFrames[0]?.t ?? null;
  const lastSpeech = speechFrames.at(-1)?.t ?? null;
  const span = audio.filter((a) => firstSpeech !== null && a.t >= firstSpeech && a.t <= lastSpeech);
  const pauses = segments(span, (a) => !a.speech, 2.0);
  const speakingSpan = firstSpeech !== null ? Math.max(1, lastSpeech - firstSpeech) : 0;
  // Measure from the first sound to the end of the recording so a quiet voice
  // that the level detector partly misses cannot inflate the pace.
  const paceSpan = firstSpeech !== null ? Math.max(speakingSpan, duration - firstSpeech - 1, 1) : 0;
  let wpm = words >= 5 && paceSpan ? Math.round(words / (paceSpan / 60)) : null;
  if (wpm && wpm > 320) wpm = null; // implausible: transcript and audio out of step

  // Pitch variation in semitones (monotone ≈ under 2)
  let pitchVariation = null;
  if (pitches.length >= 20) {
    const sorted = pitches.map((p) => p.hz).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    pitchVariation = +std(pitches.map((p) => 12 * Math.log2(p.hz / median))).toFixed(1);
  }
  const volumeVariation = speechFrames.length > 20 ? +std(speechFrames.map((a) => a.db)).toFixed(1) : null;

  const metrics = {
    durationSeconds: Math.round(duration),
    words,
    wpm,
    fillerCount,
    fillerPhrases,
    pauseCount: pauses.length,
    longestPause: pauses.length ? Math.max(...pauses.map((p) => p.dur)) : 0,
    timeToFirstWord: firstSpeech !== null ? +firstSpeech.toFixed(1) : null,
    pitchVariation,
    volumeVariation,
    camera: !!hasVideo,
    faceTracked: !!(face && face.samples.length),
  };

  const events = pauses.map((p) => ({ ...p, type: 'pause', label: `Pause ${p.dur}s` }));
  const timeline = { audio: downsample(audio.map((a) => ({ t: +a.t.toFixed(1), v: a.speech ? 1 : 0 })), 5), face: [] };

  if (face && face.samples.length) {
    const s = face.samples;
    const present = s.filter((x) => x.p);
    Object.assign(metrics, {
      inFramePct: pct(s.filter((x) => x.p && x.f).length, s.length),
      eyeContactPct: pct(s.filter((x) => x.e).length, s.length),
      smilePct: pct(present.filter((x) => x.s).length, present.length),
      blinksPerMinute: duration > 5 ? Math.round(face.blinks / (duration / 60)) : null,
      headMovement: present.length ? +std(present.map((x) => Math.hypot(x.y, x.x))).toFixed(1) : null,
    });
    for (const seg of segments(s, (x) => x.p && !x.e, 3)) events.push({ ...seg, type: 'look-away', label: `Looked away ${seg.dur}s` });
    for (const seg of segments(s, (x) => !x.p || !x.f, 2)) events.push({ ...seg, type: 'out-of-frame', label: `Out of frame ${seg.dur}s` });
    timeline.face = downsample(s, 5);
  }
  events.sort((a, b) => a.t - b.t);

  return { metrics, studentMetrics: studentView(metrics), events, timeline };
}

// What the student is allowed to see right after practising.
export function studentView(m) {
  return {
    durationSeconds: m.durationSeconds,
    words: m.words,
    wpm: m.wpm,
    fillerCount: m.fillerCount,
    pauseCount: m.pauseCount,
    longestPause: m.longestPause,
    eyeContactPct: m.camera ? m.eyeContactPct ?? null : null,
  };
}

function downsample(arr, perSecond) {
  const out = [];
  let lastT = -Infinity;
  for (const a of arr) if (a.t - lastT >= 1 / perSecond) { out.push(a); lastT = a.t; }
  return out;
}
