// Friend mode: chat-style practice, voice only is fine, camera optional,
// unlimited retries, warm feedback after every answer.
import { CONFIG } from './config.js';
import { openMedia, describeMediaError, AudioAnalyser } from './media.js';
import { FaceTracker } from './face.js';
import { AnswerCapture } from './capture.js';
import { speechSupported } from './speech.js';
import { getFeedback } from './ai.js';
import { store, previousMetrics } from './store.js';
import { $, h, esc, sleep, shuffle, loadQuestions, renderDemoBanner, requireUser, fmtDuration, delta, toast } from './ui.js';

const S = { stream: null, analyser: null, face: null, faceOk: false, cam: false, recording: null, session: null, answers: 0, queue: [], current: null, prev: null };
const chat = $('#chat');

const scrollDown = () => requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));

function addRow(inner, me = false) {
  const row = h(`<div class="p-row ${me ? 'me' : ''}">${me ? '' : '<div class="p-avatar sm">M</div>'}</div>`);
  row.append(typeof inner === 'string' ? h(inner) : inner);
  chat.append(row);
  scrollDown();
  return row;
}

async function miaSays(text, wait = 700) {
  const typing = addRow('<div class="p-bubble p-typing"><i></i><i></i><i></i></div>');
  await sleep(wait);
  typing.remove();
  return addRow(`<div class="p-bubble"><p>${text}</p></div>`);
}

function askCard(q) {
  S.current = q;
  const card = h(`<div class="p-qcard"><div class="cat">${esc(q.category)}</div><div class="q">${esc(q.text)}</div><button>🔊 Read it to me</button></div>`);
  card.querySelector('button').onclick = () => {
    const u = new SpeechSynthesisUtterance(q.text);
    u.lang = 'en-GB';
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  };
  addRow(card);
  $('#hint').textContent = 'Tap the mic when you’re ready. Take your time.';
}

function nextQuestion() {
  if (!S.queue.length) S.queue = shuffle(S.all);
  return S.queue.pop();
}

async function init() {
  renderDemoBanner($('#demo'));
  await requireUser();
  S.all = await loadQuestions();
  S.prev = await previousMetrics();

  chat.append(h(`<div class="p-day">Today</div>`));
  await miaSays('Hey! 👋 I’m Mia. I did loads of these video interviews last year, so let’s practise together.', 500);
  await miaSays('Just answer like it’s the real thing. There’s no timer and you can redo anything. Camera’s optional, voice is totally fine.', 900);
  await miaSays('Here’s one I actually got:', 600);
  askCard(nextQuestion());

  $('#mic').onclick = toggleRecording;
  $('#new-q').onclick = async () => {
    if (S.recording) return;
    await miaSays(pick(['Okay, try this one:', 'Ooh, how about this:', 'Here’s another classic:']), 500);
    askCard(nextQuestion());
  };
  $('#cam-toggle').onclick = toggleCamera;
  $('#send-coach').onclick = sendToCoach;
  if (!speechSupported()) toast('Live transcription needs Chrome or Edge. Your answers will still be recorded.', 6000);
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];

// --------------------------------------------------------------------------
// Media
// --------------------------------------------------------------------------
async function ensureAudio() {
  if (S.stream) return true;
  try {
    S.stream = await openMedia({ video: false });
    S.analyser = new AudioAnalyser(S.stream);
    await S.analyser.resume();
    return true;
  } catch (err) {
    await miaSays(`Hmm, I can’t hear you. ${esc(describeMediaError(err))}`, 300);
    return false;
  }
}

async function toggleCamera() {
  if (S.recording) return toast('Finish your answer first');
  const btn = $('#cam-toggle');
  if (!S.cam) {
    if (!(await ensureAudio())) return;
    try {
      const vs = await openMedia({ video: true });
      vs.getAudioTracks().forEach((t) => t.stop());
      const track = vs.getVideoTracks()[0];
      S.stream.addTrack(track);
      $('#video').srcObject = new MediaStream([track]);
      $('#pip').classList.remove('hidden');
      document.body.classList.add('cam-on');
      S.cam = true;
      btn.setAttribute('aria-pressed', 'true');
      btn.title = 'Turn camera off';
      if (!S.face) {
        S.face = new FaceTracker($('#video'));
        S.face.start().then(() => { S.faceOk = true; }).catch(() => { S.faceOk = false; });
      } else if (S.faceOk) { S.face.start(); }
    } catch (err) { toast(describeMediaError(err)); }
  } else {
    S.stream.getVideoTracks().forEach((t) => { t.stop(); S.stream.removeTrack(t); });
    $('#pip').classList.add('hidden');
    document.body.classList.remove('cam-on');
    S.face?.stop();
    S.cam = false;
    btn.setAttribute('aria-pressed', 'false');
    btn.title = 'Turn camera on';
  }
}

// --------------------------------------------------------------------------
// Recording
// --------------------------------------------------------------------------
async function toggleRecording() {
  if (S.recording) return stopRecording();
  if (S.busy) return;
  if (!(await ensureAudio())) return;
  const q = S.current;
  const cap = new AnswerCapture({
    stream: S.stream, analyser: S.analyser, face: S.cam && S.faceOk ? S.face : null,
    onTranscript: (t) => { $('#live-text').textContent = t || 'Listening…'; },
  });
  cap.start();
  S.recording = { cap, q };
  $('#mic').classList.add('rec');
  $('#mic').setAttribute('aria-label', 'Finish answer');
  $('#live').classList.remove('hidden');
  $('#live-text').textContent = 'Listening…';
  $('#hint').textContent = 'Tap again when you’re done';
  $('#new-q').disabled = true;
  $('#cam-toggle').disabled = true;
  $('#p-presence').textContent = 'listening…';

  const wave = $('#wave');
  wave.innerHTML = '';
  S.levels = [];
  S.liveTimer = setInterval(() => {
    const lvl = S.analyser.level;
    S.levels.push(lvl);
    const bar = document.createElement('i');
    bar.style.height = `${Math.max(3, Math.min(28, lvl * 260))}px`;
    wave.append(bar);
    if (wave.children.length > 80) wave.firstChild.remove();
    $('#live-time').textContent = fmtDuration(cap.elapsed);
    if (cap.elapsed >= CONFIG.PEER_MAX_ANSWER_SECONDS) stopRecording();
  }, 100);
}

async function stopRecording() {
  const r = S.recording;
  if (!r || r.stopping) return;
  if (r.cap.elapsed < 2) return toast('Say a bit more first 🙂', 1500);
  r.stopping = true;
  clearInterval(S.liveTimer);
  $('#mic').classList.remove('rec');
  $('#mic').disabled = true;
  $('#live').classList.add('hidden');
  $('#p-presence').textContent = 'typing…';
  const result = await r.cap.stop();
  S.recording = null;
  S.busy = true;

  addVoiceBubble(result, S.levels);
  const typing = addRow('<div class="p-bubble p-typing"><i></i><i></i><i></i></div>');
  const [fb] = await Promise.all([
    getFeedback({ mode: 'peer', question: r.q.text, category: r.q.category, transcript: result.transcript, answerSeconds: r.q.answerSeconds, durationSeconds: result.duration }),
    sleep(1400),
  ]);
  typing.remove();

  try {
    if (!S.session) S.session = await store.createSession({ mode: 'peer' });
    await store.saveAnswer(S.session.id, { idx: S.answers++, question: r.q, ...result, feedback: fb });
    $('#send-coach').disabled = false;
  } catch (err) { console.error(err); toast(`Couldn’t save that answer: ${err.message}`, 5000); }

  renderFeedback(fb, result.studentMetrics, r.q);
  S.busy = false;
  $('#mic').disabled = false;
  $('#mic').setAttribute('aria-label', 'Start answering');
  $('#new-q').disabled = false;
  $('#cam-toggle').disabled = false;
  $('#p-presence').textContent = 'here to practise with you';
  $('#hint').textContent = 'Tap the mic to answer';
}

function addVoiceBubble(result, levels) {
  const n = 34;
  const step = Math.max(1, Math.floor(levels.length / n));
  const bars = Array.from({ length: n }, (_, i) => {
    const seg = levels.slice(i * step, i * step + step);
    const v = seg.length ? Math.max(...seg) : 0;
    return `<i style="height:${Math.max(3, Math.min(24, v * 240))}px"></i>`;
  }).join('');
  const el = h(`<div class="p-bubble p-voice">
    <div class="top"><button class="play" aria-label="Play">▶</button><div class="bars">${bars}</div><span class="dur">${fmtDuration(result.duration)}</span></div>
    <div class="tx">${esc(result.transcript) || '<em>(no transcript)</em>'}</div></div>`);
  if (result.blob) {
    const media = document.createElement(result.hasVideo ? 'video' : 'audio');
    media.src = URL.createObjectURL(result.blob);
    el.append(media);
    const btn = el.querySelector('.play');
    btn.onclick = () => { if (media.paused) { media.play(); btn.textContent = '❚❚'; } else { media.pause(); btn.textContent = '▶'; } };
    media.onended = () => { btn.textContent = '▶'; };
  }
  addRow(el, true);
}

function renderFeedback(fb, m, q) {
  const stats = [];
  if (m.wpm) stats.push(`<span>${m.wpm} words/min${delta(m.wpm, S.prev?.wpm, { neutral: true })}</span>`);
  stats.push(`<span>${m.fillerCount} um/uh${delta(m.fillerCount, S.prev?.fillerCount, { lowerIsBetter: true })}</span>`);
  stats.push(`<span>${m.pauseCount} long pause${m.pauseCount === 1 ? '' : 's'}</span>`);
  if (m.eyeContactPct != null) stats.push(`<span>${m.eyeContactPct}% looking at camera${delta(m.eyeContactPct, S.prev?.eyeContactPct, { unit: '%' })}</span>`);

  addRow(`<div class="p-fb">
    <p>${esc(fb.overall)}</p>
    ${fb.strengths.length ? `<h5>What worked</h5><ul>${fb.strengths.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${fb.improvements.length ? `<h5>Maybe try</h5><ul>${fb.improvements.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="p-stats">${stats.join('')}</div>
    ${fb.source === 'sample' ? '<p class="sample">Sample feedback: AI isn’t connected yet (Settings on the home page).</p>' : ''}
  </div>`);
  if (fb.followUp) addRow(`<div class="p-bubble"><p>Also, I’m curious: ${esc(fb.followUp)}</p></div>`);

  const actions = h(`<div class="p-actions"><button data-a="again">Try that one again</button><button data-a="next">Next question</button></div>`);
  actions.querySelector('[data-a=again]').onclick = async () => { actions.remove(); await miaSays('Go for it! Same question:', 400); askCard(q); };
  actions.querySelector('[data-a=next]').onclick = async () => { actions.remove(); await miaSays(pick(['Nice. Next one:', 'Let’s keep going:', 'Okay, here’s a new one:']), 400); askCard(nextQuestion()); };
  chat.append(actions);
  scrollDown();
}

async function sendToCoach() {
  if (!S.session || S.recording) return;
  if (!confirm(`Send this chat's ${S.answers} answer${S.answers === 1 ? '' : 's'} to your coach? They'll see your recordings and some extra measurements.`)) return;
  try {
    await store.submitSession(S.session.id);
    S.session = null;
    S.answers = 0;
    $('#send-coach').disabled = true;
    await miaSays('Sent to your coach! 🎉 Their feedback will show up in <a href="inbox.html">My practice</a>. Want to keep going?', 400);
  } catch (err) { toast(err.message); }
}

init();
