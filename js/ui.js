// Small shared helpers for the pages.
import { isDemoMode } from './config.js';
import { store } from './store.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export async function loadQuestions() {
  const res = await fetch(new URL('../data/questions.json', import.meta.url));
  return (await res.json()).questions;
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Pick n questions from different categories.
export function pickQuestions(all, n) {
  const seen = new Set();
  const out = [];
  for (const q of shuffle(all)) {
    if (out.length >= n) break;
    if (seen.has(q.category)) continue;
    seen.add(q.category);
    out.push(q);
  }
  return out;
}

export function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtDuration(s) {
  s = Math.round(s || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Compare with last time. lowerIsBetter flips the colour.
export function delta(now, before, { lowerIsBetter = false, unit = '', neutral = false } = {}) {
  if (typeof now !== 'number' || typeof before !== 'number') return '';
  const d = now - before;
  if (d === 0) return '<span class="delta same">same as last time</span>';
  const better = lowerIsBetter ? d < 0 : d > 0;
  return `<span class="delta ${neutral ? 'same' : better ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}${unit} vs last time</span>`;
}

// Student-visible delivery metrics. No targets, no "normal" ranges for
// face measurements; pace gets a practical note because interviewers notice it.
export function studentMetricItems(m, prev) {
  if (!m) return [];
  const items = [
    { label: 'Length', value: fmtDuration(m.durationSeconds), extra: '' },
    {
      label: 'Pace',
      value: m.wpm ? `${m.wpm} wpm` : '—',
      extra: (m.wpm ? (m.wpm > 170 ? '<span class="note">Quite fast; try slowing down a little.</span>' : m.wpm < 110 ? '<span class="note">Quite slow; you can pick up the pace.</span>' : '') : '') + delta(m.wpm, prev?.wpm, { neutral: true }),
    },
    { label: 'Filler words', value: m.fillerCount ?? '—', extra: delta(m.fillerCount, prev?.fillerCount, { lowerIsBetter: true }) },
    { label: 'Pauses over 2s', value: m.pauseCount ?? '—', extra: delta(m.pauseCount, prev?.pauseCount, { lowerIsBetter: true }) },
  ];
  if (m.eyeContactPct != null) items.push({ label: 'Looking at camera', value: `${m.eyeContactPct}%`, extra: delta(m.eyeContactPct, prev?.eyeContactPct, { unit: '%' }) });
  return items;
}

export function renderDemoBanner(target) {
  if (!isDemoMode() || !target) return;
  target.innerHTML = `<div class="demo-banner">Demo mode: recordings stay in this browser. <a href="index.html#settings">Settings</a></div>`;
}

export async function requireUser(role) {
  const user = await store.currentUser();
  if (!user) { location.href = 'index.html'; throw new Error('not signed in'); }
  if (role && user.role !== role) {
    document.body.innerHTML = `<main class="center-msg"><h1>Not available</h1><p>This page is for ${esc(role)}s. <a href="index.html">Back to home</a></p></main>`;
    throw new Error('wrong role');
  }
  return user;
}

export function toast(msg, ms = 3000) {
  const el = h(`<div class="toast">${esc(msg)}</div>`);
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, ms);
}
