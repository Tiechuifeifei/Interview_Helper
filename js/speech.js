// Live speech-to-text using the browser's Web Speech API (Chrome / Edge).
// Note: in Chrome this service runs on Google's servers. See README → Privacy.
import { CONFIG } from './config.js';

export function speechSupported() {
  return !!(window.__mockSpeech || window.SpeechRecognition || window.webkitSpeechRecognition);
}

export class Transcriber {
  constructor({ onUpdate } = {}) {
    this.onUpdate = onUpdate || (() => {});
    this.finals = []; // { text, t } where t = seconds since start
    this.interim = '';
    this.active = false;
  }

  start() {
    this.t0 = performance.now();
    this.finals = [];
    this.interim = '';
    this.active = true;

    if (window.__mockSpeech) { // test hook
      this.mock = window.__mockSpeech(this);
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = CONFIG.SPEECH_LANG;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.pushFinal(r[0].transcript);
        else interim += r[0].transcript;
      }
      this.interim = interim;
      this.onUpdate(this.text());
    };
    // Chrome stops after silence; restart while the answer is still running.
    rec.onend = () => { if (this.active) { try { rec.start(); } catch { /* already started */ } } };
    rec.onerror = (e) => { if (e.error === 'not-allowed') this.active = false; };
    this.rec = rec;
    try { rec.start(); } catch { /* ignore */ }
  }

  pushFinal(text) {
    const clean = text.trim();
    if (!clean) return;
    this.finals.push({ text: clean, t: (performance.now() - this.t0) / 1000 });
    this.onUpdate(this.text());
  }

  text() {
    return [...this.finals.map((f) => f.text), this.interim].join(' ').replace(/\s+/g, ' ').trim();
  }

  async stop() {
    this.active = false;
    if (this.mock?.stop) this.mock.stop();
    if (this.rec) {
      await new Promise((resolve) => {
        const done = () => resolve();
        this.rec.onend = done;
        try { this.rec.stop(); } catch { done(); }
        setTimeout(done, 1500);
      });
    }
    if (this.interim) { this.pushFinal(this.interim); this.interim = ''; }
    return this.text();
  }
}

// Text-to-speech for reading questions aloud (browser voices, free).
export function speak(text, { rate = 0.98 } = {}) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-GB';
    u.rate = rate;
    const voices = window.speechSynthesis.getVoices();
    const v = voices.find((x) => /en-GB/i.test(x.lang) && /Google|Natural|Daniel|Serena/i.test(x.name)) || voices.find((x) => /en-GB/i.test(x.lang));
    if (v) u.voice = v;
    u.onend = resolve;
    u.onerror = resolve;
    window.speechSynthesis.speak(u);
    setTimeout(resolve, 20000);
  });
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}
