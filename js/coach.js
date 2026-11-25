// Coach dashboard: watch recordings with measurement markers, read the AI's
// content notes as a draft, and write the feedback the student will receive.
import { store } from './store.js';
import { $, $$, h, esc, fmtDate, fmtDuration, renderDemoBanner, requireUser, toast } from './ui.js';

const S = { filter: 'submitted', sessions: [], current: null, tab: 0, notes: {}, user: null };

async function init() {
  renderDemoBanner($('#demo'));
  S.user = await requireUser('coach');
  $('#who').textContent = S.user.name;
  $$('#filter button').forEach((b) => b.onclick = () => {
    $$('#filter button').forEach((x) => x.classList.toggle('on', x === b));
    S.filter = b.dataset.f;
    renderList();
  });
  await loadList();
  const id = new URLSearchParams(location.search).get('s');
  if (id) openSession(id);
}

async function loadList() {
  try { S.sessions = await store.listSubmissions(); }
  catch (err) { $('#list').innerHTML = `<p class="c-none">${esc(err.message)}</p>`; return; }
  renderList();
}

function renderList() {
  const list = S.sessions.filter((s) => S.filter === 'all' || s.status === S.filter);
  $('#list').innerHTML = list.length ? '' : `<p class="c-none">${S.filter === 'submitted' ? 'Nothing waiting for review.' : 'No sessions.'}</p>`;
  for (const s of list) {
    const b = h(`<button class="c-item ${S.current?.id === s.id ? 'on' : ''}">
      <b>${esc(s.student_name)}</b>
      <span class="badge ${s.mode}">${s.mode === 'expert' ? 'Assessor' : 'Friend'}</span><span class="badge status-${s.status}">${s.status === 'reviewed' ? 'Sent' : 'To review'}</span>
      <small>${s.answers.length} answer${s.answers.length === 1 ? '' : 's'} · ${fmtDate(s.submitted_at || s.created_at)}</small></button>`);
    b.onclick = () => openSession(s.id);
    $('#list').append(b);
  }
}

async function openSession(id) {
  const s = await store.getSessionForCoach(id);
  if (!s) return;
  S.current = s;
  S.tab = 0;
  S.notes = { ...(s.coach_feedback?.answers || {}) };
  history.replaceState(null, '', `?s=${id}`);
  renderList();
  renderDetail();
}

function renderDetail() {
  const s = S.current;
  const sent = s.status === 'reviewed';
  $('#detail').innerHTML = `
    <div class="c-head">
      <div><h1>${esc(s.student_name)}</h1><p><span class="badge ${s.mode}">${s.mode === 'expert' ? 'Assessor mode' : 'Friend mode'}</span>Submitted ${fmtDate(s.submitted_at || s.created_at)} · ${s.answers.length} answer${s.answers.length === 1 ? "" : "s"}</p></div>
    </div>
    ${sent ? `<div class="c-sent">Feedback sent ${fmtDate(s.reviewed_at)}${s.coach_feedback?.coach_name ? ` by ${esc(s.coach_feedback.coach_name)}` : ''}. You can edit and resend it.</div>` : ''}
    <nav class="c-tabs" id="tabs">${s.answers.map((a, i) => `<button data-i="${i}" class="${i === S.tab ? 'on' : ''} ${S.notes[i] ? 'has-note' : ''}">Answer ${i + 1}</button>`).join('')}</nav>
    <div id="answer"></div>
    <div class="c-overall">
      <div><label for="overall">Overall feedback to ${esc(s.student_name)}</label><textarea id="overall" placeholder="What should they focus on next?">${esc(s.coach_feedback?.overall || '')}</textarea></div>
      <button class="btn" id="send">${sent ? 'Resend feedback' : 'Send feedback'}</button>
    </div>`;
  $$('#tabs button').forEach((b) => b.onclick = () => { saveNote(); S.tab = +b.dataset.i; renderDetail(); });
  $('#send').onclick = send;
  renderAnswer();
}

function saveNote() {
  const t = $('#note');
  if (t) S.notes[S.tab] = t.value;
}

const fmt = {
  pct: (v) => (v == null ? '—' : `${v}%`),
  n: (v, unit = '') => (v == null ? '—' : `${v}${unit}`),
};

function measurementRows(m) {
  const rows = [
    ['group', 'Speech'],
    ['Length', 'Total recording time', fmtDuration(m.durationSeconds)],
    ['Words', 'From the transcript', fmt.n(m.words)],
    ['Pace', 'Words per minute while speaking', fmt.n(m.wpm, ' wpm')],
    ['Time to first word', 'Seconds before speaking started', fmt.n(m.timeToFirstWord, 's')],
    ['Filler sounds', 'um / uh / er (transcription often misses these)', fmt.n(m.fillerCount)],
    ['Filler phrases', 'you know, kind of, basically…', Object.entries(m.fillerPhrases || {}).map(([k, v]) => `${k} ×${v}`).join(', ') || '—'],
    ['Pauses over 2s', 'Silences after speaking began', fmt.n(m.pauseCount)],
    ['Longest pause', '', fmt.n(m.longestPause, 's')],
    ['group', 'Voice'],
    ['Pitch variation', 'Spread of pitch in semitones (low = flatter delivery)', fmt.n(m.pitchVariation, ' st')],
    ['Volume variation', 'Spread of loudness in dB', fmt.n(m.volumeVariation, ' dB')],
  ];
  if (m.camera && m.faceTracked) {
    rows.push(
      ['group', 'Camera'],
      ['In frame', 'Face detected inside the guide', fmt.pct(m.inFramePct)],
      ['Looking at camera', 'Head and eyes facing the lens', fmt.pct(m.eyeContactPct)],
      ['Smiling', 'Share of time the smile movement was detected', fmt.pct(m.smilePct)],
      ['Blinks', 'Per minute', fmt.n(m.blinksPerMinute, '/min')],
      ['Head movement', 'Spread of head angle in degrees', fmt.n(m.headMovement, '°')],
    );
  } else rows.push(['group', m.camera ? 'Camera on, but face tracking was unavailable' : 'Camera off for this answer']);
  return rows.map((r) => (r[0] === 'group'
    ? `<tr class="group"><td colspan="2">${r[1]}</td></tr>`
    : `<tr><td>${r[0]}${r[1] ? `<small>${r[1]}</small>` : ''}</td><td>${esc(r[2])}</td></tr>`)).join('');
}

async function renderAnswer() {
  const a = S.current.answers[S.tab];
  if (!a) return;
  const an = a.analysis || {};
  const m = an.metrics || a.student_metrics || {};
  const f = a.ai_feedback || {};
  const box = $('#answer');
  box.innerHTML = `
    <p class="c-q"><small>${esc(a.category || '')}</small>${esc(a.question)}</p>
    <div class="c-main">
      <div>
        <div class="c-player" id="player"><div class="c-novideo">Loading recording…</div></div>
        <div class="card" style="margin-top:16px"><h4>Transcript</h4><p class="c-transcript">${esc(a.transcript) || '<em>No speech was transcribed.</em>'}</p></div>
      </div>
      <div>
        <div class="card"><h4>Measurements</h4>
          <p class="caveat">These describe what was visible or audible. They are not signs of emotion, confidence or ability, and lighting, glasses and microphones all affect them.</p>
          <table class="m-table">${measurementRows(m)}</table></div>
        <div class="card ai-draft"><h4>AI content notes (draft, ${S.current.mode === 'expert' ? 'assessor' : 'friend'} voice)</h4>
          ${f.overall ? `<p>${esc(f.overall)}</p>` : '<p>No AI notes.</p>'}
          ${f.improvements?.length ? `<p class="label">Improvements</p><ul>${f.improvements.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          ${f.strengths?.length ? `<p class="label">Strengths</p><ul>${f.strengths.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          ${f.star ? `<p class="label">STAR: ${['situation', 'task', 'action', 'result'].map((k) => `${k[0].toUpperCase()} ${f.star[k] ? '✓' : '✗'}`).join(' · ')}</p>` : ''}
          ${f.source === 'sample' ? '<p class="label">Sample feedback (AI was not connected).</p>' : ''}
        </div>
        <div class="card c-note">
          <div class="row"><h4 style="margin:0">Your note on this answer</h4><button class="linkbtn" id="insert-ai">Insert AI notes</button></div>
          <textarea id="note" placeholder="Shown to the student under this answer.">${esc(S.notes[S.tab] || '')}</textarea>
        </div>
      </div>
    </div>`;

  $('#note').addEventListener('input', () => { saveNote(); $(`#tabs button[data-i="${S.tab}"]`)?.classList.toggle('has-note', !!$('#note').value); });
  $('#insert-ai').onclick = () => {
    const lines = [f.overall, ...(f.improvements || []).map((x) => `• ${x}`)].filter(Boolean).join('\n');
    const t = $('#note');
    t.value = t.value ? `${t.value}\n\n${lines}` : lines;
    saveNote();
  };

  // Player + timeline
  const url = await store.videoUrl(a);
  const player = $('#player');
  if (!url) { player.innerHTML = '<div class="c-novideo">No recording stored for this answer.</div>'; return; }
  const isVideo = a.has_video !== false && !/^audio/.test(a.mime_type || '');
  player.innerHTML = isVideo ? `<video id="media" src="${url}" controls playsinline preload="metadata"></video>` : `<audio id="media" src="${url}" controls preload="metadata"></audio>`;
  const media = $('#media');
  const dur = a.duration_s || m.durationSeconds || 1;
  const events = an.events || [];
  const audioTl = an.timeline?.audio || [];

  // Spoken segments as a faint band, events as coloured markers.
  let speechHtml = '';
  let start = null;
  audioTl.forEach((p, i) => {
    if (p.v && start === null) start = p.t;
    if ((!p.v || i === audioTl.length - 1) && start !== null) {
      speechHtml += `<div class="speech" style="left:${(start / dur) * 100}%;width:${Math.max(0.3, ((p.t - start) / dur) * 100)}%"></div>`;
      start = null;
    }
  });
  const tl = h(`<div class="c-timeline" title="Click to jump">${speechHtml}${events.map((e) => `<div class="ev ${e.type}" style="left:${(e.t / dur) * 100}%;width:${Math.max(0.6, (e.dur / dur) * 100)}%" title="${esc(e.label)} at ${fmtDuration(e.t)}"></div>`).join('')}<div class="head" id="head"></div></div>`);
  tl.onclick = (e) => { const r = tl.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * dur); };
  player.append(tl);
  player.append(h(`<div class="c-legend"><span><i style="background:#59626e"></i>Speaking</span><span><i style="background:#8a93a0"></i>Pause &gt; 2s</span><span><i style="background:#e2a33b"></i>Looked away &gt; 3s</span><span><i style="background:#e5484d"></i>Out of frame</span></div>`));
  if (events.length) {
    const ul = h(`<ul class="c-events">${events.map((e) => `<li data-t="${e.t}"><span>${fmtDuration(e.t)}</span>${esc(e.label)}</li>`).join('')}</ul>`);
    ul.querySelectorAll('li').forEach((li) => li.onclick = () => seek(+li.dataset.t));
    player.append(ul);
  }
  function seek(t) {
    // MediaRecorder webm files often report Infinity duration until fully scanned.
    try { media.currentTime = Math.max(0, t - 1); media.play(); } catch { /* ignore */ }
  }
  media.addEventListener('timeupdate', () => { $('#head').style.left = `${(media.currentTime / dur) * 100}%`; });
}

async function send() {
  saveNote();
  const overall = $('#overall').value.trim();
  const answers = Object.fromEntries(Object.entries(S.notes).filter(([, v]) => v && v.trim()));
  if (!overall && !Object.keys(answers).length) return toast('Write some feedback first');
  try {
    await store.sendCoachFeedback(S.current.id, { overall, answers }, S.user.name);
    toast('Feedback sent to the student');
    await loadList();
    await openSession(S.current.id);
  } catch (err) { toast(err.message); }
}

init();
