/**
 * ui.js — СЛОЙ ИНТЕРФЕЙСА.
 *
 * Единственный файл, который знает про DOM. Вся работа с данными идёт
 * строго через три модуля:
 *   core.js      — расчёты (чистые функции, получают время аргументом);
 *   storage.js   — сохранение/загрузка;
 *   notifier.js  — напоминания.
 *
 * Здесь НЕТ прямых обращений к localStorage и к Notification:
 * это запрещено архитектурой, иначе при переносе на телефон пришлось бы
 * править не только адаптеры, но и интерфейс.
 */

import * as core from './core.js';
import { storage } from './storage.js';
import { notifier } from './notifier.js';

/* ------------------------------------------------------------------ *
 * Состояние приложения (только в памяти — оно не является «данными»)
 * ------------------------------------------------------------------ */

let state = null;              // модель из core.js
let viewDateKey = '';          // дата, открытая на экране «Сегодня»
let activeTab = 'today';       // today | stats | habits | settings
let editor = null;             // null — форма закрыта, иначе черновик привычки
let firedReminders = new Set(); // ключи уже сработавших напоминаний
let tickHandle = null;         // интервал обновления «сейчас»
let lastKnownToday = '';       // чтобы заметить переход через полночь
let toastTimer = null;

/* ------------------------------------------------------------------ *
 * Мелкие утилиты
 * ------------------------------------------------------------------ */

/** Короткий querySelector. */
function $(selector) {
  return document.querySelector(selector);
}

/** Экранирование HTML — любое пользовательское значение попадает в шаблон только через него. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** «Сегодня» по локальным часам устройства. */
function todayKey() {
  return core.dateKeyFromDate(new Date());
}

/** Текущее время в минутах от начала суток. */
function currentMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/** Уникальный идентификатор привычки (в core его нет — там не место случайности). */
function makeHabitId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ *
 * Загрузка, сохранение состояния
 * ------------------------------------------------------------------ */

/** Читает состояние из хранилища; если данных нет — создаёт демо-набор. */
function loadState() {
  const raw = storage.load();
  if (raw) {
    try {
      return core.deserialize(raw);
    } catch (error) {
      console.warn('[ui] Данные повреждены, загружаю демо-набор:', error);
    }
  }
  return core.createDemoState(todayKey());
}

/** Сохраняет состояние в хранилище.
 *  ПЕРЕНОС НА ТЕЛЕФОН: методы storage станут асинхронными (SQLite),
 *  поэтому здесь останется добавить `await` — остальной код не меняется. */
function persist() {
  const snapshot = JSON.parse(core.serialize(state, false));
  const ok = storage.save(snapshot);
  if (!ok && storage.isAvailable() === false) {
    console.warn('[ui] Постоянное хранилище недоступно — данные живут только в памяти.');
  }
}

/** Применяет новое состояние: сохраняет, перерисовывает, пересобирает напоминания. */
function commit(nextState) {
  state = nextState;
  persist();
  render();
  scheduleReminders();
}

/* ------------------------------------------------------------------ *
 * Тема оформления
 * ------------------------------------------------------------------ */

/** Ставит атрибут data-theme и обновляет цвет адресной строки браузера. */
function applyTheme() {
  const theme = state.settings.theme;
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);

  const isDark = theme === 'dark'
    || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', isDark ? '#0b1220' : '#eef2f8');
}

/* ------------------------------------------------------------------ *
 * Напоминания
 * ------------------------------------------------------------------ */

/** Пересобирает очередь напоминаний на сегодня и на завтра. */
function scheduleReminders() {
  if (!notifier.isSupported()) return;
  notifier.cancelAll();

  const today = todayKey();
  [0, 1].forEach((offset) => {
    const key = core.addDaysToKey(today, offset);
    core.collectReminders(state, key).forEach((reminder) => {
      if (firedReminders.has(reminder.key)) return;
      if (reminder.at.getTime() <= Date.now()) return; // момент уже прошёл
      notifier.schedule({
        id: reminder.key,
        at: reminder.at,
        title: reminder.title,
        body: reminder.body,
      });
    });
  });

  // Чистим память о сработавших напоминаниях за прошедшие дни.
  const fresh = new Set();
  firedReminders.forEach((key) => {
    if (key.startsWith(today) || key.startsWith(core.addDaysToKey(today, 1))) fresh.add(key);
  });
  firedReminders = fresh;
}

/** Раз в 30 секунд: переход через полночь, обновление «сейчас», новые напоминания. */
function startTicker() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(() => {
    const today = todayKey();
    if (today !== lastKnownToday) {
      lastKnownToday = today;
      if (viewDateKey !== lastKnownToday) viewDateKey = today;
      scheduleReminders();
    }
    if (!isUserEditing()) render();
    scheduleReminders();
  }, 30000);
}

/** Пользователь что-то печатает — перерисовка снесла бы ввод. */
function isUserEditing() {
  const element = document.activeElement;
  return Boolean(element && element.closest && element.closest('input, select, textarea'));
}

/* ------------------------------------------------------------------ *
 * Отрисовка
 * ------------------------------------------------------------------ */

/** Точка входа отрисовки: собирает HTML активного экрана. */
function render() {
  const host = $('#app');
  if (!host) return;

  if (activeTab === 'stats') host.innerHTML = viewStats();
  else if (activeTab === 'habits') host.innerHTML = viewHabits();
  else if (activeTab === 'settings') host.innerHTML = viewSettings();
  else host.innerHTML = viewToday();

  renderHeader();
  renderTabbar();
}

/** Шапка: заголовок и КПД за сегодня. */
function renderHeader() {
  const today = todayKey();
  const stats = core.getDayStats(state, today);
  const title = $('#header-title');
  const subtitle = $('#header-subtitle');
  if (title) title.textContent = 'Трекер КПД';
  if (subtitle) subtitle.textContent = `Сегодня: ${stats.done}/${stats.planned} · КПД ${stats.kpi}%`;
}

/** Нижнее меню: подсветка активной вкладки. */
function renderTabbar() {
  document.querySelectorAll('[data-tab]').forEach((button) => {
    const isActive = button.dataset.tab === activeTab;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });
}

/* ------------------------------------------------------------------ *
 * Экран «Сегодня»
 * ------------------------------------------------------------------ */

function viewToday() {
  const today = todayKey();
  const isToday = viewDateKey === today;
  const stats = core.getDayStats(state, viewDateKey);
  const entries = core.getScheduleForDate(state, viewDateKey, isToday ? currentMinutes() : null);

  const label = isToday
    ? `Сегодня, ${core.formatDateKeyHuman(viewDateKey)}`
    : core.formatDateKeyLong(viewDateKey);

  const list = entries.length
    ? entries.map(timelineItem).join('')
    : `<li class="empty">На этот день привычек нет.<br>Добавьте их на вкладке «Привычки».</li>`;

  return `
    <section class="card datebar">
      <button class="iconbtn" data-action="day-shift" data-delta="-1" aria-label="Предыдущий день">‹</button>
      <div class="datebar__center">
        <div class="datebar__label">${esc(label)}</div>
        <div class="datebar__sub">План: ${stats.planned} · ${core.formatDuration(stats.plannedMinutes)}</div>
      </div>
      <button class="iconbtn" data-action="day-shift" data-delta="1" aria-label="Следующий день">›</button>
    </section>

    ${isToday ? '' : '<button class="ghostbtn ghostbtn--wide" data-action="day-today">Вернуться к сегодняшнему дню</button>'}

    <section class="kpirow">
      ${statCard('Выполнено', `${stats.done}/${stats.planned}`, `${core.formatDuration(stats.doneMinutes)}`, 'ok')}
      ${statCard('Процент выполнения', `${stats.completion}%`, `пропущено: ${stats.skipped}`, '')}
      ${statCard('КПД дня', `${stats.kpi}%`, 'минуты: факт / план', 'accent')}
    </section>

    <ul class="timeline">${list}</ul>
  `;
}

/** Карточка-показатель. */
function statCard(label, value, hint, tone) {
  return `
    <div class="statcard ${tone ? `statcard--${tone}` : ''}">
      <div class="statcard__label">${esc(label)}</div>
      <div class="statcard__value">${esc(value)}</div>
      <div class="statcard__hint">${esc(hint)}</div>
    </div>`;
}

/** Одна строка таймлайна. */
function timelineItem(entry) {
  const streak = core.getHabitStreak(state, entry.habitId, todayKey());
  const classes = [
    'item',
    `item--${entry.status}`,
    entry.isActive ? 'item--active' : '',
    entry.isPast && entry.status === core.STATUS.PENDING ? 'item--missed' : '',
  ].filter(Boolean).join(' ');

  return `
    <li class="${classes}" style="--habit-color: ${esc(entry.color)}">
      <div class="item__time">
        <strong>${esc(entry.startTime)}</strong>
        <span>${esc(core.formatDuration(entry.duration))}</span>
      </div>
      <div class="item__body">
        <div class="item__head">
          <h3 class="item__title">${esc(entry.title)}</h3>
          <span class="chip chip--prio${entry.priority}">${esc(core.priorityLabel(entry.priority))}</span>
        </div>
        <div class="item__meta">
          ${esc(entry.startTime)}–${esc(entry.endTime)}${entry.crossesMidnight ? ' (+1 день)' : ''}
          · серия ${streak} дн.
          ${entry.isActive ? ' · <b>идёт сейчас</b>' : ''}
        </div>
        <div class="item__actions">
          <button class="markbtn markbtn--done${entry.status === core.STATUS.DONE ? ' is-active' : ''}"
                  data-action="mark" data-habit="${esc(entry.habitId)}" data-status="done"
                  aria-pressed="${entry.status === core.STATUS.DONE}">Выполнено</button>
          <button class="markbtn markbtn--skipped${entry.status === core.STATUS.SKIPPED ? ' is-active' : ''}"
                  data-action="mark" data-habit="${esc(entry.habitId)}" data-status="skipped"
                  aria-pressed="${entry.status === core.STATUS.SKIPPED}">Пропущено</button>
          <button class="markbtn markbtn--moved${entry.status === core.STATUS.MOVED ? ' is-active' : ''}"
                  data-action="mark" data-habit="${esc(entry.habitId)}" data-status="moved"
                  aria-pressed="${entry.status === core.STATUS.MOVED}">Перенесено</button>
        </div>
      </div>
    </li>`;
}

/* ------------------------------------------------------------------ *
 * Экран «Статистика»
 * ------------------------------------------------------------------ */

function viewStats() {
  const today = todayKey();
  const week = core.getWeekRange(today);
  const month = core.getMonthRange(today);
  const weekRange = core.clampRangeToToday(week.from, week.to, today);
  const monthRange = core.clampRangeToToday(month.from, month.to, today);

  const dayStats = core.getDayStats(state, today);
  const weekStats = core.getRangeStats(state, weekRange.from, weekRange.to);
  const monthStats = core.getRangeStats(state, monthRange.from, monthRange.to);
  const last7 = core.getLastDaysStats(state, today, 7);

  const rows = state.habits.length
    ? state.habits.map(habitRow).join('')
    : '<li class="empty">Привычек пока нет.</li>';

  return `
    <section class="kpirow">
      ${statCard('КПД сегодня', `${dayStats.kpi}%`, `${core.formatDuration(dayStats.doneMinutes)} из ${core.formatDuration(dayStats.plannedMinutes)}`, 'accent')}
      ${statCard('КПД недели', `${weekStats.kpi}%`, `выполнение ${weekStats.completion}%`, 'accent')}
      ${statCard('КПД месяца', `${monthStats.kpi}%`, `выполнение ${monthStats.completion}%`, 'accent')}
    </section>

    <section class="card">
      <h2 class="card__title">Последние 7 дней</h2>
      <div class="chart">
        ${last7.map(chartBar).join('')}
      </div>
      <p class="card__note">Высота столбца — КПД дня. Серый столбец — план был, но ничего не выполнено.</p>
    </section>

    <section class="card">
      <h2 class="card__title">По привычкам</h2>
      <ul class="habitstats">${rows}</ul>
    </section>
  `;
}

/** Столбик графика за один день. */
function chartBar(day) {
  const height = day.plannedMinutes === 0 ? 2 : Math.max(3, Math.round(day.kpi * 0.8));
  const tone = day.kpi >= 80 ? 'is-good' : day.kpi >= 40 ? 'is-mid' : 'is-low';
  return `
    <div class="chart__col${day.isToday ? ' is-today' : ''}">
      <div class="chart__bar ${day.plannedMinutes === 0 ? 'is-empty' : tone}" style="height:${height}%">
        <span class="chart__value">${day.plannedMinutes === 0 ? '—' : `${day.kpi}%`}</span>
      </div>
      <div class="chart__label">${esc(day.weekdayShort)}</div>
    </div>`;
}

/** Строка статистики по одной привычке. */
function habitRow(habit) {
  const today = todayKey();
  const fromKey = habit.createdAt && core.compareKeys(habit.createdAt, today) <= 0
    ? habit.createdAt
    : core.addDaysToKey(today, -30);
  const stats = core.getHabitStats(state, habit.id, fromKey, today, today);

  return `
    <li class="habitstat" style="--habit-color: ${esc(habit.color)}">
      <div class="habitstat__head">
        <span class="dot"></span>
        <b>${esc(habit.title)}</b>
        <span class="habitstat__time">${esc(habit.time)}</span>
      </div>
      <div class="habitstat__meta">
        Серия: <b>${stats.streak}</b> · Лучшая: <b>${stats.bestStreak}</b>
        · Выполнение: <b>${stats.completion}%</b> (${stats.done}/${stats.planned})
      </div>
    </li>`;
}

/* ------------------------------------------------------------------ *
 * Экран «Привычки»
 * ------------------------------------------------------------------ */

function viewHabits() {
  if (editor) return habitForm();

  const today = todayKey();
  const items = state.habits.length
    ? state.habits.map((habit) => habitListRow(habit, today)).join('')
    : '<li class="empty">Привычек нет. Добавьте первую.</li>';

  return `
    <button class="primarybtn primarybtn--wide" data-action="editor-new">+ Добавить привычку</button>
    <ul class="habitlist">${items}</ul>
  `;
}

/** Строка списка привычек с кнопками «изменить» и «удалить». */
function habitListRow(habit, today) {
  const summary = core.getHabitSummary(state, habit, today);
  return `
    <li class="habitrow" style="--habit-color: ${esc(habit.color)}">
      <div class="habitrow__main">
        <div class="habitrow__head">
          <span class="dot"></span>
          <b>${esc(habit.title)}</b>
        </div>
        <div class="habitrow__meta">
          ${esc(habit.time)} · ${esc(core.formatDuration(habit.duration))} · ${esc(core.formatHabitDays(habit))}
          · ${esc(core.priorityLabel(habit.priority))}
        </div>
        <div class="habitrow__meta">
          серия ${summary.streak} дн. · лучшая ${summary.bestStreak} · ${summary.completion}%
        </div>
      </div>
      <div class="habitrow__actions">
        <button class="iconbtn" data-action="editor-edit" data-id="${esc(habit.id)}" aria-label="Изменить">✎</button>
        <button class="iconbtn iconbtn--danger" data-action="habit-delete" data-id="${esc(habit.id)}" aria-label="Удалить">✕</button>
      </div>
    </li>`;
}

/** Форма создания/редактирования привычки. */
function habitForm() {
  const isNew = !editor.id;
  const days = core.normalizeDays(editor.days);

  const dayBoxes = core.WEEKDAYS.map((weekday) => `
    <label class="daybox">
      <input type="checkbox" name="days" value="${weekday.iso}" ${days.includes(weekday.iso) ? 'checked' : ''}>
      <span>${weekday.short}</span>
    </label>`).join('');

  const priorityOptions = core.PRIORITIES
    .map((item) => `<option value="${item.value}" ${Number(editor.priority) === item.value ? 'selected' : ''}>${item.label}</option>`)
    .join('');

  return `
    <form class="card form" data-action="habit-save">
      <h2 class="card__title">${isNew ? 'Новая привычка' : 'Редактирование привычки'}</h2>

      <label class="field">
        <span>Название</span>
        <input type="text" name="title" maxlength="60" required value="${esc(editor.title)}" placeholder="Например, зарядка">
      </label>

      <div class="grid2">
        <label class="field">
          <span>Время</span>
          <input type="time" name="time" required value="${esc(editor.time)}">
        </label>
        <label class="field">
          <span>Длительность, мин</span>
          <input type="number" name="duration" min="1" max="1440" step="5" required value="${esc(editor.duration)}">
        </label>
      </div>

      <fieldset class="field">
        <legend>Дни недели</legend>
        <div class="days">${dayBoxes}</div>
      </fieldset>

      <div class="grid2">
        <label class="field">
          <span>Приоритет</span>
          <select name="priority">${priorityOptions}</select>
        </label>
        <label class="field">
          <span>Цвет</span>
          <input type="color" name="color" value="${esc(editor.color)}">
        </label>
      </div>

      <div class="form__actions">
        <button type="submit" class="primarybtn">Сохранить</button>
        <button type="button" class="ghostbtn" data-action="editor-close">Отмена</button>
      </div>
    </form>
  `;
}

/* ------------------------------------------------------------------ *
 * Экран «Настройки»
 * ------------------------------------------------------------------ */

function viewSettings() {
  const settings = state.settings;
  const permission = notifier.getPermission();
  const permissionText = {
    granted: 'разрешены',
    denied: 'запрещены в браузере',
    default: 'не запрошены',
    unsupported: 'не поддерживаются устройством',
  }[permission] || permission;

  const themeButton = (value, label) => `
    <button class="segbtn${settings.theme === value ? ' is-active' : ''}"
            data-action="set-theme" data-theme="${value}">${label}</button>`;

  return `
    <section class="card">
      <h2 class="card__title">Напоминания</h2>
      <label class="field">
        <span>Напомнить заранее, мин</span>
        <input type="number" name="reminderLeadMinutes" data-setting="number"
               min="0" max="240" step="5" value="${esc(settings.reminderLeadMinutes)}">
      </label>
      <p class="card__note">Системные уведомления: ${esc(permissionText)}.
        Напоминания попадающие в тихие часы не показываются.</p>
      <div class="form__actions">
        <button class="primarybtn" data-action="notify-request">Разрешить уведомления</button>
        <button class="ghostbtn" data-action="notify-test">Проверить</button>
      </div>
    </section>

    <section class="card">
      <h2 class="card__title">Тихие часы</h2>
      <div class="grid2">
        <label class="field">
          <span>С</span>
          <input type="time" data-setting="time" name="quietFrom" value="${esc(settings.quietFrom)}">
        </label>
        <label class="field">
          <span>До</span>
          <input type="time" data-setting="time" name="quietTo" value="${esc(settings.quietTo)}">
        </label>
      </div>
      <p class="card__note">Интервал может пересекать полночь (например, 22:30 – 07:30).</p>
    </section>

    <section class="card">
      <h2 class="card__title">Тема</h2>
      <div class="segmented">
        ${themeButton('auto', 'Как в системе')}
        ${themeButton('light', 'Светлая')}
        ${themeButton('dark', 'Тёмная')}
      </div>
    </section>

    <section class="card">
      <h2 class="card__title">Данные</h2>
      <div class="form__actions form__actions--column">
        <button class="ghostbtn" data-action="export">Экспорт в JSON</button>
        <button class="ghostbtn" data-action="import">Импорт из JSON</button>
        <button class="ghostbtn" data-action="demo">Загрузить демо-данные</button>
        <button class="ghostbtn ghostbtn--danger" data-action="reset">Удалить все данные</button>
      </div>
      <input type="file" id="import-input" accept="application/json,.json" hidden>
    </section>

    <p class="footer-note">Трекер КПД · схема данных v${esc(core.STATE_VERSION)} · данные хранятся только на вашем устройстве.</p>
  `;
}

/* ------------------------------------------------------------------ *
 * Всплывающие сообщения
 * ------------------------------------------------------------------ */

function toast(message) {
  const host = $('#toast-host');
  if (!host) return;
  if (toastTimer) clearTimeout(toastTimer);

  host.innerHTML = `<div class="toast">${esc(message)}</div>`;
  const element = host.firstElementChild;
  toastTimer = setTimeout(() => {
    element.classList.add('toast--out');
    setTimeout(() => { host.innerHTML = ''; }, 300);
  }, 2400);
}

/* ------------------------------------------------------------------ *
 * Обработчики событий
 * ------------------------------------------------------------------ */

function bindEvents() {
  const app = $('#app');
  app.addEventListener('click', onClick);
  app.addEventListener('submit', onSubmit);
  app.addEventListener('change', onChange);

  const tabbar = $('#tabbar');
  tabbar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    activeTab = button.dataset.tab;
    editor = null;
    render();
  });

  // Системные уведомления, показанные при открытом приложении.
  notifier.onFire((payload) => {
    firedReminders.add(payload.id);
    toast(payload.title);
    if (!isUserEditing()) render();
    scheduleReminders();
  });

  // Реакция на смену системной темы при режиме «как в системе».
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings.theme === 'auto') applyTheme();
  });
}

function onClick(event) {
  const trigger = event.target.closest('[data-action]');
  if (!trigger || trigger.tagName === 'FORM') return;
  const action = trigger.dataset.action;

  switch (action) {
    case 'day-shift': {
      viewDateKey = core.addDaysToKey(viewDateKey, Number(trigger.dataset.delta));
      render();
      break;
    }
    case 'day-today': {
      viewDateKey = todayKey();
      render();
      break;
    }
    case 'mark': {
      const { habit, status } = trigger.dataset;
      const at = new Date().toISOString();
      commit(core.toggleHabitStatus(state, viewDateKey, habit, status, { at }));
      break;
    }
    case 'editor-new': {
      editor = {
        id: '',
        title: '',
        time: '09:00',
        duration: 30,
        days: [1, 2, 3, 4, 5, 6, 7],
        priority: 2,
        color: core.HABIT_COLORS[state.habits.length % core.HABIT_COLORS.length],
      };
      render();
      break;
    }
    case 'editor-edit': {
      const habit = core.findHabit(state, trigger.dataset.id);
      if (habit) editor = { ...habit };
      render();
      break;
    }
    case 'editor-close': {
      editor = null;
      render();
      break;
    }
    case 'habit-delete': {
      const habit = core.findHabit(state, trigger.dataset.id);
      if (!habit) break;
      if (window.confirm(`Удалить привычку «${habit.title}» вместе с историей отметок?`)) {
        const habits = state.habits.filter((item) => item.id !== habit.id);
        const logs = {};
        Object.keys(state.logs).forEach((key) => {
          const entries = { ...state.logs[key] };
          delete entries[habit.id];
          if (Object.keys(entries).length) logs[key] = entries;
        });
        commit({ ...state, habits, logs });
      }
      break;
    }
    case 'set-theme': {
      commit({ ...state, settings: { ...state.settings, theme: trigger.dataset.theme } });
      applyTheme();
      break;
    }
    case 'notify-request': {
      notifier.requestPermission().then((permission) => {
        commit({ ...state, settings: { ...state.settings, notificationsEnabled: permission === 'granted' } });
        toast(permission === 'granted' ? 'Уведомления разрешены' : 'Разрешение не выдано');
      });
      break;
    }
    case 'notify-test': {
      notifier.test().then((permission) => {
        if (permission !== 'granted') toast('Браузер не разрешил уведомления — покажу внутри приложения');
      });
      scheduleReminders();
      break;
    }
    case 'export': {
      exportJson();
      break;
    }
    case 'import': {
      const input = $('#import-input');
      if (input) input.click();
      break;
    }
    case 'demo': {
      if (window.confirm('Заменить текущие данные демонстрационными?')) {
        commit(core.createDemoState(todayKey()));
        toast('Демо-данные загружены');
      }
      break;
    }
    case 'reset': {
      if (window.confirm('Удалить все привычки и отметки без возможности отмены?')) {
        storage.clear();
        commit(core.createEmptyState());
        toast('Все данные удалены');
      }
      break;
    }
    default:
      break;
  }
}

function onSubmit(event) {
  const form = event.target.closest('form[data-action="habit-save"]');
  if (!form) return;
  event.preventDefault();

  const data = new FormData(form);
  const days = data.getAll('days').map(Number);
  if (!days.length) {
    toast('Выберите хотя бы один день недели');
    return;
  }

  const title = String(data.get('title') || '').trim();
  if (!title) {
    toast('Введите название привычки');
    return;
  }

  const draft = core.createHabit({
    id: editor.id || makeHabitId(),
    title,
    time: String(data.get('time') || '09:00'),
    duration: Number(data.get('duration') || 30),
    days,
    priority: Number(data.get('priority') || 2),
    color: String(data.get('color') || core.HABIT_COLORS[0]),
    createdAt: editor.createdAt || todayKey(),
  });

  const exists = Boolean(core.findHabit(state, draft.id));
  const habits = exists
    ? state.habits.map((habit) => (habit.id === draft.id ? draft : habit))
    : [...state.habits, draft];

  editor = null;
  commit({ ...state, habits });
  toast(exists ? 'Привычка обновлена' : 'Привычка добавлена');
}

function onChange(event) {
  const target = event.target;

  // Импорт файла JSON.
  if (target.id === 'import-input') {
    const file = target.files && target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        commit(core.deserialize(String(reader.result)));
        toast('Данные импортированы');
      } catch (error) {
        toast('Не удалось прочитать файл: некорректный JSON');
        console.warn('[ui] Импорт не удался:', error);
      }
    };
    reader.readAsText(file);
    target.value = '';
    return;
  }

  // Настройки.
  const setting = target.dataset.setting;
  if (!setting) return;

  if (setting === 'number') {
    const value = core.clamp(target.value, 0, 240);
    commit({ ...state, settings: { ...state.settings, [target.name]: value } });
  } else if (setting === 'time') {
    if (!core.isValidTime(target.value)) {
      toast('Некорректное время');
      render();
      return;
    }
    const settings = { ...state.settings, [target.name]: target.value };
    commit({ ...state, settings });
    // Изменились тихие часы — очередь напоминаний нужно пересобрать.
    scheduleReminders();
  }
}

/* ------------------------------------------------------------------ *
 * Экспорт JSON
 * ------------------------------------------------------------------ */

function exportJson() {
  const blob = new Blob([core.serialize(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `kpd-backup-${todayKey()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('Файл сохранён');
}

/* ------------------------------------------------------------------ *
 * Service worker (PWA)
 * ------------------------------------------------------------------ */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((error) => {
      console.warn('[ui] Service worker не зарегистрирован:', error);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Запуск
 * ------------------------------------------------------------------ */

function init() {
  state = loadState();
  lastKnownToday = todayKey();
  viewDateKey = lastKnownToday;

  applyTheme();
  bindEvents();
  registerServiceWorker();
  render();
  startTicker();
  scheduleReminders();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
