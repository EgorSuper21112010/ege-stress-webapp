/* ==========================================================================
   Ударения — тренажёр (Telegram Mini App). Чистый JS, без зависимостей.
   Слова и запоминалки лежат в data.js (STRESS_DATA).
   ========================================================================== */
(() => {
  'use strict';

  /* ---------- Telegram ---------- */
  const tg = (window.Telegram && window.Telegram.WebApp) || null;
  const inTelegram = !!(tg && tg.platform && tg.platform !== 'unknown');
  const atLeast = (v) => {
    try { return !!(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(v)); } catch (e) { return false; }
  };
  const canHaptic = atLeast('6.1');
  const haptic = (fn) => { if (canHaptic) { try { fn(tg.HapticFeedback); } catch (e) { /* не критично */ } } };
  const hap = {
    sel: () => haptic((h) => h.selectionChanged()),
    ok: () => haptic((h) => h.notificationOccurred('success')),
    bad: () => haptic((h) => h.notificationOccurred('error')),
  };

  /* ---------- Тема ---------- */
  const root = document.documentElement;

  function currentScheme() {
    const m = location.search.match(/[?&]theme=(dark|light)/);
    if (m) return m[1];
    if (inTelegram && tg.colorScheme) return tg.colorScheme;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // Красим «хром» Telegram (шапка, фон, нижняя панель) в цвет приложения
  function paintChrome() {
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && bg) meta.setAttribute('content', bg);
    if (!inTelegram || !bg) return;
    try { if (atLeast('6.9')) tg.setHeaderColor(bg); } catch (e) { /* старый клиент */ }
    try { if (atLeast('6.1')) tg.setBackgroundColor(bg); } catch (e) { /* старый клиент */ }
    try { if (atLeast('7.10')) tg.setBottomBarColor(bg); } catch (e) { /* старый клиент */ }
  }

  function applyTheme() {
    root.setAttribute('data-theme', currentScheme());
    paintChrome();
  }

  /* ---------- Данные ---------- */
  const LEVELS = STRESS_DATA.levels;
  const MNEMONICS = STRESS_DATA.mnemonics;
  const N = LEVELS.length;
  const TOTAL = LEVELS.reduce((s, l) => s + l.length, 0);
  const NEED = 3; // верных ответов подряд, чтобы слово считалось выученным
  const RANKS = ['Новичок', 'Ученик', 'Знаток', 'Практик', 'Эрудит', 'Профи', 'Эксперт', 'Мастер', 'Гуру', 'Легенда'];
  // Слова-омографы: одно написание, разное ударение — подписываем значение
  const WORD_CONTEXT = { 'Отзыв': 'о книге', 'отзЫв': 'посла из страны' };
  const TABS = ['game', 'levels', 'progress'];

  /* ---------- Утилиты ---------- */
  const $ = (id) => document.getElementById(id);
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name) => `<svg class="ico"><use href="#i-${name}"/></svg>`;
  const rankOf = (i) => RANKS[clamp(i, 0, RANKS.length - 1)];

  function plural(n, [one, few, many]) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  // Ударная буква в данных помечена заглавной
  function stressIndex(word) {
    for (let i = 0; i < word.length; i++) if (word[i] !== word[i].toLowerCase()) return i;
    return 0;
  }

  function wordHtml(word) {
    const i = stressIndex(word);
    const low = word.toLowerCase();
    return esc(low.slice(0, i)) + '<span class="st">' + esc(low[i]) + '</span>' + esc(low.slice(i + 1));
  }

  function shuffle(a) {
    const r = a.slice();
    for (let i = r.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [r[i], r[j]] = [r[j], r[i]];
    }
    return r;
  }

  function countUp(node, to, ms = 800) {
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      node.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------- Хранилище: Telegram CloudStorage + запасной localStorage ---------- */
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* приватный режим */ } },
  };
  const useCloud = !!(tg && tg.CloudStorage && atLeast('6.9'));

  function storeGet(key) {
    const local = LS.get(key);
    if (!useCloud) return Promise.resolve(local);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => finish(local), 4000);
      try {
        tg.CloudStorage.getItem(key, (err, val) => { clearTimeout(timer); finish(!err && val ? val : local); });
      } catch (e) { clearTimeout(timer); finish(local); }
    });
  }

  function storeSet(key, val) {
    LS.set(key, val);
    if (!useCloud) return;
    try { tg.CloudStorage.setItem(key, val, () => {}); } catch (e) { /* повторим при следующей записи */ }
  }

  /* ---------- Состояние ---------- */
  const state = {
    highest: 0,          // самый дальний открытый уровень (0-индекс)
    best: 0,             // лучшая серия верных ответов
    mastered: [],        // Set выученных слов для каждого уровня
    viewing: 0,          // уровень, который сейчас проходим
    review: false,       // режим повторения пройденного уровня
    reviewDone: 0,
    reviewTotal: 0,
    deck: [],            // [{ word, streak }]
    current: null,
    answered: false,
    waitNext: false,
    streak: 0,           // серия верных ответов в этой сессии
    sessOk: 0,
    sessAll: 0,
    tab: 'game',
    gameView: 'game',    // 'game' | 'result' — что показывать на вкладке «Тренировка»
    timer: null,
  };

  const need = () => (state.review ? 1 : NEED);
  const learnedTotal = () => state.mastered.reduce((s, set) => s + set.size, 0);
  const completedCount = () => LEVELS.reduce((s, l, i) => s + (state.mastered[i].size >= l.length ? 1 : 0), 0);

  function parseSet(raw, levelIdx) {
    const valid = new Set(LEVELS[levelIdx]);
    try { return new Set(JSON.parse(raw || '[]').filter((w) => valid.has(w))); } catch (e) { return new Set(); }
  }

  async function loadState() {
    const [hi, best, ...sets] = await Promise.all([
      storeGet('highest_unlocked'),
      storeGet('best_streak'),
      ...LEVELS.map((_, i) => storeGet('mastered_' + i)),
    ]);
    state.highest = clamp(parseInt(hi, 10) || 0, 0, N - 1);
    state.best = Math.max(0, parseInt(best, 10) || 0);
    state.mastered = sets.map((raw, i) => parseSet(raw, i));
  }

  const saveMastered = (i) => storeSet('mastered_' + i, JSON.stringify([...state.mastered[i]]));

  /* ---------- DOM ---------- */
  const el = {
    streakVal: $('streakVal'), learnedVal: $('learnedVal'), chipStreak: $('chipStreak'), chipLearned: $('chipLearned'),
    lsBadge: $('lsBadge'), lsTitle: $('lsTitle'), lsSub: $('lsSub'), lsCount: $('lsCount'), lsFill: $('lsFill'),
    pips: $('pips'), wordBox: $('wordBox'), wordCtx: $('wordCtx'), feedback: $('feedback'), nextBtn: $('nextBtn'),
    levelsGrid: $('levelsGrid'),
    ringFg: $('ringFg'), ringNum: $('ringNum'), ringOf: $('ringOf'), rankName: $('rankName'),
    stLevels: $('stLevels'), stBest: $('stBest'), stLeft: $('stLeft'), stAcc: $('stAcc'),
    resBadge: $('resBadge'), resTitle: $('resTitle'), resSub: $('resSub'), resRank: $('resRank'),
    resPrimary: $('resPrimary'), resSecondary: $('resSecondary'),
    tabbar: $('tabbar'),
    tabs: [...document.querySelectorAll('.tab')],
    screens: [...document.querySelectorAll('.screen')],
  };

  /* ---------- Отрисовка: шапка, полоса уровня, точки серии ---------- */
  function renderChips(bump) {
    el.streakVal.textContent = state.streak;
    el.learnedVal.textContent = learnedTotal();
    el.chipStreak.classList.toggle('is-hot', state.streak > 0);
    if (bump) {
      const chip = bump === 'streak' ? el.chipStreak : el.chipLearned;
      chip.classList.remove('bump');
      void chip.offsetWidth;
      chip.classList.add('bump');
    }
  }

  function renderLevelStrip() {
    const i = state.viewing;
    const done = state.review ? state.reviewDone : state.mastered[i].size;
    const total = state.review ? state.reviewTotal : LEVELS[i].length;
    el.lsBadge.innerHTML = state.review ? icon('repeat') : String(i + 1);
    el.lsTitle.textContent = rankOf(i);
    el.lsSub.textContent = 'Уровень ' + (i + 1) + ' из ' + N + (state.review ? ' · повторение' : '');
    el.lsCount.textContent = done + ' / ' + total;
    el.lsFill.style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
  }

  function renderPips(streak) {
    const n = need();
    if (el.pips.children.length !== n) el.pips.innerHTML = '<i></i>'.repeat(n);
    [...el.pips.children].forEach((p, k) => p.classList.toggle('on', k < streak));
  }

  /* ---------- Отрисовка: слово плитками ---------- */
  let perRow = 8;

  function sizeTiles() {
    const W = el.wordBox.clientWidth;
    if (!W) return; // экран скрыт — подгоним, когда покажем
    const gap = 6;
    const tw = clamp(Math.floor((W - gap * (perRow - 1)) / perRow), 26, 52);
    el.wordBox.style.setProperty('--tw', tw + 'px');
    el.wordBox.style.setProperty('--gap', gap + 'px');
  }

  function renderWord(word) {
    const n = word.length;
    const split = n > 9 ? Math.ceil(n / 2) : n; // длинные слова — в две ровные строки
    const rows = n > 9 ? [word.slice(0, split), word.slice(split)] : [word];
    perRow = split;

    el.wordBox.classList.remove('is-locked');
    el.wordBox.innerHTML = '';
    let k = 0;
    rows.forEach((chunk) => {
      const row = document.createElement('div');
      row.className = 'word-row';
      for (const ch of chunk) {
        const i = k++;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tile';
        b.style.setProperty('--i', i);
        b.textContent = ch.toUpperCase(); // регистр не выдаёт ответ
        b.setAttribute('aria-label', 'Буква ' + ch.toUpperCase() + ', номер ' + (i + 1));
        b.addEventListener('click', () => onAnswer(i));
        row.appendChild(b);
      }
      el.wordBox.appendChild(row);
    });
    sizeTiles();

    const ctx = WORD_CONTEXT[word];
    el.wordCtx.classList.toggle('hidden', !ctx);
    if (ctx) el.wordCtx.textContent = 'Значение: ' + ctx;
  }

  function paintTiles(picked, right, ok) {
    const tiles = [...el.wordBox.querySelectorAll('.tile')];
    el.wordBox.classList.add('is-locked');
    tiles[picked].classList.add(ok ? 'is-correct' : 'is-wrong');
    if (!ok) tiles[right].classList.add('is-correct');
    // над верной буквой — значок ударения (у «ё» ударение и так очевидно)
    if (tiles[right].textContent !== 'Ё') {
      const acc = document.createElement('i');
      acc.className = 'acc';
      tiles[right].appendChild(acc);
    }
  }

  /* ---------- Отрисовка: обратная связь ---------- */
  function setFeedback(kind, { title, html, mnemonic } = {}) {
    const ico = { idle: 'target', ok: 'check', bad: 'x' }[kind];
    el.feedback.className = 'feedback is-' + kind;
    el.feedback.innerHTML =
      `<div class="fb-ico">${icon(ico)}</div>` +
      '<div class="fb-body">' +
        `<div class="fb-title">${esc(title)}</div>` +
        (html ? `<div class="fb-text">${html}</div>` : '') +
        (mnemonic
          ? `<div class="mnemonic">${icon('bulb')}<div><b>Запоминалка</b>${esc(mnemonic)}</div></div>`
          : '') +
      '</div>';
    void el.feedback.offsetWidth;
    el.feedback.classList.add('pulse');
  }

  /* ---------- Игровой цикл ---------- */
  function reinsert(item, min, max) {
    const at = Math.min(state.deck.length, min + Math.floor(Math.random() * (max - min + 1)));
    state.deck.splice(at, 0, item);
  }

  function startLevel(idx, opts = {}) {
    clearTimeout(state.timer);
    state.viewing = idx;
    state.review = !!opts.review;
    state.gameView = 'game';

    const all = LEVELS[idx];
    const words = state.review ? all.slice() : all.filter((w) => !state.mastered[idx].has(w));
    state.reviewDone = 0;
    state.reviewTotal = words.length;

    goTab('game');
    if (!words.length) {
      // Уровень уже пройден: при ручном открытии — спокойный экран, без салюта
      return opts.calm ? showLevelDone(idx) : completeLevel(idx);
    }
    state.deck = shuffle(words).map((w) => ({ word: w, streak: 0 }));
    nextWord();
  }

  function nextWord() {
    clearTimeout(state.timer);
    state.answered = false;
    state.waitNext = false;
    el.nextBtn.classList.add('hidden');
    if (!state.deck.length) {
      if (state.review) finishReview(); else completeLevel(state.viewing);
      return;
    }
    state.current = state.deck[0];
    renderWord(state.current.word);
    renderPips(state.current.streak);
    setFeedback('idle', { title: 'Твой ход', html: 'Нажми на ударную гласную в слове.' });
    renderLevelStrip();
  }

  function onAnswer(idx) {
    if (state.answered || !state.current) return;
    state.answered = true;

    const item = state.current;
    const word = item.word;
    const right = stressIndex(word);
    const ok = idx === right;

    paintTiles(idx, right, ok);
    state.sessAll += 1;
    state.deck.shift();

    if (ok) {
      item.streak += 1;
      state.sessOk += 1;
      state.streak += 1;
      if (state.streak > state.best) {
        state.best = state.streak;
        storeSet('best_streak', String(state.best));
      }
      hap.ok();

      const done = item.streak >= need();
      let title;
      let text = `<span class="w">${wordHtml(word)}</span>`;
      if (done) {
        title = state.review ? 'Закреплено!' : 'Слово выучено!';
        if (state.review) {
          state.reviewDone += 1;
        } else {
          state.mastered[state.viewing].add(word);
          saveMastered(state.viewing);
        }
      } else {
        const left = need() - item.streak;
        title = 'Верно!';
        text += `<span class="sub">Ещё ${left} ${plural(left, ['раз', 'раза', 'раз'])} подряд — и слово выучено</span>`;
        reinsert(item, 3, 5);
      }
      renderPips(item.streak);
      renderChips(done && !state.review ? 'learned' : 'streak');
      renderLevelStrip();
      setFeedback('ok', { title, html: text });
      state.timer = setTimeout(nextWord, done ? 1400 : 1000);
    } else {
      item.streak = 0;
      state.streak = 0;
      hap.bad();
      reinsert(item, 1, 2); // ошибка — слово вернётся скоро
      renderPips(0);
      renderChips();
      setFeedback('bad', {
        title: 'Не совсем',
        html: `Правильно: <span class="w">${wordHtml(word)}</span>`,
        mnemonic: MNEMONICS[word.toLowerCase()],
      });
      // После ошибки темп задаёт человек: можно спокойно прочесть запоминалку
      state.waitNext = true;
      el.nextBtn.classList.remove('hidden');
      setTimeout(() => el.nextBtn.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
    }
  }

  /* ---------- Результаты ---------- */
  function showResult(c) {
    el.resBadge.className = 'result-badge is-' + c.tone;
    el.resBadge.innerHTML = icon(c.icon);
    el.resTitle.textContent = c.title;
    el.resSub.textContent = c.sub;
    el.resRank.classList.toggle('hidden', !c.rank);
    if (c.rank) el.resRank.textContent = c.rank;
    el.resPrimary.textContent = c.primary.label;
    el.resSecondary.textContent = c.secondary.label;
    el.resPrimary.onclick = c.primary.fn;
    el.resSecondary.onclick = c.secondary.fn;
    state.gameView = 'result';
    // Если человек успел уйти на другую вкладку — не выдёргиваем его обратно
    if (state.tab === 'game') {
      goTab('game');
      if (c.confetti) setTimeout(() => confetti(c.confetti), 250);
    }
  }

  const toLevels = () => goTab('levels');

  function completeLevel(idx) {
    const last = idx >= N - 1;
    if (!last && idx === state.highest) {
      state.highest = idx + 1;
      storeSet('highest_unlocked', String(state.highest));
    }
    hap.ok();
    const rank = 'Новое звание: ' + rankOf(completedCount());
    if (last) {
      showResult({
        tone: 'violet', icon: 'crown', confetti: 160,
        title: 'Все ' + N + ' уровней пройдены!',
        sub: 'Все ' + TOTAL + ' слов словника выучены. Можно повторять уровни — или начать сначала.',
        rank,
        primary: { label: 'К уровням', fn: toLevels },
        secondary: { label: 'Начать заново', fn: askReset },
      });
    } else {
      showResult({
        tone: 'gold', icon: 'trophy', confetti: 130,
        title: 'Уровень ' + (idx + 1) + ' пройден!',
        sub: 'Выучено ' + LEVELS[idx].length + ' ' + plural(LEVELS[idx].length, ['слово', 'слова', 'слов']) + '. Дальше — уровень ' + (idx + 2) + ' «' + rankOf(idx + 1) + '».',
        rank,
        primary: { label: 'Уровень ' + (idx + 2), fn: () => startLevel(idx + 1) },
        secondary: { label: 'К уровням', fn: toLevels },
      });
    }
  }

  // Спокойный экран для уже пройденного уровня (без конфетти)
  function showLevelDone(idx) {
    showResult({
      tone: 'green', icon: 'check',
      title: 'Уровень ' + (idx + 1) + ' пройден',
      sub: '«' + rankOf(idx) + '» — выучено ' + LEVELS[idx].length + ' ' + plural(LEVELS[idx].length, ['слово', 'слова', 'слов']) + '. Хочешь освежить в памяти?',
      primary: { label: 'Повторить слова', fn: () => startLevel(idx, { review: true }) },
      secondary: { label: 'К уровням', fn: toLevels },
    });
  }

  function finishReview() {
    const idx = state.viewing;
    hap.ok();
    showResult({
      tone: 'green', icon: 'check', confetti: 60,
      title: 'Повторение пройдено',
      sub: 'Закреплено ' + state.reviewTotal + ' ' + plural(state.reviewTotal, ['слово', 'слова', 'слов']) + ' уровня ' + (idx + 1) + '.',
      primary: { label: 'Ещё раз', fn: () => startLevel(idx, { review: true }) },
      secondary: { label: 'К уровням', fn: toLevels },
    });
  }

  /* ---------- Экран «Уровни» ---------- */
  function renderLevels() {
    el.levelsGrid.innerHTML = '';
    LEVELS.forEach((words, i) => {
      const total = words.length;
      const m = state.mastered[i].size;
      const locked = i > state.highest;
      const done = m >= total;
      const current = !locked && i === state.viewing && state.gameView === 'game';
      const p = total ? m / total : 0;

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'lcard' + (locked ? ' is-locked' : '') + (done ? ' is-done' : '') + (current ? ' is-current' : '');
      card.style.setProperty('--i', i);
      card.innerHTML =
        '<span class="lc-ring">' +
          '<svg viewBox="0 0 48 48" aria-hidden="true">' +
            '<circle class="bg" cx="24" cy="24" r="20"/>' +
            `<circle class="fg" cx="24" cy="24" r="20" stroke="url(#${done ? 'g-done' : 'g-ring'})" style="--p:${p};opacity:${p > 0 && !locked ? 1 : 0}"/>` +
          '</svg>' +
          `<span class="lc-num">${locked ? icon('lock') : done ? icon('check') : i + 1}</span>` +
        '</span>' +
        `<span class="lc-title">${rankOf(i)}</span>` +
        `<span class="lc-sub">${locked ? 'Закрыт' : m + ' / ' + total + ' слов'}</span>` +
        (done ? '<span class="lc-tag is-done">Пройден</span>' : current ? '<span class="lc-tag">Сейчас</span>' : '');

      card.addEventListener('click', () => {
        if (locked) {
          hap.bad();
          card.classList.remove('shake');
          void card.offsetWidth;
          card.classList.add('shake');
          return;
        }
        hap.sel();
        // Тап по текущему уровню — просто вернуться к тренировке
        if (i === state.viewing && !state.review && state.deck.length && state.gameView === 'game') goTab('game');
        else startLevel(i, { calm: true });
      });
      el.levelsGrid.appendChild(card);
    });
  }

  /* ---------- Экран «Прогресс» ---------- */
  function genWords(n) { // «из 207 слов», «из 21 слова»
    return n % 10 === 1 && n % 100 !== 11 ? 'слова' : 'слов';
  }

  function renderProgress() {
    const learned = learnedTotal();
    const pct = TOTAL ? learned / TOTAL : 0;
    const C = 326.73;

    el.ringFg.style.transition = 'none';
    el.ringFg.style.strokeDashoffset = C;
    void el.ringFg.getBoundingClientRect();
    el.ringFg.style.transition = '';
    requestAnimationFrame(() => { el.ringFg.style.strokeDashoffset = C * (1 - pct); });

    countUp(el.ringNum, learned);
    el.ringOf.textContent = 'из ' + TOTAL + ' ' + genWords(TOTAL);
    el.rankName.textContent = rankOf(completedCount());
    el.stLevels.textContent = completedCount() + ' / ' + N;
    el.stBest.textContent = state.best;
    el.stLeft.textContent = TOTAL - learned;
    el.stAcc.textContent = state.sessAll ? Math.round((state.sessOk / state.sessAll) * 100) + '%' : '—';
  }

  /* ---------- Навигация ---------- */
  function goTab(name) {
    state.tab = name;
    const id = 'screen-' + (name === 'game' ? state.gameView : name);
    el.screens.forEach((s) => s.classList.toggle('hidden', s.id !== id));
    el.tabs.forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
    el.tabbar.style.setProperty('--tab-i', TABS.indexOf(name));
    if (name === 'levels') renderLevels();
    else if (name === 'progress') renderProgress();
    else if (state.gameView === 'game') sizeTiles();
    window.scrollTo(0, 0);
  }

  /* ---------- Сброс ---------- */
  function resetAll() {
    clearTimeout(state.timer);
    LEVELS.forEach((_, i) => { state.mastered[i] = new Set(); storeSet('mastered_' + i, '[]'); });
    state.highest = 0;
    state.best = 0;
    state.streak = 0;
    state.sessOk = 0;
    state.sessAll = 0;
    storeSet('highest_unlocked', '0');
    storeSet('best_streak', '0');
    renderChips();
    startLevel(0);
  }

  function askReset() {
    const msg = 'Сбросить весь прогресс и начать заново?';
    if (inTelegram && atLeast('6.2') && tg.showConfirm) tg.showConfirm(msg, (ok) => { if (ok) resetAll(); });
    else if (window.confirm(msg)) resetAll();
  }

  /* ---------- Конфетти ---------- */
  const cv = $('confetti');
  const cx = cv.getContext('2d');
  let confettiRaf = 0;

  function confetti(count = 120) {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    cancelAnimationFrame(confettiRaf);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = (cv.width = Math.floor(innerWidth * dpr));
    const H = (cv.height = Math.floor(innerHeight * dpr));
    const colors = ['#6366F1', '#A855F7', '#22D3EE', '#34D399', '#FBBF24', '#FB7185', '#60A5FA'];
    const parts = Array.from({ length: count }, () => {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.4;
      const speed = (9 + Math.random() * 12) * dpr;
      return {
        x: W / 2, y: H * 0.42,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        r: (4 + Math.random() * 5) * dpr,
        rot: Math.random() * 6.283, vr: (Math.random() - 0.5) * 0.35,
        c: colors[(Math.random() * colors.length) | 0],
        round: Math.random() < 0.35,
      };
    });
    const g = 0.42 * dpr;
    const t0 = performance.now();
    const LIFE = 3200;

    const tick = (now) => {
      const t = now - t0;
      cx.clearRect(0, 0, W, H);
      let alive = false;
      for (const p of parts) {
        p.vx *= 0.992; p.vy += g; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        if (p.y < H + 30 * dpr) alive = true;
        cx.save();
        cx.globalAlpha = clamp((LIFE - t) / 700, 0, 1);
        cx.translate(p.x, p.y);
        cx.rotate(p.rot);
        cx.fillStyle = p.c;
        if (p.round) { cx.beginPath(); cx.arc(0, 0, p.r * 0.6, 0, 6.283); cx.fill(); }
        else cx.fillRect(-p.r, -p.r * 0.5, p.r * 2, p.r);
        cx.restore();
      }
      if (alive && t < LIFE) confettiRaf = requestAnimationFrame(tick);
      else cx.clearRect(0, 0, W, H);
    };
    confettiRaf = requestAnimationFrame(tick);
  }

  /* ---------- Запуск ---------- */
  function bind() {
    el.tabs.forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.tab !== state.tab) hap.sel();
      goTab(b.dataset.tab);
    }));
    $('levelStrip').addEventListener('click', () => { hap.sel(); goTab('levels'); });
    el.nextBtn.addEventListener('click', nextWord);
    $('resetBtn').addEventListener('click', askReset);
    window.addEventListener('resize', sizeTiles);
    document.addEventListener('keydown', (e) => {
      if (state.waitNext && state.tab === 'game' && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        nextWord();
      }
    });
    if (window.matchMedia) {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', applyTheme);
    }
  }

  async function init() {
    applyTheme();
    if (tg) {
      try { tg.ready(); } catch (e) { /* ignore */ }
      try { tg.expand(); } catch (e) { /* ignore */ }
      try { if (atLeast('7.7')) tg.disableVerticalSwipes(); } catch (e) { /* ignore */ }
      try { tg.onEvent('themeChanged', applyTheme); } catch (e) { /* ignore */ }
    }
    bind();
    const reveal = () => document.body.classList.add('ready');
    const failsafe = setTimeout(reveal, 3500);
    try {
      await loadState();
      renderChips();
      startLevel(state.highest, { calm: true });
    } finally {
      clearTimeout(failsafe);
      reveal();
    }
  }

  // Для отладки: добавь ?debug к адресу — состояние и функции будут в window.__ege
  if (/[?&]debug\b/.test(location.search)) {
    window.__ege = { state, LEVELS, startLevel, nextWord, onAnswer, completeLevel, goTab, confetti, renderLevels, renderProgress, resetAll, saveMastered, renderChips, renderLevelStrip, showLevelDone, finishReview };
  }

  init();
})();
