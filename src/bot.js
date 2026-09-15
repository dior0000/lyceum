require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const { q, one } = require('./db');

const ADMIN_ID = Number(process.env.ADMIN_ID || 0);
const WEBAPP_URL = process.env.WEBAPP_URL || '';

const bot = new Bot(process.env.BOT_TOKEN || 'no-token');

// на webhook патрэбна папярэдняя ініцыялізацыя бота (аднойчы на халодны старт)
let initPromise = null;
function ensureBotInit() {
  if (!initPromise) initPromise = bot.init();
  return initPromise;
}

function openKeyboard() {
  const kb = new InlineKeyboard();
  if (WEBAPP_URL) kb.webApp('💘 Адкрыць анкеты', WEBAPP_URL + '?r=' + Date.now());
  return kb;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function profileLink(u) {
  return u.username ? `https://t.me/${u.username}` : `tg://user?id=${u.tg_id}`;
}

bot.command('start', (ctx) =>
  ctx.reply(
    '🎓 <b>Прывітанне, ліцэіст!</b>\n\n' +
      'Наперадзе апошні званок і <b>вальс</b> 💃🕺\n' +
      'Запоўні анкету — і знайдзі сваю пару для танца 👇',
    { parse_mode: 'HTML', reply_markup: openKeyboard() }
  )
);

// ---------- каманды адміністратара ----------
function isAdmin(ctx) {
  return ADMIN_ID && ctx.from && ctx.from.id === ADMIN_ID;
}

bot.command('admin', (ctx) => {
  if (!isAdmin(ctx)) return;
  return ctx.reply(
    'Каманды адміністратара:\n' +
      '/stats — статыстыка\n' +
      '/reports — скаргі і схаваныя анкеты\n' +
      '/ban <tg_id> — заблакаваць\n' +
      '/unban <tg_id> — разблакаваць\n' +
      '/approve <tg_id> — вярнуць схаваную анкету ў стужку і скінуць скаргі'
  );
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const s = await one(`SELECT
    (SELECT COUNT(*) FROM users) AS total,
    (SELECT COUNT(*) FROM users WHERE gender = 'm') AS boys,
    (SELECT COUNT(*) FROM users WHERE gender = 'f') AS girls,
    (SELECT COUNT(*) FROM users WHERE looking = 1) AS looking,
    (SELECT COUNT(*) FROM users WHERE banned = 1) AS banned,
    (SELECT COUNT(*) FROM users WHERE hidden = 1) AS hidden,
    (SELECT COUNT(*) FROM likes WHERE liked = 1) AS likes,
    (SELECT COUNT(*) FROM likes a JOIN likes b ON a.from_id = b.to_id AND a.to_id = b.from_id
     WHERE a.liked = 1 AND b.liked = 1 AND a.from_id < a.to_id) AS matches`);
  return ctx.reply(
    `📊 Статыстыка\n\nАнкет: ${s.total} (👦 ${s.boys} / 👧 ${s.girls})\nШукаюць пару: ${s.looking}\n` +
      `Лайкаў: ${s.likes}\nМэтчаў: ${s.matches}\nСхавана па скаргах: ${s.hidden}\nЗаблакавана: ${s.banned}`
  );
});

bot.command('reports', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await q(
    `SELECT u.tg_id, u.username, u.name, u.klass, u.hidden, COUNT(r.from_id) AS cnt
     FROM users u JOIN reports r ON r.to_id = u.tg_id
     GROUP BY u.tg_id, u.username, u.name, u.klass, u.hidden
     ORDER BY cnt DESC LIMIT 30`
  );
  if (!rows.length) return ctx.reply('Скаргаў няма 🎉');
  const text = rows
    .map(
      (r) =>
        `${r.hidden ? '🚫' : '⚠️'} ${r.name}, ${r.klass} — скаргаў: ${r.cnt}\n` +
        `id: ${r.tg_id}${r.username ? ' (@' + r.username + ')' : ''}`
    )
    .join('\n\n');
  return ctx.reply(text + '\n\n/ban <id>, /approve <id>');
});

function targetId(ctx) {
  const id = parseInt(String(ctx.match || '').trim(), 10);
  return Number.isFinite(id) ? id : null;
}

bot.command('ban', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = targetId(ctx);
  if (!id) return ctx.reply('Выкарыстанне: /ban <tg_id>');
  await q('UPDATE users SET banned = 1 WHERE tg_id = $1', [id]);
  return ctx.reply(`Карыстальнік ${id} заблакаваны 🚫`);
});

bot.command('unban', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = targetId(ctx);
  if (!id) return ctx.reply('Выкарыстанне: /unban <tg_id>');
  await q('UPDATE users SET banned = 0 WHERE tg_id = $1', [id]);
  return ctx.reply(`Карыстальнік ${id} разблакаваны ✅`);
});

bot.command('approve', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = targetId(ctx);
  if (!id) return ctx.reply('Выкарыстанне: /approve <tg_id>');
  await q('UPDATE users SET hidden = 0 WHERE tg_id = $1', [id]);
  await q('DELETE FROM reports WHERE to_id = $1', [id]);
  return ctx.reply(`Анкета ${id} вернутая ў стужку, скаргі скінутыя ✅`);
});

bot.catch((err) => console.error('Памылка бота:', err.message));

// ---------- апавяшчэнні ----------
async function sendMatchTo(user, other) {
  const caption =
    `💘 <b>У вас мэтч!</b>\n\n` +
    `<a href="${profileLink(other)}">${esc(other.name)}, ${esc(other.klass)}</a> таксама лайкнуў(-ла) цябе.\n` +
    `Напішыце адно аднаму! 💬`;
  await bot.api.sendPhoto(user.tg_id, other.photo, {
    caption,
    parse_mode: 'HTML',
    reply_markup: other.username
      ? new InlineKeyboard().url('💬 Напісаць', `https://t.me/${other.username}`)
      : undefined,
  });
}

async function notifyMatch(a, b) {
  await ensureBotInit();
  const results = await Promise.allSettled([sendMatchTo(a, b), sendMatchTo(b, a)]);
  for (const r of results) if (r.status === 'rejected') console.error('Не дастаўлены мэтч:', r.reason?.message);
}

async function notifyAdminReport(target, count) {
  if (!ADMIN_ID) return;
  try {
    await ensureBotInit();
    await bot.api.sendMessage(
      ADMIN_ID,
      `⚠️ Скарга на анкету: ${target.name}, ${target.klass} (id ${target.tg_id}` +
        `${target.username ? ', @' + target.username : ''}). Усяго скаргаў: ${count}.` +
        (count >= 3 ? '\n🚫 Анкета схавана са стужкі. /approve або /ban' : '')
    );
  } catch (e) {
    console.error('Не дастаўлена адміну:', e.message);
  }
}

module.exports = { bot, ensureBotInit, notifyMatch, notifyAdminReport };
