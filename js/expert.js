// Assessor mode: strict, timed, camera required, no retakes, feedback at the end.
import { CONFIG } from './config.js';
import { openMedia, stopStream, describeMediaError, AudioAnalyser, formatTime } from './media.js';
import { FaceTracker } from './face.js';
import { AnswerCapture } from './capture.js';
import { speak, stopSpeaking, speechSupported } from './speech.js';
import { getFeedback } from './ai.js';
import { store, previousMetrics } from './store.js';
import { $, esc, sleep, loadQuestions, pickQuestions, renderDemoBanner, requireUser, studentMetricItems, toast } from './ui.js';

const S = { stream: null, analyser: null, face: null, faceOk: false, session: null, questions: [], results: [], inInterview: false };

const show = (id) => {
  ['s-intro', 's-check', 's-wait', 's-results'].forEach((s) => $(`#${s}`).classList.toggle('hidden', s !== id));
  window.scrollTo(0, 0);
};

async function init() {
  renderDemoBanner($('#demo'));
  await requireUser();
  S.allQuestions = await loadQuestions();
  $('#r-count').textContent = CONFIG.EXPERT_QUESTION_COUNT;
  $('#r-prep').textContent = `${CONFIG.EXPERT_PREP_SECONDS}s`;
  $('#to-check').onclick = startCheck;
  $('#exit').onclick = (e) => {
    if (S.inInterview && !confirm('Leave the interview? It will end now and nothing will be submitted.')) e.preventDefault();
  };
  if (!speechSupported()) toast('Live transcription needs Chrome or Edge. Your answers will still be recorded.', 6000);
}

// --------------------------------------------------------------------------
// System check
// --------------------------------------------------------------------------
async function startCheck() {
  show('s-check');
  const msg = $('#check-msg');
  try {
    S.stream = await openMedia({ video: true });
  } catch (err) {
    msg.textContent = describeMediaError(err);
    msg.style.color = '#f08a8d';
    return;
  }
  const video = $('#video');
  video.srcObject = S.stream;
  $('#c-cam').classList.add('ok');
  S.stream.getVideoTracks()[0].addEventListener('ended', cameraLost);

  S.analyser = new AudioAnalyser(S.stream);
  await S.analyser.resume();
  let micHeard = false;
  const meter = () => {
    if (!S.analyser) return;
    const lvl = S.analyser.read();
    $('#mic-meter').style.width = `${Math.min(100, lvl * 900)}%`;
    if (!S.inInterview && lvl > 0.02) { micHeard = true; $('#c-mic').classList.add('ok'); }
    S.meterRaf = requestAnimationFrame(meter);
  };
  meter();

  msg.textContent = 'Loading face tracking… Say a few words to test your microphone.';
  S.face = new FaceTracker(video);
  let framedSince = 0;
  S.face.onChange((st) => {
    const wrap = $('#video-wrap');
    wrap.classList.toggle('framed', st.framed);
    $('#c-face').classList.toggle('ok', st.present);
    $('#c-frame').classList.toggle('ok', st.framed);
    framedSince = st.framed ? framedSince || performance.now() : 0;
    if (S.inInterview) handleFraming(st);
  });
  S.face.start().then(() => { S.faceOk = true; }).catch((err) => {
    S.faceFailed = true;
    console.warn('Face tracking unavailable', err);
    ['#c-face', '#c-frame'].forEach((s) => $(s).classList.add('warn'));
    msg.textContent = 'Face tracking could not load (check your connection). You can continue, but framing will not be checked.';
  });

  const ready = setInterval(() => {
    const framedOk = S.faceOk ? framedSince && performance.now() - framedSince > 1000 : !!S.faceFailed;
    const ok = micHeard && framedOk;
    $('#begin').disabled = !ok;
    if (micHeard && S.faceOk && !framedOk) msg.textContent = 'Move so that your face sits inside the outline.';
    else if (ok && S.faceOk) msg.textContent = 'All checks passed. Remain in this position.';
    else if (ok) msg.textContent = 'Camera and microphone ready. Face tracking could not load, so framing will not be checked.';
  }, 200);

  $('#begin').onclick = () => { clearInterval(ready); runInterview(); };
}

let outSince = 0;
function handleFraming(st) {
  const wrap = $('#video-wrap');
  if (!S.faceOk) return;
  if (!st.framed) {
    outSince = outSince || performance.now();
    if (performance.now() - outSince > 800) { $('#frame-warning').classList.remove('hidden'); wrap.classList.add('out'); }
  } else {
    outSince = 0;
    $('#frame-warning').classList.add('hidden');
    wrap.classList.remove('out');
  }
}

function cameraLost() {
  if (!S.inInterview) return;
  S.inInterview = false;
  stopSpeaking();
  document.body.insertAdjacentHTML('beforeend', `<div class="toast show" style="background:#e5484d">The camera was turned off. The camera must stay on in assessor mode. This interview has ended.</div>`);
  setTimeout(() => location.reload(), 4000);
}

// --------------------------------------------------------------------------
// Interview
// --------------------------------------------------------------------------
async function runInterview() {
  S.inInterview = true;
  S.questions = pickQuestions(S.allQuestions, CONFIG.EXPERT_QUESTION_COUNT);
  try { S.session = await store.createSession({ mode: 'expert' }); }
  catch (err) { toast(`Could not start session: ${err.message}`); return; }

  $('#check-side').classList.add('hidden');
  $('#q-side').classList.remove('hidden');
  $('#video-wrap').classList.remove('framed');

  const pending = [];
  for (let i = 0; i < S.questions.length; i++) {
    if (!S.inInterview) return;
    const q = S.questions[i];
    $('#x-status').textContent = `Question ${i + 1} of ${S.questions.length}`;
    const cap = await askQuestion(q, i);
    if (!cap) return;
    pending.push(processAnswer(q, i, cap));

    show('s-wait');
    $('#wait-text').textContent = 'Response recorded.';
    await sleep(1400);
    if (i < S.questions.length - 1) {
      // A deliberate pause before the next question, like waiting on a real assessor.
      $('#wait-text').textContent = 'The assessor is preparing your next question…';
      await sleep(2600);
      show('s-check');
    }
  }

  S.inInterview = false;
  cancelAnimationFrame(S.meterRaf);
  S.face?.stop();
  S.analyser?.close(); S.analyser = null;
  stopStream(S.stream);
  $('#x-status').textContent = 'Assessment';
  $('#wait-text').textContent = 'Assessing your responses…';
  const [results] = await Promise.all([Promise.all(pending), sleep(2500)]);
  S.results = results;
  renderReport();
}

function askQuestion(q, i) {
  return new Promise((resolve) => {
    const total = S.questions.length;
    const phase = $('.x-phase');
    const timerEl = $('#timer');
    const prog = $('#progress');
    $('#q-num').textContent = `${i + 1} / ${total}`;
    $('#q-cat').textContent = q.category;
    $('#q-text').textContent = q.text;
    phase.classList.remove('answer');
    $('#phase-label').textContent = 'Preparation';
    $('#phase-hint').textContent = 'Recording will begin automatically when preparation ends.';
    $('#start-now').classList.remove('hidden');
    $('#finish').classList.add('hidden');
    $('#rec').classList.add('hidden');
    $('#video-wrap').classList.remove('recording');

    if ($('#tts').checked) speak(`Question ${i + 1}. ${q.text}`);

    const prepEnd = performance.now() + CONFIG.EXPERT_PREP_SECONDS * 1000;
    let cap = null;
    let answerEnd = 0;
    let done = false;

    const startAnswer = () => {
      if (cap) return;
      stopSpeaking();
      phase.classList.add('answer');
      $('#phase-label').textContent = 'Recording';
      $('#phase-hint').textContent = `Answer now. You can finish after ${CONFIG.EXPERT_MIN_ANSWER_SECONDS} seconds.`;
      $('#start-now').classList.add('hidden');
      const fin = $('#finish');
      fin.classList.remove('hidden');
      fin.disabled = true;
      $('#rec').classList.remove('hidden');
      $('#video-wrap').classList.add('recording');
      cap = new AnswerCapture({ stream: S.stream, analyser: S.analyser, face: S.faceOk ? S.face : null });
      cap.start();
      answerEnd = performance.now() + q.answerSeconds * 1000;
    };

    const finish = async () => {
      if (done || !cap) return;
      done = true;
      clearInterval(tick);
      $('#rec').classList.add('hidden');
      $('#video-wrap').classList.remove('recording');
      const result = await cap.stop();
      resolve(result);
    };

    $('#start-now').onclick = startAnswer;
    $('#finish').onclick = finish;

    const tick = setInterval(() => {
      if (!S.inInterview) { clearInterval(tick); resolve(null); return; }
      const now = performance.now();
      if (!cap) {
        const left = (prepEnd - now) / 1000;
        timerEl.textContent = formatTime(left);
        timerEl.classList.toggle('low', left <= 5);
        prog.style.width = `${100 - (left / CONFIG.EXPERT_PREP_SECONDS) * 100}%`;
        if (left <= 0) startAnswer();
      } else {
        const left = (answerEnd - now) / 1000;
        timerEl.textContent = formatTime(left);
        timerEl.classList.toggle('low', left <= 15);
        prog.style.width = `${100 - (left / q.answerSeconds) * 100}%`;
        $('#finish').disabled = cap.elapsed < CONFIG.EXPERT_MIN_ANSWER_SECONDS;
        if (left <= 0) finish();
      }
    }, 100);
  });
}

async function processAnswer(q, idx, cap) {
  const feedback = await getFeedback({
    mode: 'expert', question: q.text, category: q.category, transcript: cap.transcript,
    answerSeconds: q.answerSeconds, durationSeconds: cap.duration,
  });
  let saved = null;
  try { saved = await store.saveAnswer(S.session.id, { idx, question: q, ...cap, feedback }); }
  catch (err) { console.error(err); toast(`Could not save answer ${idx + 1}: ${err.message}`, 6000); }
  return { q, cap, feedback, saved };
}

// --------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------
async function renderReport() {
  const prev = await previousMetrics(S.session.id);
  const sample = S.results.some((r) => r.feedback.source === 'sample');
  const scoreRow = (label, v) => `<div class="x-score">${label}<div class="bar">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= v ? 'on' : ''}"></i>`).join('')}</div></div>`;

  const items = S.results.map(({ q, cap, feedback: f }, i) => `
    <article class="x-item">
      <div class="x-item-head"><p class="x-cat">Question ${i + 1} · ${esc(q.category)}</p><h3>${esc(q.text)}</h3></div>
      <div class="x-item-body">
        <div class="x-notes">
          <p class="overall">${esc(f.overall)}</p>
          ${f.improvements.length ? `<h4>Required improvements</h4><ul>${f.improvements.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          ${f.strengths.length ? `<h4>Evidence noted</h4><ul>${f.strengths.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          ${f.followUp ? `<h4>Likely follow-up</h4><div class="x-followup">${esc(f.followUp)}</div>` : ''}
        </div>
        <div class="x-scores">
          ${scoreRow('Relevance', f.scores.relevance)}${scoreRow('Structure', f.scores.structure)}${scoreRow('Specificity', f.scores.specificity)}${scoreRow('Impact', f.scores.impact)}
          <div class="x-star">${['situation', 'task', 'action', 'result'].map((k) => `<span class="${f.star[k] ? 'on' : ''}" title="${k}">${k[0].toUpperCase()}</span>`).join('')}</div>
          <div class="x-score">STAR coverage</div>
        </div>
      </div>
      <div class="x-metrics">${studentMetricItems(cap.studentMetrics, prev).map((m) => `<div>${m.label}<b>${esc(m.value)}</b>${m.extra}</div>`).join('')}</div>
      <details class="x-transcript"><summary>Transcript</summary><p>${esc(cap.transcript) || '<em>No speech was transcribed.</em>'}</p></details>
    </article>`).join('');

  $('#report').innerHTML = `
    <p class="x-label">Assessment report</p>
    <h1>Mock interview complete</h1>
    <p class="meta">${S.results.length} responses · Content assessed by AI · Delivery figures measured in your browser</p>
    ${sample ? '<p class="x-source">Sample feedback: AI is not connected yet. Add a key in Settings on the home page.</p>' : ''}
    ${items}
    <div class="x-submit" id="submit-box">
      <p>Submit this session to your coach. They will watch your recordings, see additional delivery measurements, and send you written feedback.</p>
      <div class="x-actions">
        <button class="x-btn ghost" id="again">New mock interview</button>
        <button class="x-btn danger" id="discard">Discard</button>
        <button class="x-btn" id="submit">Submit to coach</button>
      </div>
    </div>`;
  show('s-results');

  $('#again').onclick = () => location.reload();
  $('#discard').onclick = async () => {
    if (!confirm('Delete this session and its recordings?')) return;
    await store.deleteSession(S.session.id);
    location.href = 'index.html';
  };
  $('#submit').onclick = async (e) => {
    e.target.disabled = true;
    try {
      await store.submitSession(S.session.id);
      $('#submit-box').innerHTML = `<p>Submitted. Your coach will review this session. Their feedback will appear in <a href="inbox.html">My practice</a>.</p><div class="x-actions"><button class="x-btn ghost" onclick="location.reload()">New mock interview</button></div>`;
    } catch (err) { e.target.disabled = false; toast(err.message); }
  };
}

init();
