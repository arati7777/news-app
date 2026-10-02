let token = localStorage.t || '', user = JSON.parse(localStorage.u || 'null'), page = 0, loading = false, done = false, curArt = null;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => (/^https?:\/\//.test(u || '') ? esc(u) : '');
const isAdmin = () => user && user.role === 'admin';

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body && JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Error');
  return d;
}

function renderBar() {
  $('#bar').innerHTML = user
    ? `<span>👤 ${esc(user.username)} (${user.role})</span>${isAdmin() ? '<button id="addBtn">+ Article</button><button id="refBtn">⟳ Fetch news</button>' : ''}<button id="outBtn">Logout</button>`
    : '<button id="inBtn">Login / Register</button>';
  if ($('#inBtn')) $('#inBtn').onclick = () => $('#authD').showModal();
  if ($('#outBtn')) $('#outBtn').onclick = () => { localStorage.clear(); token = ''; user = null; renderBar(); load(true); };
  if ($('#addBtn')) $('#addBtn').onclick = () => $('#addD').showModal();
  if ($('#refBtn')) $('#refBtn').onclick = async () => { await api('/refresh', 'POST'); load(true); loadCats(); };
}

function card(a) {
  const el = document.createElement('article'); el.className = 'card';
  el.innerHTML = `${safeUrl(a.image) ? `<img loading="lazy" src="${safeUrl(a.image)}" alt="">` : ''}
  <div class="b"><span class="tag">${esc(a.category)} · ${esc(a.source)}</span>
  <h2>${esc(a.title)}</h2><p>${esc(a.summary)}</p>
  ${a.content ? `<p class="full" hidden>${esc(a.content)}</p><a href="#" class="more">Read more</a>` : ''}
  ${safeUrl(a.url) ? `<a href="${safeUrl(a.url)}" target="_blank" rel="noopener">Original source ↗</a>` : ''}
  <div class="row"><button class="fb">💬 Feedback</button>
  ${isAdmin() ? '<button class="up">▲</button><button class="dn">▼</button><button class="del">🗑 Delete</button>' : ''}</div></div>`;
  const m = el.querySelector('.more');
  if (m) m.onclick = e => { e.preventDefault(); el.querySelector('.full').hidden = false; m.remove(); };
  el.querySelector('.fb').onclick = () => openComments(a.id);
  if (isAdmin()) {
    el.querySelector('.up').onclick = async () => { await api(`/articles/${a.id}/move`, 'POST', { dir: 'up' }); load(true); };
    el.querySelector('.dn').onclick = async () => { await api(`/articles/${a.id}/move`, 'POST', { dir: 'down' }); load(true); };
    el.querySelector('.del').onclick = async () => { if (confirm('Delete this article?')) { await api('/articles/' + a.id, 'DELETE'); el.remove(); } };
  }
  return el;
}

async function load(reset) {
  if (reset) { page = 0; done = false; $('#feed').innerHTML = ''; $('#end').hidden = true; }
  if (loading || done) return;
  loading = true;
  try {
    const list = await api('/articles?' + new URLSearchParams({ page: page++, q: $('#q').value, category: $('#cat').value }));
    list.forEach(a => $('#feed').append(card(a)));
    if (list.length < 10) { done = true; $('#end').hidden = false; }
  } finally { loading = false; }
}
async function loadCats() {
  const cur = $('#cat').value, cats = await api('/categories');
  $('#cat').innerHTML = '<option value="">All</option>' + cats.map(c => `<option>${esc(c)}</option>`).join('');
  $('#cat').value = cur;
}

// auth
async function auth(kind) {
  try {
    const d = await api('/' + kind, 'POST', { username: $('#u').value, password: $('#p').value });
    token = d.token; user = d.user; localStorage.t = token; localStorage.u = JSON.stringify(user);
    $('#authD').close(); $('#p').value = ''; $('#authErr').textContent = ''; renderBar(); load(true);
  } catch (e) { $('#authErr').textContent = e.message; }
}
$('#loginB').onclick = () => auth('login');
$('#regB').onclick = () => auth('register');

// add article (admin)
$('#addB').onclick = async () => {
  try {
    await api('/articles', 'POST', { title: $('#aT').value, category: $('#aC').value, image: $('#aI').value, summary: $('#aS').value, content: $('#aB').value });
    $('#addD').close(); ['#aT', '#aC', '#aI', '#aS', '#aB'].forEach(s => $(s).value = ''); load(true); loadCats();
  } catch (e) { alert(e.message); }
};

// feedback
async function openComments(id) {
  curArt = id; $('#comForm').hidden = !user;
  const list = await api(`/articles/${id}/comments`);
  $('#comList').style.display = 'block';
  $('#comList').innerHTML = list.map(c => `<span class="com"><b>${esc(c.username)}</b>: ${esc(c.text)}
    ${isAdmin() ? `<a href="#" data-d="${c.id}">delete</a>` : ''}</span>`).join('') || '<p>No feedback yet.</p>';
  $('#comList').querySelectorAll('[data-d]').forEach(a => a.onclick = async e => { e.preventDefault(); await api('/comments/' + a.dataset.d, 'DELETE'); openComments(id); });
  if (!$('#comD').open) $('#comD').showModal();
}
$('#comB').onclick = async () => {
  try { await api(`/articles/${curArt}/comments`, 'POST', { text: $('#comT').value }); $('#comT').value = ''; openComments(curArt); }
  catch (e) { alert(e.message); }
};

// infinite scroll + search
new IntersectionObserver(e => e[0].isIntersecting && load(), { rootMargin: '400px' }).observe($('#sentinel'));
let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(() => load(true), 300); };
$('#cat').onchange = () => load(true);
renderBar(); loadCats(); load();
