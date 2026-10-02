// Тренажёр ударений — игровая логика (без зависимостей, чистый JS).

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (tg) {
  tg.ready();
  tg.expand();
}

const LEVELS = STRESS_DATA.levels; // массив из 10 массивов слов
const MNEMONICS = STRESS_DATA.mnemonics;
const N_LEVELS = LEVELS.length;
const MASTERY_STREAK = 3;

// ---------------------------------------------------------------------------
// Хранилище: Telegram CloudStorage с фоллбэком на localStorage (для теста вне
// Telegram и для старых клиентов, где CloudStorage появился только в Bot API 6.9)
// ---------------------------------------------------------------------------
const hasCloudStorage = !!(tg && tg.CloudStorage && tg.isVersionAtLeast && tg.isVersionAtLeast("6.9"));

function storageGet(key) {
  return new Promise((resolve) => {
    if (hasCloudStorage) {
      try {
        tg.CloudStorage.getItem(key, (err, value) => resolve(err ? null : value || null));
      } catch {
        resolve(localStorage.getItem(key));
      }
    } else {
      resolve(localStorage.getItem(key));
    }
  });
}

function storageSet(key, value) {
  return new Promise((resolve) => {
    if (hasCloudStorage) {
      try {
        tg.CloudStorage.setItem(key, value, () => resolve());
      } catch {
        localStorage.setItem(key, value);
        resolve();
      }
    } else {
      localStorage.setItem(key, value);
      resolve();
    }
  });
}

function storageRemoveAll(keys) {
  return new Promise((resolve) => {
    if (hasCloudStorage) {
      try {
        tg.CloudStorage.removeItems(keys, () => resolve());
      } catch {
        keys.forEach((k) => localStorage.removeItem(k));
        resolve();
      }
    } else {
      keys.forEach((k) => localStorage.removeItem(k));
      resolve();
    }
  });
}

const masteredKey = (levelIdx) => `mastered_${levelIdx}`;
const HIGHEST_KEY = "highest_unlocked";

async function loadMasteredSet(levelIdx) {
  const raw = await storageGet(masteredKey(levelIdx));
  if (!raw) return new Set();
  try {
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

async function saveMasteredSet(levelIdx, set) {
  await storageSet(masteredKey(levelIdx), JSON.stringify([...set]));
}

async function loadHighestUnlocked() {
  const raw = await storageGet(HIGHEST_KEY);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), N_LEVELS - 1) : 0;
}

async function saveHighestUnlocked(idx) {
  await storageSet(HIGHEST_KEY, String(idx));
}

// ---------------------------------------------------------------------------
// Утилиты для слов
// ---------------------------------------------------------------------------
function stressIndex(word) {
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== word[i].toLowerCase()) return i;
  }
  return -1;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Состояние игры
// ---------------------------------------------------------------------------
const state = {
  highestUnlocked: 0, // максимальный открытый уровень (0-индекс), персистится
  viewingLevel: 0, // какой уровень сейчас проходим (<= highestUnlocked)
  mastered: new Set(), // выученные слова ТЕКУЩЕГО уровня
  deck: [], // [{word, streak}], активная колода текущего уровня
  current: null,
  locked: false, // блокировка кликов пока показывается фидбек
};

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const gameScreen = $("gameScreen");
const levelUpScreen = $("levelUpScreen");
const allDoneScreen = $("allDoneScreen");
const levelsScreen = $("levelsScreen");
const wordBox = $("wordBox");
const feedback = $("feedback");
const levelPill = $("levelPill");
const progressFill = $("progressFill");
const progressLabel = $("progressLabel");

function showScreen(el) {
  [gameScreen, levelUpScreen, allDoneScreen, levelsScreen].forEach((s) => s.classList.add("hidden"));
  el.classList.remove("hidden");
}

function setActiveTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tabName);
  });
}

function renderWordTiles(word) {
  wordBox.innerHTML = "";
  [...word].forEach((ch, i) => {
    const btn = document.createElement("button");
    btn.className = "letter-tile";
    btn.textContent = ch.toUpperCase();
    btn.addEventListener("click", () => onTileClick(i, btn));
    wordBox.appendChild(btn);
  });
}

function renderProgress() {
  levelPill.textContent = `Уровень ${state.viewingLevel + 1} из ${N_LEVELS}`;
  const total = LEVELS[state.viewingLevel].length;
  const done = state.mastered.size;
  progressFill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  progressLabel.textContent = `${done} / ${total} слов выучено`;
}

function setFeedback(text, stateClass, mnemonicText) {
  feedback.className = "feedback" + (stateClass ? ` ${stateClass}` : "");
  feedback.innerHTML = "";
  const main = document.createElement("div");
  main.textContent = text;
  feedback.appendChild(main);
  if (mnemonicText) {
    const m = document.createElement("span");
    m.className = "mnemonic";
    m.textContent = `📖 ${mnemonicText}`;
    feedback.appendChild(m);
  }
}

// ---------------------------------------------------------------------------
// Игровой цикл
// ---------------------------------------------------------------------------
async function loadLevel(levelIdx, opts = {}) {
  state.viewingLevel = levelIdx;
  state.mastered = await loadMasteredSet(levelIdx);
  const all = LEVELS[levelIdx];
  const remaining = all.filter((w) => !state.mastered.has(w));

  renderProgress();

  if (remaining.length === 0) {
    if (opts.fromGrid) {
      showScreen(gameScreen);
      setActiveTab("game");
      wordBox.innerHTML = "";
      setFeedback("Все слова этого уровня уже выучены ✅ Можешь выбрать другой уровень.", "state-correct");
    } else {
      onLevelComplete(levelIdx);
    }
    return;
  }

  state.deck = shuffle(remaining).map((w) => ({ word: w, streak: 0 }));
  showScreen(gameScreen);
  setActiveTab("game");
  showNextWord();
}

function showNextWord() {
  state.locked = false;
  if (state.deck.length === 0) {
    onLevelComplete(state.viewingLevel);
    return;
  }
  state.current = state.deck[0];
  renderWordTiles(state.current.word);
  setFeedback("Нажми на букву, на которую падает ударение.", "");
}

async function onTileClick(idx, btnEl) {
  if (state.locked || !state.current) return;
  state.locked = true;

  const word = state.current.word;
  const correctIdx = stressIndex(word);
  const isCorrect = idx === correctIdx;
  const tiles = [...wordBox.children];

  tiles[idx].classList.add(isCorrect ? "correct" : "wrong");
  if (!isCorrect) tiles[correctIdx].classList.add("correct");
  tiles.forEach((t) => (t.disabled = true));

  const base = word.toLowerCase();
  const mnemonic = MNEMONICS[base] || null;

  if (isCorrect) {
    state.current.streak += 1;
    setFeedback("✅ Верно!", "state-correct", state.current.streak < MASTERY_STREAK ? mnemonic : null);
    if (state.current.streak >= MASTERY_STREAK) {
      state.mastered.add(word);
      await saveMasteredSet(state.viewingLevel, state.mastered);
      state.deck.shift();
      renderProgress();
      setFeedback("✅ Верно! Слово выучено 🎓", "state-correct");
    } else {
      state.deck.shift();
      const insertAt = Math.min(state.deck.length, 3 + Math.floor(Math.random() * 3));
      state.deck.splice(insertAt, 0, state.current);
    }
  } else {
    state.current.streak = 0;
    setFeedback(`❌ Неверно. Правильно: ${word}`, "state-wrong", mnemonic);
    state.deck.shift();
    const insertAt = Math.min(state.deck.length, 1 + Math.floor(Math.random() * 2));
    state.deck.splice(insertAt, 0, state.current);
  }

  if (tg && tg.HapticFeedback) {
    tg.HapticFeedback.notificationOccurred(isCorrect ? "success" : "error");
  }

  setTimeout(showNextWord, isCorrect ? 900 : 2200);
}

async function onLevelComplete(levelIdx) {
  setActiveTab("game");
  if (levelIdx >= N_LEVELS - 1) {
    showScreen(allDoneScreen);
    return;
  }
  if (levelIdx === state.highestUnlocked) {
    state.highestUnlocked = levelIdx + 1;
    await saveHighestUnlocked(state.highestUnlocked);
  }
  $("levelUpFrom").textContent = String(levelIdx + 1);
  $("levelUpTo").textContent = String(levelIdx + 2);
  showScreen(levelUpScreen);
}

// ---------------------------------------------------------------------------
// Экран уровней
// ---------------------------------------------------------------------------
async function renderLevelsGrid() {
  const grid = $("levelsGrid");
  grid.innerHTML = "";
  for (let i = 0; i < N_LEVELS; i++) {
    const mastered = await loadMasteredSet(i);
    const total = LEVELS[i].length;
    const locked = i > state.highestUnlocked;

    const done = mastered.size >= total;
    const pct = total ? Math.round((mastered.size / total) * 100) : 0;

    const card = document.createElement("button");
    card.className =
      "level-card" +
      (locked ? " locked" : "") +
      (done ? " done" : "") +
      (i === state.viewingLevel ? " active" : "");
    card.disabled = locked;
    card.innerHTML = `
      <div class="lvl-badge">${locked ? "🔒" : done ? "✓" : i + 1}</div>
      <div class="lvl-num">Уровень ${i + 1}</div>
      <div class="lvl-stat">${mastered.size} / ${total} выучено</div>
      <div class="lvl-bar"><div class="lvl-bar-fill" style="width:${pct}%"></div></div>
    `;
    card.addEventListener("click", () => {
      showScreen(gameScreen);
      setActiveTab("game");
      loadLevel(i, { fromGrid: true });
    });
    grid.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Инициализация и обработчики кнопок
// ---------------------------------------------------------------------------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const tab = btn.dataset.tab;
    setActiveTab(tab);
    if (tab === "levels") {
      await renderLevelsGrid();
      showScreen(levelsScreen);
    } else {
      showScreen(gameScreen);
    }
  });
});

$("nextLevelBtn").addEventListener("click", () => {
  loadLevel(state.viewingLevel + 1);
});

$("restartBtn").addEventListener("click", () => {
  const doReset = async () => {
    const keys = [HIGHEST_KEY, ...LEVELS.map((_, i) => masteredKey(i))];
    await storageRemoveAll(keys);
    state.highestUnlocked = 0;
    loadLevel(0);
  };
  if (tg && tg.showConfirm) {
    tg.showConfirm("Сбросить весь прогресс и начать заново?", (ok) => ok && doReset());
  } else if (window.confirm("Сбросить весь прогресс и начать заново?")) {
    doReset();
  }
});

(async function init() {
  state.highestUnlocked = await loadHighestUnlocked();
  await loadLevel(state.highestUnlocked);
})();
