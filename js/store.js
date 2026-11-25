// Data layer with two backends:
//  - LocalStore: IndexedDB in this browser (demo mode, no setup needed)
//  - SupabaseStore: accounts, database and private video storage
// Students can read their own transcripts, content feedback and the basic
// metrics. The full analysis (blinks, smiles, head movement, timeline) is
// written by the student's browser but is readable only by coaches.
import { CONFIG, isDemoMode } from './config.js';

let sb = null;
export function getSupabase() {
  if (isDemoMode()) return null;
  if (!sb) {
    if (!window.supabase) throw new Error('Supabase library not loaded. Include vendor/supabase/supabase.js before the app scripts.');
    sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  }
  return sb;
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

// ===========================================================================
// IndexedDB helpers
// ===========================================================================
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('interview-coach', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('sessions', { keyPath: 'id' });
      db.createObjectStore('answers', { keyPath: 'id' }).createIndex('session', 'session_id');
      db.createObjectStore('analysis', { keyPath: 'answer_id' });
      db.createObjectStore('videos');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = Object.fromEntries([].concat(storeNames).map((n) => [n, t.objectStore(n)]));
    let result;
    Promise.resolve(fn(stores)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}
const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

class LocalStore {
  constructor() { this.urls = new Map(); }

  async currentUser() {
    const role = localStorage.getItem('ic_demo_role') || 'student';
    return { id: role === 'coach' ? 'demo-coach' : 'demo-student', name: role === 'coach' ? 'Demo Coach' : 'Demo Student', role, demo: true };
  }
  async setDemoRole(role) { localStorage.setItem('ic_demo_role', role); }
  async signOut() {}

  async createSession({ mode }) {
    const s = { id: uuid(), mode, status: 'draft', student_id: 'demo-student', student_name: 'Demo Student', created_at: new Date().toISOString(), coach_feedback: null };
    await tx('sessions', 'readwrite', ({ sessions }) => sessions.put(s));
    return s;
  }

  async saveAnswer(sessionId, a) {
    const id = uuid();
    const answer = {
      id, session_id: sessionId, idx: a.idx, question_id: a.question.id, question: a.question.text, category: a.question.category,
      transcript: a.transcript, duration_s: Math.round(a.duration), student_metrics: a.studentMetrics, ai_feedback: a.feedback,
      has_video: a.hasVideo, mime_type: a.mimeType, created_at: new Date().toISOString(),
    };
    await tx(['answers', 'analysis', 'videos'], 'readwrite', ({ answers, analysis, videos }) => {
      answers.put(answer);
      analysis.put({ answer_id: id, metrics: a.metrics, timeline: a.timeline, events: a.events });
      if (a.blob) videos.put(a.blob, id);
    });
    return answer;
  }

  async updateAnswerFeedback(answerId, feedback) {
    await tx('answers', 'readwrite', async ({ answers }) => {
      const a = await req2p(answers.get(answerId));
      if (a) { a.ai_feedback = feedback; answers.put(a); }
    });
  }

  async submitSession(id) { await this.patchSession(id, { status: 'submitted', submitted_at: new Date().toISOString() }); }

  async patchSession(id, patch) {
    await tx('sessions', 'readwrite', async ({ sessions }) => {
      const s = await req2p(sessions.get(id));
      if (s) sessions.put({ ...s, ...patch });
    });
  }

  async deleteSession(id) {
    const answers = await this.answersFor(id);
    await tx(['sessions', 'answers', 'analysis', 'videos'], 'readwrite', (st) => {
      st.sessions.delete(id);
      for (const a of answers) { st.answers.delete(a.id); st.analysis.delete(a.id); st.videos.delete(a.id); }
    });
  }

  async answersFor(sessionId) {
    const list = await tx('answers', 'readonly', ({ answers }) => req2p(answers.index('session').getAll(sessionId)));
    return (list || []).sort((a, b) => a.idx - b.idx);
  }

  async listMySessions() {
    const all = await tx('sessions', 'readonly', ({ sessions }) => req2p(sessions.getAll()));
    const out = [];
    for (const s of (all || []).sort((a, b) => b.created_at.localeCompare(a.created_at))) out.push({ ...s, answers: await this.answersFor(s.id) });
    return out;
  }

  async listSubmissions() {
    return (await this.listMySessions()).filter((s) => s.status !== 'draft');
  }

  async getSessionForCoach(id) {
    const s = await tx('sessions', 'readonly', ({ sessions }) => req2p(sessions.get(id)));
    if (!s) return null;
    const answers = await this.answersFor(id);
    for (const a of answers) a.analysis = await tx('analysis', 'readonly', ({ analysis }) => req2p(analysis.get(a.id)));
    return { ...s, answers };
  }

  async videoUrl(answer) {
    if (this.urls.has(answer.id)) return this.urls.get(answer.id);
    const blob = await tx('videos', 'readonly', ({ videos }) => req2p(videos.get(answer.id)));
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.urls.set(answer.id, url);
    return url;
  }

  async sendCoachFeedback(id, feedback, coachName) {
    await this.patchSession(id, { status: 'reviewed', reviewed_at: new Date().toISOString(), coach_feedback: { ...feedback, coach_name: coachName } });
  }
}

// ===========================================================================
// Supabase
// ===========================================================================
class SupabaseStore {
  get sb() { return getSupabase(); }

  async currentUser() {
    const { data: { user } } = await this.sb.auth.getUser();
    if (!user) return null;
    const { data: profile } = await this.sb.from('profiles').select('full_name, role').eq('id', user.id).maybeSingle();
    return { id: user.id, email: user.email, name: profile?.full_name || user.email, role: profile?.role || 'student' };
  }

  async signIn(email) {
    const redirect = new URL('./', location.href).href;
    const { error } = await this.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } });
    if (error) throw error;
  }

  async updateName(name) {
    const user = await this.currentUser();
    await this.sb.from('profiles').update({ full_name: name }).eq('id', user.id);
  }

  async signOut() { await this.sb.auth.signOut(); }

  async createSession({ mode }) {
    const user = await this.currentUser();
    const { data, error } = await this.sb.from('sessions').insert({ mode, student_id: user.id }).select().single();
    if (error) throw error;
    return data;
  }

  async saveAnswer(sessionId, a) {
    const user = await this.currentUser();
    let video_path = null;
    if (a.blob) {
      const ext = a.mimeType.includes('mp4') ? 'mp4' : 'webm';
      video_path = `${user.id}/${sessionId}/${a.idx}-${Date.now()}.${ext}`;
      const { error: upErr } = await this.sb.storage.from('recordings').upload(video_path, a.blob, { contentType: a.mimeType || 'video/webm' });
      if (upErr) { console.error(upErr); video_path = null; }
    }
    const { data: answer, error } = await this.sb.from('answers').insert({
      session_id: sessionId, idx: a.idx, question_id: a.question.id, question: a.question.text, category: a.question.category,
      transcript: a.transcript, duration_s: Math.round(a.duration), student_metrics: a.studentMetrics, ai_feedback: a.feedback,
      has_video: a.hasVideo, mime_type: a.mimeType, video_path,
    }).select().single();
    if (error) throw error;
    const { error: anErr } = await this.sb.from('answer_analysis').insert({ answer_id: answer.id, metrics: a.metrics, timeline: a.timeline, events: a.events });
    if (anErr) console.error(anErr);
    return answer;
  }

  async updateAnswerFeedback(answerId, feedback) {
    await this.sb.from('answers').update({ ai_feedback: feedback }).eq('id', answerId);
  }

  async submitSession(id) {
    const { error } = await this.sb.from('sessions').update({ status: 'submitted', submitted_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
  }

  async deleteSession(id) {
    const { data: answers } = await this.sb.from('answers').select('video_path').eq('session_id', id);
    const paths = (answers || []).map((a) => a.video_path).filter(Boolean);
    if (paths.length) await this.sb.storage.from('recordings').remove(paths);
    await this.sb.from('sessions').delete().eq('id', id);
  }

  async listMySessions() {
    const user = await this.currentUser();
    const { data, error } = await this.sb.from('sessions').select('*, answers(*)').eq('student_id', user.id).order('created_at', { ascending: false });
    if (error) throw error;
    return data.map((s) => ({ ...s, answers: (s.answers || []).sort((a, b) => a.idx - b.idx) }));
  }

  async listSubmissions() {
    const { data, error } = await this.sb.from('sessions').select('*, answers(id, idx, question, duration_s), profiles!sessions_student_id_fkey(full_name)').neq('status', 'draft').order('submitted_at', { ascending: false });
    if (error) throw error;
    return data.map((s) => ({ ...s, student_name: s.profiles?.full_name || 'Student', answers: (s.answers || []).sort((a, b) => a.idx - b.idx) }));
  }

  async getSessionForCoach(id) {
    const { data, error } = await this.sb.from('sessions').select('*, profiles!sessions_student_id_fkey(full_name), answers(*, answer_analysis(*))').eq('id', id).single();
    if (error) throw error;
    const answers = (data.answers || []).sort((a, b) => a.idx - b.idx).map((a) => ({ ...a, analysis: Array.isArray(a.answer_analysis) ? a.answer_analysis[0] : a.answer_analysis }));
    return { ...data, student_name: data.profiles?.full_name || 'Student', answers };
  }

  async videoUrl(answer) {
    if (!answer.video_path) return null;
    const { data } = await this.sb.storage.from('recordings').createSignedUrl(answer.video_path, 3600);
    return data?.signedUrl || null;
  }

  async sendCoachFeedback(id, feedback, coachName) {
    const user = await this.currentUser();
    const { error } = await this.sb.from('sessions').update({
      status: 'reviewed', reviewed_at: new Date().toISOString(), coach_id: user.id, coach_feedback: { ...feedback, coach_name: coachName },
    }).eq('id', id);
    if (error) throw error;
  }
}

export const store = isDemoMode() ? new LocalStore() : new SupabaseStore();

// Average of the student-visible metrics from the most recent earlier session,
// used for "compared with last time".
export async function previousMetrics(excludeSessionId) {
  try {
    const sessions = (await store.listMySessions()).filter((s) => s.id !== excludeSessionId && s.answers?.length);
    const last = sessions[0];
    if (!last) return null;
    const keys = ['wpm', 'fillerCount', 'pauseCount', 'eyeContactPct'];
    const out = {};
    for (const k of keys) {
      const vals = last.answers.map((a) => a.student_metrics?.[k]).filter((v) => typeof v === 'number');
      out[k] = vals.length ? Math.round(vals.reduce((x, y) => x + y, 0) / vals.length) : null;
    }
    return out;
  } catch { return null; }
}
