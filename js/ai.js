// Content feedback from Gemini. Only the transcript text is sent, never audio or video.
import { CONFIG, isDemoMode } from './config.js';
import { PERSONAS, buildUserMessage, MAX_TRANSCRIPT_CHARS } from '../supabase/functions/_shared/prompts.js';
import { getSupabase } from './store.js';

const DEV_KEY = 'ic_dev_gemini_key';
export const getDevKey = () => { try { return localStorage.getItem(DEV_KEY) || ''; } catch { return ''; } };
export const setDevKey = (k) => { try { k ? localStorage.setItem(DEV_KEY, k.trim()) : localStorage.removeItem(DEV_KEY); } catch { /* ignore */ } };

export function aiSource() {
  if (!isDemoMode()) return 'server';
  if (getDevKey()) return 'dev-key';
  return 'sample';
}

export async function getFeedback({ mode, question, category, transcript, answerSeconds, durationSeconds }) {
  const payload = { mode, question, category, transcript: (transcript || '').slice(0, MAX_TRANSCRIPT_CHARS), answerSeconds, durationSeconds };
  const src = aiSource();
  try {
    let raw;
    if (src === 'server') {
      const { data, error } = await getSupabase().functions.invoke(CONFIG.FEEDBACK_FUNCTION, { body: payload });
      if (error) throw error;
      raw = data;
    } else if (src === 'dev-key') {
      raw = await callGeminiDirect(payload);
    } else {
      raw = sampleFeedback(payload);
    }
    return { ...normalise(raw, mode), source: src };
  } catch (err) {
    console.error('Feedback failed', err);
    return { ...normalise(sampleFeedback(payload), mode), source: 'sample', error: String(err?.message || err) };
  }
}

async function callGeminiDirect(p) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': getDevKey() },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: PERSONAS[p.mode] || PERSONAS.expert }] },
      contents: [{ role: 'user', parts: [{ text: buildUserMessage(p) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: p.mode === 'peer' ? 0.8 : 0.3 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((x) => x.text).join('') || '{}';
  return JSON.parse(text);
}

function normalise(r = {}, mode) {
  const arr = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string').slice(0, 3) : []);
  const clamp = (n) => Math.max(1, Math.min(5, Math.round(Number(n) || 1)));
  const star = r.star || {};
  const sc = r.scores || {};
  return {
    mode,
    overall: String(r.overall || ''),
    strengths: arr(r.strengths),
    improvements: arr(r.improvements),
    star: { situation: !!star.situation, task: !!star.task, action: !!star.action, result: !!star.result },
    scores: { relevance: clamp(sc.relevance), structure: clamp(sc.structure), specificity: clamp(sc.specificity), impact: clamp(sc.impact) },
    followUp: String(r.followUp || ''),
    nextStep: String(r.nextStep || ''),
  };
}

// Offline placeholder so the app is usable before an AI key is connected.
// It uses simple keyword checks and is clearly labelled as sample feedback.
function sampleFeedback({ mode, transcript }) {
  const t = (transcript || '').toLowerCase();
  const words = t.split(/\s+/).filter(Boolean).length;
  const star = {
    situation: /\b(when|during|at my|last year|in my)\b/.test(t),
    task: /\b(needed to|had to|my role|responsible|goal|task)\b/.test(t),
    action: /\b(i (decided|organised|organized|built|created|led|spoke|set up|asked|proposed|made))\b/.test(t),
    result: /\b(as a result|result|outcome|increased|reduced|improved|learn(ed|t))\b/.test(t),
  };
  const missing = Object.entries(star).filter(([, v]) => !v).map(([k]) => k);
  if (words < 15) {
    return {
      overall: mode === 'peer' ? "I didn't catch much of that! Want to give it another go?" : 'The response was too short to assess.',
      strengths: [], improvements: ['Give a full answer using a specific example.'], star,
      scores: { relevance: 1, structure: 1, specificity: 1, impact: 1 },
      followUp: 'Can you walk me through one specific example?', nextStep: 'Pick one real example and talk it through from start to finish.',
    };
  }
  const expert = mode !== 'peer';
  return {
    overall: expert
      ? `Sample assessment (AI not connected). ${missing.length ? `The answer does not clearly cover: ${missing.join(', ')}.` : 'All four STAR elements appear to be present.'} Specific evidence of impact should be stated explicitly.`
      : `Sample feedback (AI not connected). Nice, you got a real example in there! ${missing.length ? `Maybe add a bit more on the ${missing[0]}.` : 'The structure sounds solid.'}`,
    strengths: ['Uses a personal example.'],
    improvements: missing.length ? [`Make the ${missing[0]} explicit.`] : ['Quantify the result where possible.'],
    star,
    scores: { relevance: 3, structure: 4 - Math.min(3, missing.length), specificity: 3, impact: star.result ? 3 : 2 },
    followUp: 'What would you do differently if you faced the same situation again?',
    nextStep: 'Connect your AI key to get real feedback on this answer.',
  };
}
