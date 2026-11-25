import { isDemoMode } from './config.js';
import { store } from './store.js';
import { getDevKey, setDevKey } from './ai.js';
import { $, esc, renderDemoBanner, toast } from './ui.js';

renderDemoBanner($('#demo'));

async function init() {
  const user = await store.currentUser().catch(() => null);
  if (!user) {
    $('#signin').classList.remove('hidden');
    $('#signin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await store.signIn($('#email').value);
        $('#signin-msg').textContent = 'Check your inbox for the sign-in link.';
      } catch (err) { $('#signin-msg').textContent = err.message; }
    });
    return;
  }

  $('#main').classList.remove('hidden');
  const nav = $('#nav');
  nav.innerHTML = user.role === 'coach'
    ? `<a href="coach.html">Coach dashboard</a><a href="inbox.html">My practice</a>`
    : `<a href="inbox.html">My practice &amp; feedback</a>`;
  if (!user.demo) {
    nav.insertAdjacentHTML('beforeend', `<span style="color:#8a8f98">${esc(user.name)}</span><a href="#" id="signout">Sign out</a>`);
    $('#signout').onclick = async (e) => { e.preventDefault(); await store.signOut(); location.reload(); };
  }

  renderSettings(user);
}

function renderSettings(user) {
  const panel = $('#settings-panel');
  if (isDemoMode()) {
    panel.innerHTML = `
      <label>View as</label>
      <div class="seg" id="role-seg">
        <button data-role="student" class="${user.role === 'student' ? 'on' : ''}">Student</button>
        <button data-role="coach" class="${user.role === 'coach' ? 'on' : ''}">Coach</button>
      </div>
      <p class="hint">Demo only: switch roles to see both sides on one device.</p>
      <div style="height:18px"></div>
      <label for="devkey">Gemini API key (local testing only)</label>
      <div class="row">
        <input type="password" id="devkey" placeholder="Paste a key to get real AI feedback" value="${esc(getDevKey())}">
        <button class="btn ghost" id="savekey">Save</button>
      </div>
      <p class="hint">Stored only in this browser. Without a key you'll see clearly labelled sample feedback. For real use, the key lives on the server (see README).</p>`;
    panel.querySelectorAll('[data-role]').forEach((b) => b.onclick = async () => { await store.setDemoRole(b.dataset.role); location.reload(); });
    $('#savekey').onclick = () => { setDevKey($('#devkey').value); toast($('#devkey').value ? 'Key saved in this browser' : 'Key removed'); };
  } else {
    panel.innerHTML = `
      <label for="name">Your name (shown to your coach)</label>
      <div class="row"><input type="text" id="name" value="${esc(user.name)}"><button class="btn ghost" id="savename">Save</button></div>`;
    $('#savename').onclick = async () => { await store.updateName($('#name').value); toast('Saved'); };
  }
}

init();
