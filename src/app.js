require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { webhookCallback } = require('grammy');
const { q, one } = require('./db');
const { verifyInitData } = require('./auth');
const { bot, ensureBotInit, notifyMatch, notifyAdminReport } = require('./bot');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

const CLASS_LETTERS = ['Фил', 'Ист', 'Общ', 'Био1', 'Био2', 'Хим', 'ЭГ', 'ИМ', 'ИФ', 'М1', 'М2', 'Ф'];
const CLASSES = ['10', '11'].flatMap((g) => CLASS_LETTERS.map((l) => g + l));

const app = express();
app.use(express.json());
// статыка для лакальнага запуску; на Vercel public/ раздае CDN
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// ---------- webhook Telegram (да auth-мідлвэра!) ----------
app.use(
  '/api/tg-webhook',
  async (req, res, next) => {
    try {
      await ensureBotInit();
      next();
    } catch (e) {
      console.error('bot init:', e.message);
      res.status(500).end();
    }
  },
  webhookCallback(bot, 'express', WEBHOOK_SECRET ? { secretToken: WEBHOOK_SECRET } : undefined)
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// ---------- фота (захоўваюцца ў базе) ----------
// Адрас з выпадковым UUID, таму спасылку не падабраць; заголовак тут перадаць
// немагчыма (<img src>), таму маршрут стаіць да праверкі initData.
app.get('/api/photo/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).end();
  one('SELECT mime, data FROM photos WHERE id = $1', [id])
    .then((row) => {
      if (!row) return res.status(404).end();
      res.setHeader('Content-Type', row.mime);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(row.data);
    })
    .catch((e) => {
      console.error('photo:', e);
      if (!res.headersSent) res.status(500).end();
    });
});

// ---------- дапаможныя ----------
const getUser = (id) => one('SELECT * FROM users WHERE tg_id = $1', [id]);

function publicProfile(u) {
  return { tg_id: u.tg_id, username: u.username, name: u.name, klass: u.klass, gender: u.gender, photo: u.photo };
}

function ownProfile(u) {
  return { ...publicProfile(u), looking: u.looking, hidden: u.hidden };
}

async function savePhoto(buffer, mimetype) {
  const id = crypto.randomUUID();
  await q('INSERT INTO photos (id, mime, data) VALUES ($1, $2, $3)', [id, mimetype || 'image/jpeg', buffer]);
  return '/api/photo/' + id;
}

function deletePhoto(url) {
  const id = String(url || '').split('/').pop();
  if (/^[0-9a-f-]{36}$/i.test(id)) q('DELETE FROM photos WHERE id = $1', [id]).catch(() => {});
}

async function downloadAvatar(tgId) {
  await ensureBotInit();
  const photos = await bot.api.getUserProfilePhotos(tgId, { limit: 1 });
  if (!photos.total_count) return null;
  const sizes = photos.photos[0];
  const fileId = sizes[sizes.length - 1].file_id; // самы буйны памер
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

// абгортка, каб не дубляваць try/catch у async-маршрутах
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(req.path, e);
    if (!res.headersSent) res.status(500).json({ error: 'Памылка сервера, паспрабуй яшчэ раз' });
  });

// ---------- аўтарызацыя ----------
app.use('/api', (req, res, next) => {
  (async () => {
    const tgUser = verifyInitData(req.get('x-init-data') || '', BOT_TOKEN);
    if (!tgUser) return res.status(401).json({ error: 'Не атрымалася пацвердзіць аўтарызацыю Telegram' });
    req.tg = tgUser;
    const me = await getUser(tgUser.id);
    if (me && me.banned) return res.status(403).json({ error: 'banned' });
    req.me = me || null;
    next();
  })().catch((e) => {
    console.error('auth:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Памылка сервера, паспрабуй яшчэ раз' });
  });
});

// ---------- профіль ----------
app.get('/api/me', (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  res.json(ownProfile(req.me));
});

// прэв'ю аватаркі Telegram на кроку рэгістрацыі
app.get('/api/avatar', wrap(async (req, res) => {
  const buf = await downloadAvatar(req.tg.id);
  if (!buf) return res.status(404).json({ error: 'У цябе няма аватаркі ў Telegram' });
  res.type('image/jpeg').send(buf);
}));

// рэгістрацыя і рэдагаванне — адзін апрацоўшчык
app.post('/api/me', upload.single('photo'), wrap(async (req, res) => {
  const fields = validateProfile(req.body);
  if (!fields) return res.status(400).json({ error: 'Правер запаўненне анкеты' });

  let photo = null;
  if (req.file) {
    photo = await savePhoto(req.file.buffer, req.file.mimetype);
  } else if (req.body.use_avatar === '1') {
    const buf = await downloadAvatar(req.tg.id).catch(() => null);
    if (!buf) return res.status(400).json({ error: 'Не атрымалася ўзяць аватарку з Telegram — загрузі фота файлам' });
    photo = await savePhoto(buf, 'image/jpeg');
  }

  const username = req.tg.username || null;

  if (!req.me) {
    if (!photo) return res.status(400).json({ error: 'Фота абавязковае' });
    await q(
      'INSERT INTO users (tg_id, username, name, klass, gender, looking, photo) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [req.tg.id, username, fields.name, fields.klass, fields.gender, fields.looking, photo]
    );
  } else {
    if (photo) deletePhoto(req.me.photo);
    await q(
      'UPDATE users SET username = $1, name = $2, klass = $3, gender = $4, looking = $5, photo = $6 WHERE tg_id = $7',
      [username, fields.name, fields.klass, fields.gender, fields.looking, photo || req.me.photo, req.tg.id]
    );
  }

  res.json(ownProfile(await getUser(req.tg.id)));
}));

app.patch('/api/me/looking', wrap(async (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  const looking = req.body.looking ? 1 : 0;
  await q('UPDATE users SET looking = $1 WHERE tg_id = $2', [looking, req.tg.id]);
  res.json({ looking });
}));

app.delete('/api/me', wrap(async (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  deletePhoto(req.me.photo);
  await q('DELETE FROM users WHERE tg_id = $1', [req.tg.id]);
  await q('DELETE FROM likes WHERE from_id = $1 OR to_id = $1', [req.tg.id]);
  await q('DELETE FROM reports WHERE from_id = $1 OR to_id = $1', [req.tg.id]);
  res.json({ ok: true });
}));

// ---------- стужка ----------
app.get('/api/feed', wrap(async (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  const wanted = req.me.gender === 'm' ? 'f' : 'm';
  const rows = await q(
    `SELECT * FROM users
     WHERE gender = $1 AND looking = 1 AND banned = 0 AND hidden = 0 AND tg_id != $2
       AND tg_id NOT IN (SELECT to_id FROM likes WHERE from_id = $2)
     ORDER BY random() LIMIT 10`,
    [wanted, req.tg.id]
  );
  res.json(rows.map(publicProfile));
}));

app.post('/api/swipe', wrap(async (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  const toId = Number(req.body.to_id);
  const liked = req.body.liked ? 1 : 0;
  const target = await getUser(toId);
  if (!target || toId === req.tg.id || target.gender === req.me.gender) {
    return res.status(400).json({ error: 'Няправільная анкета' });
  }

  // пропуск можна «павысіць» да лайка (напрыклад, з прагляду па класах), назад — не
  const existing = await one('SELECT liked FROM likes WHERE from_id = $1 AND to_id = $2', [req.tg.id, toId]);
  let newlyLiked = false;
  if (!existing) {
    await q('INSERT INTO likes (from_id, to_id, liked) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [req.tg.id, toId, liked]);
    newlyLiked = !!liked;
  } else if (liked && !existing.liked) {
    await q('UPDATE likes SET liked = 1 WHERE from_id = $1 AND to_id = $2', [req.tg.id, toId]);
    newlyLiked = true;
  }

  let match = null;
  if (newlyLiked) {
    const mutual = await one('SELECT 1 AS x FROM likes WHERE from_id = $1 AND to_id = $2 AND liked = 1', [toId, req.tg.id]);
    if (mutual) {
      match = publicProfile(target);
      await notifyMatch(req.me, target).catch(() => {});
    }
  }
  res.json({ ok: true, match });
}));

// профілі выбранага класа (супрацьлеглы пол, каго яшчэ не лайкаў)
app.get('/api/class/:klass', wrap(async (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  const klass = req.params.klass;
  if (!CLASSES.includes(klass)) return res.status(400).json({ error: 'Няма такога класа' });
  const wanted = req.me.gender === 'm' ? 'f' : 'm';
  const rows = await q(
    `SELECT * FROM users
     WHERE klass = $1 AND gender = $2 AND looking = 1 AND banned = 0 AND hidden = 0 AND tg_id != $3
       AND tg_id NOT IN (SELECT to_id FROM likes WHERE from_id = $3 AND liked = 1)
     ORDER BY name`,
    [klass, wanted, req.tg.id]
  );
  res.json(rows.map(publicProfile));
}));

app.get('/api/matches', wrap(async (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  const rows = await q(
    `SELECT u.* FROM users u
     JOIN likes l1 ON l1.to_id = u.tg_id AND l1.from_id = $1 AND l1.liked = 1
     JOIN likes l2 ON l2.from_id = u.tg_id AND l2.to_id = $1 AND l2.liked = 1
     WHERE u.banned = 0
     ORDER BY l2.created_at DESC`,
    [req.tg.id]
  );
  res.json(rows.map(publicProfile));
}));

// ---------- скаргі ----------
app.post('/api/report', wrap(async (req, res) => {
  if (!req.me) return res.status(404).json({ error: 'not_registered' });
  const toId = Number(req.body.to_id);
  const target = await getUser(toId);
  if (!target || toId === req.tg.id) return res.status(400).json({ error: 'Няправільная анкета' });

  await q('INSERT INTO reports (from_id, to_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.tg.id, toId]);
  const { c } = await one('SELECT COUNT(*) AS c FROM reports WHERE to_id = $1', [toId]);
  if (c >= 3) await q('UPDATE users SET hidden = 1 WHERE tg_id = $1', [toId]);
  notifyAdminReport(target, c).catch(() => {});
  res.json({ ok: true });
}));

module.exports = app;
