const tg = window.Telegram?.WebApp;
const initData = tg?.initData || '';
tg?.ready();
tg?.expand();

const CLASS_LETTERS = ['Фил', 'Ист', 'Общ', 'Био1', 'Био2', 'Хим', 'ЭГ', 'ИМ', 'ИФ', 'М1', 'М2', 'Ф'];
const GRADES = { 10: CLASS_LETTERS.map((l) => '10' + l), 11: CLASS_LETTERS.map((l) => '11' + l) };

const $ = (id) => document.getElementById(id);
let me = null;
let feed = [];
let current = null;
let swiping = false;

// ---------- утилиты ----------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: { 'x-init-data': initData, 'ngrok-skip-browser-warning': '1', ...(opts.headers || {}) },
  });
  if (res.status === 403) {
    showError('Твой акаўнт заблакаваны адміністратарам.');
    throw new Error('banned');
  }
  return res;
}

function showScreen(id) {
  ['screen-loading', 'screen-error', 'screen-reg', 'screen-main'].forEach((s) => ($(s).hidden = s !== id));
}

function showError(text) {
  $('error-text').textContent = text;
  showScreen('screen-error');
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2500);
}

function ask(message, cb) {
  if (tg?.showConfirm) tg.showConfirm(message, (ok) => ok && cb());
  else if (confirm(message)) cb();
}

function openChat(u) {
  if (u.username) {
    const link = 'https://t.me/' + u.username;
    tg?.openTelegramLink ? tg.openTelegramLink(link) : (location.href = link);
  } else {
    location.href = 'tg://user?id=' + u.tg_id;
  }
}

// ---------- регистрация ----------
const reg = { name: '', klass: null, gender: null, looking: 1, photoFile: null, useAvatar: false, editing: false };
let step = 0;
const STEPS = 6;

function goStep(n) {
  step = n;
  document.querySelectorAll('.step').forEach((el) => (el.hidden = Number(el.dataset.step) !== n));
  $('reg-bar').style.width = ((n + 1) / STEPS) * 100 + '%';
  // родная кнопка «назад» у шапцы Telegram замест кнопкі на старонцы
  if (tg?.BackButton) (n > 0 ? tg.BackButton.show() : tg.BackButton.hide());
  if (n === 1) showRegGrades();
  if (n === 4) $('btn-photo-next').disabled = !(reg.photoFile || reg.useAvatar || reg.editing);
  if (n === 5) renderRegPreview();
}

function startRegistration(editing) {
  reg.editing = editing;
  if (editing && me) {
    reg.name = me.name;
    reg.klass = me.klass;
    reg.gender = me.gender;
    reg.looking = me.looking;
    reg.photoFile = null;
    reg.useAvatar = false;
    setPhotoPreview(me.photo);
  } else {
    reg.name = tg?.initDataUnsafe?.user?.first_name || '';
    $('photo-preview').hidden = true;
  }
  $('reg-name').value = reg.name;
  syncChoiceButtons();
  showScreen('screen-reg');
  goStep(0);
}

function syncChoiceButtons() {
  document.querySelectorAll('.class-grid .btn').forEach((b) => b.classList.toggle('selected', b.textContent === reg.klass));
  document.querySelectorAll('[data-gender]').forEach((b) => b.classList.toggle('selected', b.dataset.gender === reg.gender));
  document.querySelectorAll('[data-looking]').forEach((b) => b.classList.toggle('selected', Number(b.dataset.looking) === reg.looking));
}

function setPhotoPreview(src) {
  const img = $('photo-preview');
  img.src = src;
  img.hidden = false;
  $('btn-photo-next').disabled = false;
}

function renderRegPreview() {
  $('preview-photo').src = $('photo-preview').src || (me ? me.photo : '');
  $('preview-name').textContent = `${reg.name}, ${reg.klass}`;
}

// шаг 0: имя
$('btn-name-next').onclick = () => {
  const name = $('reg-name').value.trim();
  if (!name) return toast('Напішы імя 🙂');
  reg.name = name;
  goStep(1);
};

// шаг 1: класс — сначала кнопка параллели, потом классы
function showRegGrades() {
  $('reg-grades').hidden = false;
  $('reg-class-grid').hidden = true;
  $('reg-grade-back').hidden = true;
}

// кнопка класа: нумар паралелі — дробнай залатой лічбай
function classChip(c) {
  const b = document.createElement('button');
  b.className = 'btn class-chip';
  const m = c.match(/^(\d+)(.*)$/);
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = m[1];
  b.append(num, m[2]);
  return b;
}

function showRegClasses(grade) {
  const grid = $('reg-class-grid');
  grid.innerHTML = '';
  GRADES[grade].forEach((c) => {
    const b = classChip(c);
    b.onclick = () => {
      reg.klass = c;
      syncChoiceButtons();
      setTimeout(() => goStep(2), 120);
    };
    grid.appendChild(b);
  });
  syncChoiceButtons();
  $('reg-grades').hidden = true;
  grid.hidden = false;
  $('reg-grade-back').hidden = false;
}

document.querySelectorAll('[data-reg-grade]').forEach((b) => (b.onclick = () => showRegClasses(b.dataset.regGrade)));
$('reg-grade-back').onclick = showRegGrades;

// шаг 2: пол
document.querySelectorAll('[data-gender]').forEach((b) => {
  b.onclick = () => {
    reg.gender = b.dataset.gender;
    syncChoiceButtons();
    setTimeout(() => goStep(3), 120);
  };
});

// шаг 3: ищу пару
document.querySelectorAll('[data-looking]').forEach((b) => {
  b.onclick = () => {
    reg.looking = Number(b.dataset.looking);
    syncChoiceButtons();
    setTimeout(() => goStep(4), 120);
  };
});

// шаг 4: фото
// сціскаем фота ў браўзеры: анкеты грузяцца хутка, база не раздзімаецца
function compressPhoto(file, maxSide = 1000, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => resolve(blob && blob.size < file.size ? blob : file), 'image/jpeg', quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });
}

$('btn-upload').onclick = () => $('photo-input').click();
$('photo-input').onchange = async () => {
  const file = $('photo-input').files[0];
  if (!file) return;
  const photo = await compressPhoto(file);
  if (photo.size > 4 * 1024 * 1024) return toast('Фота занадта вялікае — выберы іншае');
  reg.photoFile = photo;
  reg.useAvatar = false;
  setPhotoPreview(URL.createObjectURL(photo));
};

$('btn-avatar').onclick = async () => {
  $('btn-avatar').disabled = true;
  try {
    const res = await api('/avatar');
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      return toast(e.error || 'Не атрымалася ўзяць аватарку');
    }
    reg.useAvatar = true;
    reg.photoFile = null;
    setPhotoPreview(URL.createObjectURL(await res.blob()));
  } finally {
    $('btn-avatar').disabled = false;
  }
};

$('btn-photo-next').onclick = () => goStep(5);

// шаг 5: превью и отправка
$('btn-restart').onclick = () => goStep(0);
$('btn-finish').onclick = async () => {
  $('btn-finish').disabled = true;
  try {
    const fd = new FormData();
    fd.append('name', reg.name);
    fd.append('klass', reg.klass);
    fd.append('gender', reg.gender);
    fd.append('looking', String(reg.looking));
    if (reg.photoFile) fd.append('photo', reg.photoFile, 'photo.jpg');
    if (reg.useAvatar) fd.append('use_avatar', '1');
    const res = await api('/me', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) return toast(data.error || 'Памылка, паспрабуй яшчэ раз');
    me = data;
    tg?.HapticFeedback?.notificationOccurred('success');
    enterMain();
  } catch {
    toast('Няма сувязі з серверам');
  } finally {
    $('btn-finish').disabled = false;
  }
};

tg?.BackButton?.onClick(() => {
  if (!$('screen-reg').hidden && step > 0) goStep(step - 1);
});

// ---------- основной экран ----------
function enterMain() {
  tg?.BackButton?.hide();
  showScreen('screen-main');
  switchTab('feed');
  renderProfile();
  loadFeed();
  loadMatches();
}

function switchTab(name) {
  ['feed', 'matches', 'profile'].forEach((t) => ($('tab-' + t).hidden = t !== name));
  document.querySelectorAll('.tabbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'matches') loadMatches();
  if (name === 'profile') renderProfile();
}
document.querySelectorAll('.tabbtn').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

// ---------- лента ----------
async function loadFeed() {
  try {
    const res = await api('/feed');
    feed = res.ok ? await res.json() : [];
  } catch {
    feed = [];
  }
  nextCard();
}

function nextCard() {
  current = feed.shift() || null;
  const has = !!current;
  $('feed-card').hidden = !has;
  $('feed-actions').hidden = !has;
  $('feed-empty').hidden = has;
  if (!has) {
    // тлумачым, чаму стужка пустая: схаваная ўласная анкета ці проста мала людзей
    $('feed-empty-text').innerHTML = me && !me.looking
      ? 'Твая анкета схавана 🙈<br>Уключы «Шукаю пару» ў профілі,<br>каб цябе таксама бачылі.'
      : 'Пакуль няма новых анкет.<br>Чым больш ліцэістаў, тым больш шанцаў<br>знайсці пару на вальс 💃';
  }
  if (has) {
    const card = $('feed-card');
    card.classList.remove('fly-left', 'fly-right', 'card-in');
    void card.offsetWidth; // перазапуск анімацыі з'яўлення
    card.classList.add('card-in');
    $('feed-photo').src = current.photo;
    $('feed-name').textContent = `${current.name}, ${current.klass}`;
  }
}

async function swipe(liked) {
  if (!current || swiping) return;
  swiping = true;
  const target = current;
  $('feed-card').classList.add(liked ? 'fly-right' : 'fly-left');
  tg?.HapticFeedback?.impactOccurred('light');
  try {
    const res = await api('/swipe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_id: target.tg_id, liked }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.match) showMatch(data.match);
  } catch {
    toast('Няма сувязі з серверам');
  }
  setTimeout(() => {
    swiping = false;
    if (feed.length) nextCard();
    else loadFeed();
  }, 300);
}

$('btn-like').onclick = () => swipe(true);
$('btn-skip').onclick = () => swipe(false);
$('btn-feed-refresh').onclick = loadFeed;

$('btn-invite').onclick = () => {
  const link = 'https://t.me/aposhni_vals_bot';
  const text = 'Шукаеш пару на вальс апошняга званка? Далучайся 💃🕺';
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
  tg?.openTelegramLink ? tg.openTelegramLink(share) : window.open(share, '_blank');
};

$('btn-report').onclick = () => {
  if (!current) return;
  const target = current;
  ask(`Паскардзіцца на анкету «${target.name}»?`, async () => {
    try {
      await api('/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_id: target.tg_id }),
      });
      toast('Скарга адпраўлена, дзякуй!');
    } catch {
      toast('Няма сувязі з серверам');
    }
    swipe(false);
  });
};

// свайпы пальцем
let touchX = null;
$('feed-card').addEventListener('touchstart', (e) => (touchX = e.touches[0].clientX), { passive: true });
$('feed-card').addEventListener('touchend', (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (dx > 70) swipe(true);
  else if (dx < -70) swipe(false);
});

// ---------- панель «по классам» ----------
// три уровня: параллель (10/11) → класс → профили
let sheetSwiped = false; // были ли лайки из панели — тогда после закрытия обновляем ленту
let sheetGrade = null;
let sheetLevel = 'grades';

function sheetShow(level) {
  sheetLevel = level;
  $('sheet-grades').hidden = level !== 'grades';
  $('sheet-classes').hidden = level !== 'classes';
  $('sheet-profiles').hidden = level !== 'profiles';
  $('sheet-empty').hidden = true;
  $('sheet-back').hidden = level === 'grades';
}

function openSheet() {
  $('class-sheet').hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => $('class-sheet').classList.add('open')));
  showSheetGrades();
}

function closeSheet() {
  $('class-sheet').classList.remove('open');
  setTimeout(() => ($('class-sheet').hidden = true), 300);
  if (sheetSwiped) {
    sheetSwiped = false;
    loadFeed();
  }
}

function showSheetGrades() {
  $('sheet-title').textContent = 'Класы';
  sheetShow('grades');
}

function showSheetClasses(grade) {
  sheetGrade = grade;
  $('sheet-title').textContent = grade + '-я класы';
  const grid = $('sheet-class-grid');
  grid.innerHTML = '';
  GRADES[grade].forEach((c) => {
    const b = classChip(c);
    b.onclick = () => openClassProfiles(c);
    grid.appendChild(b);
  });
  sheetShow('classes');
}

document.querySelectorAll('[data-grade]').forEach((b) => (b.onclick = () => showSheetClasses(b.dataset.grade)));

async function openClassProfiles(klass) {
  $('sheet-title').textContent = klass;
  const box = $('sheet-profiles');
  box.innerHTML = '';
  sheetShow('profiles');
  let list = [];
  try {
    const res = await api('/class/' + encodeURIComponent(klass));
    list = res.ok ? await res.json() : [];
  } catch {
    toast('Няма сувязі з серверам');
  }
  $('sheet-empty').hidden = list.length > 0;
  list.forEach((u, i) => {
    const card = document.createElement('div');
    card.className = 'pcard';
    card.style.animationDelay = i * 40 + 'ms';
    const img = document.createElement('img');
    img.src = u.photo;
    const name = document.createElement('div');
    name.className = 'pname';
    name.textContent = u.name; // без номера класса — он выбран выше
    const like = document.createElement('button');
    like.className = 'plike';
    like.textContent = '❤️';
    like.onclick = async () => {
      like.disabled = true;
      try {
        const res = await api('/swipe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to_id: u.tg_id, liked: true }),
        });
        const data = await res.json().catch(() => ({}));
        sheetSwiped = true;
        tg?.HapticFeedback?.impactOccurred('light');
        card.remove();
        if (!box.children.length) $('sheet-empty').hidden = false;
        if (data.match) showMatch(data.match);
      } catch {
        like.disabled = false;
        toast('Няма сувязі з серверам');
      }
    };
    card.append(img, name, like);
    box.appendChild(card);
  });
}

$('btn-classes').onclick = openSheet;
$('sheet-close').onclick = closeSheet;
$('sheet-back').onclick = () => (sheetLevel === 'profiles' ? showSheetClasses(sheetGrade) : showSheetGrades());
$('class-sheet').addEventListener('click', (e) => {
  if (e.target === $('class-sheet')) closeSheet();
});

// ---------- мэтч ----------
let matchUser = null;
function showMatch(u) {
  matchUser = u;
  $('match-photo').src = u.photo;
  $('match-name').textContent = `${u.name}, ${u.klass}`;
  $('match-overlay').hidden = false;
  tg?.HapticFeedback?.notificationOccurred('success');
}
$('btn-match-write').onclick = () => matchUser && openChat(matchUser);
$('btn-match-close').onclick = () => ($('match-overlay').hidden = true);

// ---------- мэтчи ----------
async function loadMatches() {
  let list = [];
  try {
    const res = await api('/matches');
    list = res.ok ? await res.json() : [];
  } catch {}
  const box = $('matches-list');
  box.innerHTML = '';
  $('matches-empty').hidden = list.length > 0;
  list.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'match-row';
    const img = document.createElement('img');
    img.src = u.photo;
    const info = document.createElement('div');
    info.className = 'info';
    const b = document.createElement('b');
    b.textContent = u.name;
    const span = document.createElement('span');
    span.textContent = u.klass;
    info.append(b, span);
    const btn = document.createElement('button');
    btn.className = 'write';
    btn.textContent = '💬';
    btn.onclick = () => openChat(u);
    row.append(img, info, btn);
    box.appendChild(row);
  });
}

// ---------- профиль ----------
function renderProfile() {
  if (!me) return;
  $('my-photo').src = me.photo;
  $('my-name').textContent = `${me.name}, ${me.klass}`;
  $('looking-toggle').checked = !!me.looking;
}

$('looking-toggle').onchange = async (e) => {
  const looking = e.target.checked;
  try {
    await api('/me/looking', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ looking }),
    });
    me.looking = looking ? 1 : 0;
    toast(looking ? 'Твая анкета зноў у стужцы 💘' : 'Анкета схавана са стужкі 🙈');
  } catch {
    e.target.checked = !looking;
    toast('Няма сувязі з серверам');
  }
};

$('btn-edit').onclick = () => startRegistration(true);

$('btn-delete').onclick = () =>
  ask('Дакладна выдаліць анкету? Мэтчы і лайкі таксама выдаляцца.', async () => {
    try {
      await api('/me', { method: 'DELETE' });
      me = null;
      toast('Анкета выдалена');
      startRegistration(false);
    } catch {
      toast('Няма сувязі з серверам');
    }
  });

// ---------- запуск ----------
(async function boot() {
  if (!initData) {
    return showError('Адкрый праграму праз Telegram-бота 🙂');
  }
  try {
    const res = await api('/me');
    if (res.ok) {
      me = await res.json();
      enterMain();
    } else if (res.status === 404) {
      startRegistration(false);
    } else {
      showError('Памылка аўтарызацыі. Закрый і адкрый праграму нанова.');
    }
  } catch (e) {
    if (e.message !== 'banned') showError('Сервер недаступны. Паспрабуй пазней.');
  }
})();
