const express = require('express'), Database = require('better-sqlite3');
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const app = express(), db = new Database('news.db');
const SECRET = process.env.SECRET || 'change-this-secret';
app.use(express.json());
app.use(express.static('public'));

db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'user');
CREATE TABLE IF NOT EXISTS articles(id INTEGER PRIMARY KEY, title TEXT, summary TEXT, content TEXT, image TEXT, url TEXT UNIQUE,
  source TEXT, category TEXT, position INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY, article_id INTEGER, username TEXT, text TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

// ---- auth ----
app.use((req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').slice(7), SECRET); } catch {}
  next();
});
const need = role => (req, res, next) =>
  !req.user ? res.status(401).json({ error: 'Please log in' }) :
  role && req.user.role !== role ? res.status(403).json({ error: 'Admin only' }) : next();
const sign = u => ({ token: jwt.sign({ id: u.id, username: u.username, role: u.role }, SECRET, { expiresIn: '7d' }), user: { username: u.username, role: u.role } });

app.post('/api/register', (req, res) => {
  const { username = '', password = '' } = req.body;
  if (!/^\w{3,20}$/.test(username)) return res.status(400).json({ error: 'Username: 3-20 letters/numbers/_' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return res.status(400).json({ error: 'Username taken' });
  const role = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0 ? 'admin' : 'user'; // first user = admin
  const id = db.prepare('INSERT INTO users(username,password,role) VALUES(?,?,?)').run(username, bcrypt.hashSync(password, 10), role).lastInsertRowid;
  res.json(sign({ id, username, role }));
});
app.post('/api/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(req.body.username || '');
  if (!u || !bcrypt.compareSync(req.body.password || '', u.password)) return res.status(401).json({ error: 'Wrong username or password' });
  res.json(sign(u));
});

// ---- articles ----
const nextPos = () => db.prepare('SELECT IFNULL(MAX(position),0)+1 p FROM articles').get().p;
const httpOnly = u => (/^https?:\/\//.test(u || '') ? u : null);

app.get('/api/articles', (req, res) => {
  const page = Math.max(0, +req.query.page || 0), q = `%${req.query.q || ''}%`, cat = req.query.category || '';
  res.json(db.prepare(`SELECT * FROM articles WHERE (title LIKE ? OR summary LIKE ?) AND (?='' OR category=?)
    ORDER BY position DESC LIMIT 10 OFFSET ?`).all(q, q, cat, cat, page * 10));
});
app.get('/api/categories', (req, res) =>
  res.json(db.prepare('SELECT DISTINCT category FROM articles WHERE category IS NOT NULL').all().map(r => r.category)));

app.post('/api/articles', need('admin'), (req, res) => {
  const { title, summary, content, image, category } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  db.prepare('INSERT INTO articles(title,summary,content,image,source,category,position) VALUES(?,?,?,?,?,?,?)')
    .run(title, summary || '', content || '', httpOnly(image), 'Editorial', category || 'General', nextPos());
  res.json({ ok: true });
});
app.delete('/api/articles/:id', need('admin'), (req, res) => {
  db.prepare('DELETE FROM articles WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM comments WHERE article_id=?').run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/articles/:id/move', need('admin'), (req, res) => {   // dir: up | down
  const a = db.prepare('SELECT * FROM articles WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const up = req.body.dir === 'up';
  const b = db.prepare(`SELECT * FROM articles WHERE position ${up ? '>' : '<'} ? ORDER BY position ${up ? 'ASC' : 'DESC'} LIMIT 1`).get(a.position);
  if (b) db.transaction(() => {
    db.prepare('UPDATE articles SET position=? WHERE id=?').run(b.position, a.id);
    db.prepare('UPDATE articles SET position=? WHERE id=?').run(a.position, b.id);
  })();
  res.json({ ok: true });
});
app.post('/api/refresh', need('admin'), async (req, res) => { await fetchNews(); res.json({ ok: true }); });

// ---- feedback / comments ----
app.get('/api/articles/:id/comments', (req, res) =>
  res.json(db.prepare('SELECT * FROM comments WHERE article_id=? ORDER BY id DESC').all(req.params.id)));
app.post('/api/articles/:id/comments', need(), (req, res) => {
  const text = (req.body.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'Write something first' });
  db.prepare('INSERT INTO comments(article_id,username,text) VALUES(?,?,?)').run(req.params.id, req.user.username, text);
  res.json({ ok: true });
});
app.delete('/api/comments/:id', need('admin'), (req, res) => {
  db.prepare('DELETE FROM comments WHERE id=?').run(req.params.id); res.json({ ok: true });
});

// ---- pull news from free APIs ----
async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(r.status); return r.json(); }
async function fetchNews() {
  const ins = db.prepare(`INSERT OR IGNORE INTO articles(title,summary,image,url,source,category,position) VALUES(?,?,?,?,?,?,?)`);
  const add = (t, s, i, u, src, c) => t && u && ins.run(t, s, httpOnly(i), u, src, c, nextPos());
  const jobs = [
    async () => (await getJSON('https://api.spaceflightnewsapi.net/v4/articles/?limit=20')).results   // no key
      .reverse().forEach(a => add(a.title, a.summary, a.image_url, a.url, a.news_site, 'Space')),
    async () => {                                                                                       // no key
      const ids = (await getJSON('https://hacker-news.firebaseio.com/v0/topstories.json')).slice(0, 15).reverse();
      for (const id of ids) { const a = await getJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        if (a && a.url) add(a.title, `${a.score} points · by ${a.by}`, null, a.url, 'Hacker News', 'Tech'); }
    },
  ];
  if (process.env.GNEWS_KEY) jobs.push(async () =>                                                       // free key: gnews.io
    (await getJSON(`https://gnews.io/api/v4/top-headlines?lang=en&max=10&apikey=${process.env.GNEWS_KEY}`)).articles
      .reverse().forEach(a => add(a.title, a.description, a.image, a.url, a.source.name, 'World')));
  if (process.env.NEWSDATA_KEY) jobs.push(async () =>                                                    // free key: newsdata.io
    (await getJSON(`https://newsdata.io/api/1/latest?language=en&apikey=${process.env.NEWSDATA_KEY}`)).results
      .reverse().forEach(a => add(a.title, a.description, a.image_url, a.link, a.source_name, (a.category || ['General'])[0])));
  for (const j of jobs) try { await j(); } catch (e) { console.log('API fetch failed:', e.message); }
}
fetchNews(); setInterval(fetchNews, 30 * 60 * 1000);

app.listen(3000, () => console.log('NewsHub running → http://localhost:3000'));
