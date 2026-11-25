// Student view of past sessions and coach feedback.
// Shows only student-visible data (no face measurements).
import { store } from './store.js';
import { $, h, esc, fmtDate, renderDemoBanner, requireUser, studentMetricItems, toast } from './ui.js';

const STATUS = {
  draft: ['status-draft', 'Not submitted'],
  submitted: ['status-submitted', 'Waiting for your coach'],
  reviewed: ['status-reviewed', 'Coach feedback received'],
};

async function init() {
  renderDemoBanner($('#demo'));
  await requireUser();
  render();
}

async function render() {
  const box = $('#sessions');
  let sessions;
  try { sessions = await store.listMySessions(); } catch (err) { box.innerHTML = `<p>${esc(err.message)}</p>`; return; }
  sessions = sessions.filter((s) => s.answers.length);
  if (!sessions.length) { box.innerHTML = '<div class="card">No practice yet. Start a <a href="expert.html">mock interview</a> or <a href="peer.html">practise with Mia</a>.</div>'; return; }
  box.innerHTML = '';
  for (const s of sessions) box.append(sessionCard(s));
}

function sessionCard(s) {
  const [cls, label] = STATUS[s.status] || STATUS.draft;
  const cf = s.coach_feedback;
  const el = h(`<details class="card" ${s.status === 'reviewed' ? 'open' : ''}>
    <summary style="cursor:pointer;list-style:none">
      <span class="badge ${s.mode}">${s.mode === 'expert' ? 'Assessor' : 'Friend'}</span><span class="badge ${cls}">${label}</span>
      <b style="margin-left:4px">${fmtDate(s.created_at)}</b> <span style="color:#7a7f88">· ${s.answers.length} answer${s.answers.length === 1 ? '' : 's'}</span>
    </summary>
    <div style="margin-top:16px">
      ${cf?.overall ? `<div class="c-sent"><b>From ${esc(cf.coach_name || 'your coach')}:</b><br>${esc(cf.overall).replace(/\n/g, '<br>')}</div>` : ''}
      ${s.answers.map((a, i) => answerBlock(a, i, cf)).join('')}
      <div style="display:flex;gap:10px;margin-top:12px">
        ${s.status === 'draft' ? '<button class="btn" data-a="submit">Submit to coach</button>' : ''}
        <button class="btn ghost" data-a="delete">Delete session</button>
      </div>
    </div>
  </details>`);
  el.querySelector('[data-a=submit]')?.addEventListener('click', async () => {
    if (!confirm('Send this session to your coach? They will see your recordings and extra delivery measurements.')) return;
    await store.submitSession(s.id); toast('Submitted'); render();
  });
  el.querySelector('[data-a=delete]').addEventListener('click', async () => {
    if (!confirm('Delete this session and its recordings? This cannot be undone.')) return;
    await store.deleteSession(s.id); toast('Deleted'); render();
  });
  return el;
}

function answerBlock(a, i, cf) {
  const f = a.ai_feedback || {};
  const note = cf?.answers?.[i];
  const metrics = studentMetricItems(a.student_metrics).map((m) => `<span class="badge status-draft" style="font-size:12px">${m.label}: ${esc(m.value)}</span>`).join('');
  return `<div style="border-top:1px solid #eee;padding:14px 0">
    <p class="c-q" style="margin-bottom:8px;font-size:15.5px"><small>Answer ${i + 1} · ${esc(a.category || '')}</small>${esc(a.question)}</p>
    ${note ? `<div class="c-sent" style="margin-bottom:10px"><b>Coach:</b> ${esc(note).replace(/\n/g, '<br>')}</div>` : ''}
    ${f.overall ? `<p style="margin:0 0 6px;font-size:14.5px"><span style="color:#7a7f88">AI notes:</span> ${esc(f.overall)}</p>` : ''}
    ${f.improvements?.length ? `<ul style="margin:0 0 8px;font-size:14px">${f.improvements.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div style="display:flex;gap:6px;flex-wrap:wrap">${metrics}</div>
  </div>`;
}

init();
