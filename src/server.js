require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('./db');
const { verifyInitData } = require('./auth');
const { bot, notifyMatch, notifyAdminReport } = require('./bot');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const UPLOADS = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const CLASS_LETTERS = ['Фил', 'Ист', 'Общ', 'Био1', 'Био2', 'Хим', 'ЭГ', 'ИМ', 'ИФ', 'М1', 'М2', 'Ф'];
const CLASSES = ['10', '11'].flatMap((g) => CLASS_LETTERS.map((l) => g + l));

const app = express();
app.use(express.json());
// no-cache: Telegram-webview всегда перепроверяет свежесть интерфейса
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  })
);
// имена файлов — случайные UUID, ссылки не перебираются
app.use('/uploads', express.static(UPLOADS, { immutable: true, maxAge: '30d' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (req, file, cb) => {
      const ext = { 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype] || '.jpg';
      cb(null, crypto.randomUUID() + ext);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// ---------- вспомогательные ----------
const getUser = db.prepare('SELECT * FROM users WHERE tg_id = ?');

function publicProfile(u) {
  return { tg_id: u.tg_id, username: u.username, name: u.name, klass: u.klass, gender: u.gender, photo: u.photo };
}

function ownProfile(u) {
  return { ...publicProfile(u), looking: u.looking, hidden: u.hidden };
}

function deletePhotoFile(name) {
  if (!name) return;
  fs.promises.unlink(path.join(UPLOADS, name)).catch(() => {});
}

async function downloadAvatar(tgId) {
  const photos = await bot.api.getUserProfilePhotos(tgId, { limit: 1 });
  if (!photos.total_count) return null;
  const sizes = photos.photos[0];
  const fileId = sizes[sizes.length - 1].file_id; // самый крупный размер
  const file = await bot.api.getFile(fileId);
  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

function validateProfile(body) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 40) return null;
  if (!CLASSES.includes(body.klass)) return null;
  if (!['m', 'f'].includes(body.gender)) return null;
  return { name, klass: body.klass, gender: body.gender, looking: body.looking === '0' ? 0 : 1 };
}

// ---------- авторизация ----------
function auth(req, res, next) {
  const tgUser = verifyInitData(req.get('x-init-data') || '', BOT_TOKEN);
  if (!tgUser) return res.status(401).json({ error: 'Не атрымалася пацвердзіць аўтарызацыю Telegram' });
  req.tg = tgUser;
  const me = getUser.get(tgUser.id);
  if (me && me.banned) return res.status(403).json({ error: 'banned' });
  req.me = me || null;
  next();
}

app.use('/api', auth);

// ---------- профиль ----------
app.get('/api/me', (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  res.json(ownProfile(req.me));
});

// превью аватарки Telegram на шаге регистрации
app.get('/api/avatar', async (req, res) => {
  try {
    const buf = await downloadAvatar(req.tg.id);
    if (!buf) return res.status(404).json({ error: 'У цябе няма аватаркі ў Telegram' });
    res.type('image/jpeg').send(buf);
  } catch {
    res.status(500).json({ error: 'Не атрымалася загрузіць аватарку' });
  }
});

// регистрация и редактирование — один обработчик
app.post('/api/me', upload.single('photo'), async (req, res) => {
  const fields = validateProfile(req.body);
  if (!fields) {
    deletePhotoFile(req.file?.filename);
    return res.status(400).json({ error: 'Правер запаўненне анкеты' });
  }

  let photo = req.file?.filename || null;
  if (!photo && req.body.use_avatar === '1') {
    try {
      const buf = await downloadAvatar(req.tg.id);
      if (buf) {
        photo = crypto.randomUUID() + '.jpg';
        await fs.promises.writeFile(path.join(UPLOADS, photo), buf);
      }
    } catch {
      /* обработано ниже */
    }
    if (!photo) return res.status(400).json({ error: 'Не атрымалася ўзяць аватарку з Telegram — загрузі фота файлам' });
  }

  const username = req.tg.username || null;

  if (!req.me) {
    if (!photo) return res.status(400).json({ error: 'Фота абавязковае' });
    db.prepare(
      'INSERT INTO users (tg_id, username, name, klass, gender, looking, photo) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.tg.id, username, fields.name, fields.klass, fields.gender, fields.looking, photo);
  } else {
    if (photo) deletePhotoFile(req.me.photo);
    db.prepare(
      'UPDATE users SET username=?, name=?, klass=?, gender=?, looking=?, photo=? WHERE tg_id=?'
    ).run(username, fields.name, fields.klass, fields.gender, fields.looking, photo || req.me.photo, req.tg.id);
  }

  res.json(ownProfile(getUser.get(req.tg.id)));
});

app.patch('/api/me/looking', (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  const looking = req.body.looking ? 1 : 0;
  db.prepare('UPDATE users SET looking=? WHERE tg_id=?').run(looking, req.tg.id);
  res.json({ looking });
});

app.delete('/api/me', (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  deletePhotoFile(req.me.photo);
  db.prepare('DELETE FROM users WHERE tg_id=?').run(req.tg.id);
  db.prepare('DELETE FROM likes WHERE from_id=? OR to_id=?').run(req.tg.id, req.tg.id);
  db.prepare('DELETE FROM reports WHERE from_id=? OR to_id=?').run(req.tg.id, req.tg.id);
  res.json({ ok: true });
});

// ---------- лента ----------
app.get('/api/feed', (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  const wanted = req.me.gender === 'm' ? 'f' : 'm';
  const rows = db.prepare(
    `SELECT * FROM users
     WHERE gender = ? AND looking = 1 AND banned = 0 AND hidden = 0 AND tg_id != ?
       AND tg_id NOT IN (SELECT to_id FROM likes WHERE from_id = ?)
     ORDER BY RANDOM() LIMIT 10`
  ).all(wanted, req.tg.id, req.tg.id);
  res.json(rows.map(publicProfile));
});

app.post('/api/swipe', async (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  const toId = Number(req.body.to_id);
  const liked = req.body.liked ? 1 : 0;
  const target = getUser.get(toId);
  if (!target || toId === req.tg.id || target.gender === req.me.gender) {
    return res.status(400).json({ error: 'Няправільная анкета' });
  }

  // пропуск можно «повысить» до лайка (например, из просмотра по классам), обратно — нет
  const existing = db.prepare('SELECT liked FROM likes WHERE from_id=? AND to_id=?').get(req.tg.id, toId);
  let newlyLiked = false;
  if (!existing) {
    db.prepare('INSERT INTO likes (from_id, to_id, liked) VALUES (?, ?, ?)').run(req.tg.id, toId, liked);
    newlyLiked = !!liked;
  } else if (liked && !existing.liked) {
    db.prepare('UPDATE likes SET liked=1 WHERE from_id=? AND to_id=?').run(req.tg.id, toId);
    newlyLiked = true;
  }

  let match = null;
  if (newlyLiked) {
    const mutual = db.prepare('SELECT 1 FROM likes WHERE from_id=? AND to_id=? AND liked=1').get(toId, req.tg.id);
    if (mutual) {
      match = publicProfile(target);
      notifyMatch(req.me, target).catch(() => {});
    }
  }
  res.json({ ok: true, match });
});

// профили выбранного класса (противоположный пол, кого ещё не лайкал)
app.get('/api/class/:klass', (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  const klass = req.params.klass;
  if (!CLASSES.includes(klass)) return res.status(400).json({ error: 'Няма такога класа' });
  const wanted = req.me.gender === 'm' ? 'f' : 'm';
  const rows = db.prepare(
    `SELECT * FROM users
     WHERE klass = ? AND gender = ? AND looking = 1 AND banned = 0 AND hidden = 0 AND tg_id != ?
       AND tg_id NOT IN (SELECT to_id FROM likes WHERE from_id = ? AND liked = 1)
     ORDER BY name`
  ).all(klass, wanted, req.tg.id, req.tg.id);
  res.json(rows.map(publicProfile));
});

app.get('/api/matches', (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  const rows = db.prepare(
    `SELECT u.* FROM users u
     JOIN likes l1 ON l1.to_id = u.tg_id AND l1.from_id = ? AND l1.liked = 1
     JOIN likes l2 ON l2.from_id = u.tg_id AND l2.to_id = ? AND l2.liked = 1
     WHERE u.banned = 0
     ORDER BY l2.created_at DESC`
  ).all(req.tg.id, req.tg.id);
  res.json(rows.map(publicProfile));
});

// ---------- жалобы ----------
app.post('/api/report', (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  const toId = Number(req.body.to_id);
  const target = getUser.get(toId);
  if (!target || toId === req.tg.id) return res.status(400).json({ error: 'Няправільная анкета' });

  db.prepare('INSERT OR IGNORE INTO reports (from_id, to_id) VALUES (?, ?)').run(req.tg.id, toId);
  const count = db.prepare('SELECT COUNT(*) c FROM reports WHERE to_id=?').get(toId).c;
  if (count >= 3) db.prepare('UPDATE users SET hidden=1 WHERE tg_id=?').run(toId);
  notifyAdminReport(target, count).catch(() => {});
  res.json({ ok: true });
});

// ---------- запуск ----------
if (!BOT_TOKEN) {
  console.error('Не задан BOT_TOKEN — заполни файл .env (см. .env.example)');
  process.exit(1);
}

app.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));
bot
  .start({ onStart: (info) => console.log(`Бот запущен: @${info.username}`) })
  .catch((e) => console.error('Бот не запустился:', e.message));
