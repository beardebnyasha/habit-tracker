/**
 * core.js — ЧИСТАЯ ЛОГИКА ТРЕКЕРА КПД.
 *
 * Правила слоя (соблюдение обязательно):
 *  1. В файле нет ни одного обращения к браузеру: window, document, localStorage,
 *     Notification, navigator, fetch — не используются вообще.
 *  2. Нет вызовов Date.now() и new Date() без аргументов. Текущее время всегда
 *     приходит параметром:
 *        - todayKey    — строка 'YYYY-MM-DD' (календарный день в локальной зоне);
 *        - nowMinutes  — минуты от начала суток (0..1439).
 *     Поэтому логику можно прогонять в тестах на любой произвольной дате.
 *  3. Все функции чистые: не мутируют входные данные, возвращают новые значения.
 *     Состояние (state) — обычный объект, его «изменение» делается копированием.
 *
 * Из этого файла ничего не импортируется: core.js — самый нижний слой,
 * от него зависят только ui.js (и test.html).
 */

/** Версия схемы данных. Поднимается при несовместимом изменении формата state. */
export const STATE_VERSION = 1;

/** Минут в сутках. */
export const MINUTES_PER_DAY = 1440;

/** Статусы отметки привычки. */
export const STATUS = Object.freeze({
  PENDING: 'pending', // ещё не отмечена
  DONE: 'done',       // выполнено
  SKIPPED: 'skipped', // пропущено
  MOVED: 'moved',     // перенесено
});

/** Дни недели в формате ISO 8601: 1 — понедельник … 7 — воскресенье. */
export const WEEKDAYS = Object.freeze([
  { iso: 1, short: 'Пн', full: 'Понедельник' },
  { iso: 2, short: 'Вт', full: 'Вторник' },
  { iso: 3, short: 'Ср', full: 'Среда' },
  { iso: 4, short: 'Чт', full: 'Четверг' },
  { iso: 5, short: 'Пт', full: 'Пятница' },
  { iso: 6, short: 'Сб', full: 'Суббота' },
  { iso: 7, short: 'Вс', full: 'Воскресенье' },
]);

/** Месяцы в родительном падеже — для подписи «2 ноября». */
export const MONTHS_GENITIVE = Object.freeze([
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]);

/** Приоритеты привычки: чем больше число, тем важнее. */
export const PRIORITIES = Object.freeze([
  { value: 1, label: 'Низкий', short: 'низк.' },
  { value: 2, label: 'Обычный', short: 'обычн.' },
  { value: 3, label: 'Высокий', short: 'выс.' },
]);

/** Предустановленная палитра цветов привычки. */
export const HABIT_COLORS = Object.freeze([
  '#22c55e', '#38bdf8', '#a78bfa', '#f472b6', '#f59e0b', '#ef4444', '#14b8a6',
]);

/** Значения настроек по умолчанию. */
export function defaultSettings() {
  return {
    reminderLeadMinutes: 10, // за сколько минут напомнить
    quietFrom: '22:30',      // начало тихих часов
    quietTo: '07:30',        // конец тихих часов (может быть «через полночь»)
    theme: 'auto',           // auto | light | dark
    notificationsEnabled: false,
  };
}

/* ------------------------------------------------------------------ *
 * 1. ПРИМИТИВЫ ВРЕМЕНИ СУТОК
 * ------------------------------------------------------------------ */

/** Дополняет число нулём слева до двух цифр: 7 -> '07'. */
export function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * Строка времени 'HH:MM' -> минуты от начала суток.
 * @param {string} time
 * @returns {number} 0..1439, либо NaN для некорректной строки
 */
export function parseTimeToMinutes(time) {
  if (typeof time !== 'string') return NaN;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return NaN;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return NaN;
  return hours * 60 + minutes;
}

/**
 * Минуты от начала суток -> строка 'HH:MM'.
 * Значения за пределами суток «заворачиваются»: 1470 -> '00:30'.
 * Отрицательные тоже: -30 -> '23:30'.
 */
export function minutesToTime(totalMinutes) {
  return `${pad2(Math.floor(normalizeMinutes(totalMinutes) / 60))}:${pad2(normalizeMinutes(totalMinutes) % 60)}`;
}

/** Приводит любое число минут к диапазону 0..1439. */
export function normalizeMinutes(totalMinutes) {
  return ((Math.trunc(totalMinutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** Проверяет, что строка — корректное время 'HH:MM'. */
export function isValidTime(time) {
  return !Number.isNaN(parseTimeToMinutes(time));
}

/** Человекочитаемая длительность: 90 -> '1 ч 30 мин'. */
export function formatDuration(minutes) {
  const total = Math.max(0, Math.trunc(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours && rest) return `${hours} ч ${rest} мин`;
  if (hours) return `${hours} ч`;
  return `${rest} мин`;
}

/* ------------------------------------------------------------------ *
 * 2. ПРИМИТИВЫ КАЛЕНДАРЯ
 * Вся арифметика дат — на «номере дня» (дни от 1970-01-01), без объектов Date.
 * Это делает функции чистыми и полностью предсказуемыми в тестах.
 * ------------------------------------------------------------------ */

/** Алгоритм Howard Hinnant: (год, месяц, день) -> номер дня от эпохи. */
export function daysFromCivil(year, month, day) {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Обратный алгоритм: номер дня -> { y, m, d }. */
export function civilFromDays(dayNumber) {
  const z = dayNumber + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { y: year + (month <= 2 ? 1 : 0), m: month, d: day };
}

/** Собирает ключ даты 'YYYY-MM-DD' из чисел. */
export function dateKeyFromParts(year, month, day) {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Ключ даты из объекта Date (локальная зона устройства).
 * Date приходит аргументом — глобальных часов внутри core нет.
 */
export function dateKeyFromDate(date) {
  return dateKeyFromParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** Разбирает 'YYYY-MM-DD' -> { y, m, d }. */
export function parseDateKey(key) {
  const parts = String(key).split('-').map(Number);
  return { y: parts[0], m: parts[1], d: parts[2] };
}

/** 'YYYY-MM-DD' -> номер дня от эпохи. */
export function dayNumberFromKey(key) {
  const { y, m, d } = parseDateKey(key);
  return daysFromCivil(y, m, d);
}

/** Сдвигает дату на delta дней: ('2026-01-31', 1) -> '2026-02-01'. */
export function addDaysToKey(key, delta) {
  const civil = civilFromDays(dayNumberFromKey(key) + delta);
  return dateKeyFromParts(civil.y, civil.m, civil.d);
}

/** День недели в формате ISO: 1 — понедельник … 7 — воскресенье. */
export function weekdayFromKey(key) {
  return ((dayNumberFromKey(key) + 3) % 7 + 7) % 7 + 1;
}

/** Сравнение ключей дат: -1 / 0 / 1 (лексикографика совпадает с хронологией). */
export function compareKeys(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Количество дней в месяце. */
export function daysInMonth(year, month) {
  return daysFromCivil(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1)
    - daysFromCivil(year, month, 1);
}

/** Первый день недели (понедельник) для указанной даты. */
export function startOfWeekKey(key) {
  return addDaysToKey(key, -(weekdayFromKey(key) - 1));
}

/** Последний день недели (воскресенье). */
export function endOfWeekKey(key) {
  return addDaysToKey(startOfWeekKey(key), 6);
}

/** Первое число месяца. */
export function startOfMonthKey(key) {
  const { y, m } = parseDateKey(key);
  return dateKeyFromParts(y, m, 1);
}

/** Последнее число месяца. */
export function endOfMonthKey(key) {
  const { y, m } = parseDateKey(key);
  return dateKeyFromParts(y, m, daysInMonth(y, m));
}

/** Русская подпись даты: '2026-11-02' -> '2 ноября 2026'. */
export function formatDateKeyHuman(key) {
  const { y, m, d } = parseDateKey(key);
  return `${d} ${MONTHS_GENITIVE[m - 1]} ${y}`;
}

/** Подпись даты со днём недели: '2 ноября, понедельник'. */
export function formatDateKeyLong(key) {
  const { m, d } = parseDateKey(key);
  const weekday = WEEKDAYS[weekdayFromKey(key) - 1];
  return `${d} ${MONTHS_GENITIVE[m - 1]}, ${weekday.full.toLowerCase()}`;
}

/**
 * Локальные «настенные часы» (год/месяц/день/час/минута) -> объект Date.
 * Используется, чтобы передать в notifier точный момент напоминания.
 */
export function dateFromKeyAndMinutes(key, minutes) {
  const { y, m, d } = parseDateKey(key);
  const normalized = normalizeMinutes(minutes);
  return new Date(y, m - 1, d, Math.floor(normalized / 60), normalized % 60, 0, 0);
}

/* ------------------------------------------------------------------ *
 * 3. МОДЕЛЬ ПРИВЫЧКИ
 * ------------------------------------------------------------------ */

/**
 * Создаёт нормализованную привычку из черновика.
 * @param {object} draft  { id, title, time, duration, days, priority, color, ... }
 * @param {object} [defaults]
 * @returns {object} привычка с гарантированно корректными полями
 */
export function createHabit(draft = {}, defaults = {}) {
  const time = isValidTime(draft.time) ? draft.time : (isValidTime(defaults.time) ? defaults.time : '09:00');
  const duration = clamp(draft.duration ?? defaults.duration ?? 30, 1, 1440);
  const days = normalizeDays(draft.days ?? defaults.days ?? [1, 2, 3, 4, 5, 6, 7]);
  return {
    id: String(draft.id ?? defaults.id ?? ''),
    title: String(draft.title ?? defaults.title ?? 'Новая привычка').trim() || 'Новая привычка',
    time,
    duration,
    days,
    priority: clamp(draft.priority ?? defaults.priority ?? 2, 1, 3),
    color: sanitizeColor(draft.color ?? defaults.color ?? HABIT_COLORS[0]),
    createdAt: draft.createdAt ?? defaults.createdAt ?? null,
    archived: Boolean(draft.archived ?? false),
  };
}

/** Ограничивает число диапазоном [min, max]. */
export function clamp(value, min, max) {
  const number = Number(value);
  if (Number.isNaN(number)) return min;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/** Оставляет только корректные ISO-дни недели, убирает дубли, сортирует. */
export function normalizeDays(days) {
  const list = Array.isArray(days) ? days : [days];
  const unique = [...new Set(list.map(Number).filter((day) => day >= 1 && day <= 7))];
  unique.sort((a, b) => a - b);
  return unique.length ? unique : [1, 2, 3, 4, 5, 6, 7];
}

/** Проверяет цвет вида #rgb/#rrggbb, иначе возвращает запасной. */
export function sanitizeColor(color) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(color)) ? String(color) : HABIT_COLORS[0];
}

/** Попадает ли привычка в указанный календарный день. */
export function isHabitScheduledForDate(habit, dateKey) {
  if (!habit || habit.archived) return false;
  return normalizeDays(habit.days).includes(weekdayFromKey(dateKey));
}

/** Человекочитаемое расписание привычки: 'Пн–Пт', 'Каждый день', 'Сб, Вс'. */
export function formatHabitDays(habit) {
  const days = normalizeDays(habit.days);
  if (days.length === 7) return 'Каждый день';
  if (days.join(',') === '1,2,3,4,5') return 'Пн–Пт';
  if (days.join(',') === '6,7') return 'Сб, Вс';
  return days.map((day) => WEEKDAYS[day - 1].short).join(', ');
}

/** Название приоритета по числу. */
export function priorityLabel(priority) {
  const found = PRIORITIES.find((item) => item.value === Number(priority));
  return found ? found.label : PRIORITIES[1].label;
}

/* ------------------------------------------------------------------ *
 * 4. СОСТОЯНИЕ ПРИЛОЖЕНИЯ
 * ------------------------------------------------------------------ */

/** Пустое состояние (без привычек и отметок). */
export function createEmptyState() {
  return { version: STATE_VERSION, habits: [], logs: {}, settings: defaultSettings() };
}

/**
 * Демонстрационные данные: три привычки и правдоподобная история за 14 дней.
 * @param {string} todayKey 'YYYY-MM-DD' — «сегодня» (передаёт слой UI)
 */
export function createDemoState(todayKey) {
  const anchor = todayKey || '2026-01-01';
  const habits = [
    createHabit({
      id: 'demo-charge', title: 'Зарядка', time: '08:00', duration: 15,
      days: [1, 2, 3, 4, 5, 6, 7], priority: 3, color: '#22c55e',
      createdAt: addDaysToKey(anchor, -30),
    }),
    createHabit({
      id: 'demo-read', title: 'Чтение', time: '13:00', duration: 30,
      days: [1, 2, 3, 4, 5], priority: 2, color: '#38bdf8',
      createdAt: addDaysToKey(anchor, -30),
    }),
    createHabit({
      id: 'demo-self', title: 'Саморазвитие', time: '20:00', duration: 60,
      days: [1, 2, 3, 4, 5, 6, 7], priority: 2, color: '#a78bfa',
      createdAt: addDaysToKey(anchor, -30),
    }),
  ];

  // История: детерминированная «пила» вместо случайности, чтобы демо
  // выглядело реалистично и при этом повторялось от запуска к запуску.
  const logs = {};
  for (let offset = 1; offset <= 14; offset += 1) {
    const key = addDaysToKey(anchor, -offset);
    const day = {};
    habits.forEach((habit, index) => {
      if (!isHabitScheduledForDate(habit, key)) return;
      const pattern = (offset * 3 + index * 5) % 10;
      if (pattern < 7) day[habit.id] = { status: STATUS.DONE, at: null };
      else if (pattern === 7) day[habit.id] = { status: STATUS.SKIPPED, at: null };
      // pattern 8 и 9 — отметки нет (человек забыл).
    });
    if (Object.keys(day).length) logs[key] = day;
  }

  return { version: STATE_VERSION, habits, logs, settings: defaultSettings() };
}

/** Ищет привычку по идентификатору. */
export function findHabit(state, habitId) {
  return state.habits.find((habit) => habit.id === habitId) || null;
}

/** Отметка привычки за день или null. */
export function getLog(state, dateKey, habitId) {
  const day = state.logs[dateKey];
  return day && day[habitId] ? day[habitId] : null;
}

/** Статус привычки за день (STATUS.PENDING, если отметки нет). */
export function getStatus(state, dateKey, habitId) {
  const log = getLog(state, dateKey, habitId);
  return log ? log.status : STATUS.PENDING;
}

/**
 * Ставит отметку. Возвращает НОВОЕ состояние (исходное не меняется).
 * @param {object} state
 * @param {string} dateKey
 * @param {string} habitId
 * @param {string} status один из STATUS.*
 * @param {object} [extra] { at } — момент отметки; передаёт UI, потому что
 *   внутри core часов нет.
 */
export function markHabit(state, dateKey, habitId, status, extra = {}) {
  const day = { ...(state.logs[dateKey] || {}) };
  day[habitId] = { status, at: extra.at ?? null };
  return { ...state, logs: { ...state.logs, [dateKey]: day } };
}

/** Снимает отметку привычки за день. */
export function clearHabitLog(state, dateKey, habitId) {
  const day = { ...(state.logs[dateKey] || {}) };
  delete day[habitId];
  const logs = { ...state.logs };
  if (Object.keys(day).length) logs[dateKey] = day;
  else delete logs[dateKey];
  return { ...state, logs };
}

/** Повторный клик по тому же статусу снимает отметку — привычный переключатель. */
export function toggleHabitStatus(state, dateKey, habitId, status, extra = {}) {
  return getStatus(state, dateKey, habitId) === status
    ? clearHabitLog(state, dateKey, habitId)
    : markHabit(state, dateKey, habitId, status, extra);
}

/** Убирает пустые дни из logs (гигиена данных перед сохранением). */
export function pruneLogs(logs) {
  const result = {};
  Object.keys(logs).forEach((key) => {
    if (logs[key] && Object.keys(logs[key]).length) result[key] = logs[key];
  });
  return result;
}

/* ------------------------------------------------------------------ *
 * 5. РАСПИСАНИЕ ДНЯ (ТАЙМЛАЙН)
 * ------------------------------------------------------------------ */

/**
 * Окно привычки в минутах. endMinutes может быть > 1440 (переход через полночь).
 */
export function getHabitWindow(habit) {
  const start = parseTimeToMinutes(habit.time);
  return { start, end: start + habit.duration };
}

/** Активна ли привычка в указанную минуту суток (с учётом перехода через полночь). */
export function isHabitActiveAt(habit, nowMinutes) {
  const { start, end } = getHabitWindow(habit);
  const minute = normalizeMinutes(nowMinutes);
  if (end <= MINUTES_PER_DAY) return minute >= start && minute < end;
  // Окно разорвано полуночью: активно вечером ИЛИ ранним утром.
  return minute >= start || minute < end - MINUTES_PER_DAY;
}

/**
 * Строит таймлайн привычек на дату.
 * @param {object} state
 * @param {string} dateKey
 * @param {number|null} nowMinutes «сейчас» в минутах (null — день без отметки «сейчас»)
 * @returns {Array<object>} элементы, отсортированные по времени начала
 */
export function getScheduleForDate(state, dateKey, nowMinutes = null) {
  return state.habits
    .filter((habit) => isHabitScheduledForDate(habit, dateKey))
    .map((habit) => {
      const { start, end } = getHabitWindow(habit);
      const log = getLog(state, dateKey, habit.id);
      return {
        habitId: habit.id,
        title: habit.title,
        color: habit.color,
        priority: habit.priority,
        duration: habit.duration,
        startMinutes: start,
        endMinutes: end,
        startTime: minutesToTime(start),
        endTime: minutesToTime(end),
        crossesMidnight: end > MINUTES_PER_DAY,
        status: log ? log.status : STATUS.PENDING,
        log,
        isActive: nowMinutes === null ? false : isHabitActiveAt(habit, nowMinutes),
        isPast: nowMinutes === null ? false : end <= nowMinutes,
      };
    })
    .sort((a, b) => (
      a.startMinutes - b.startMinutes
      || b.priority - a.priority
      || a.title.localeCompare(b.title, 'ru')
    ));
}

/* ------------------------------------------------------------------ *
 * 6. СТАТИСТИКА: ДЕНЬ, ДИАПАЗОН, КПД
 * ------------------------------------------------------------------ */

/**
 * Статистика за один день.
 * КПД = выполненные минуты / запланированные минуты * 100%.
 */
export function getDayStats(state, dateKey) {
  const entries = getScheduleForDate(state, dateKey, null);
  const result = {
    dateKey,
    planned: entries.length,
    plannedMinutes: 0,
    done: 0,
    doneMinutes: 0,
    skipped: 0,
    skippedMinutes: 0,
    moved: 0,
    movedMinutes: 0,
    pending: 0,
    pendingMinutes: 0,
    kpi: 0,
    completion: 0,
  };

  entries.forEach((entry) => {
    result.plannedMinutes += entry.duration;
    if (entry.status === STATUS.DONE) {
      result.done += 1;
      result.doneMinutes += entry.duration;
    } else if (entry.status === STATUS.SKIPPED) {
      result.skipped += 1;
      result.skippedMinutes += entry.duration;
    } else if (entry.status === STATUS.MOVED) {
      result.moved += 1;
      result.movedMinutes += entry.duration;
    } else {
      result.pending += 1;
      result.pendingMinutes += entry.duration;
    }
  });

  result.kpi = result.plannedMinutes > 0
    ? Math.round((result.doneMinutes / result.plannedMinutes) * 100)
    : 0; // нулевой план — КПД 0, а не NaN
  result.completion = result.planned > 0
    ? Math.round((result.done / result.planned) * 100)
    : 0;
  return result;
}

/**
 * Статистика за диапазон дат (включительно).
 * @param {number} [maxDays] страховка от бесконечного цикла
 */
export function getRangeStats(state, fromKey, toKey, maxDays = 1000) {
  const result = {
    fromKey,
    toKey,
    days: 0,
    planned: 0,
    plannedMinutes: 0,
    done: 0,
    doneMinutes: 0,
    skipped: 0,
    moved: 0,
    pending: 0,
    kpi: 0,
    completion: 0,
    perDay: [],
  };
  if (compareKeys(fromKey, toKey) > 0) return result;

  let cursor = fromKey;
  let guard = 0;
  while (compareKeys(cursor, toKey) <= 0 && guard < maxDays) {
    const day = getDayStats(state, cursor);
    result.days += 1;
    result.planned += day.planned;
    result.plannedMinutes += day.plannedMinutes;
    result.done += day.done;
    result.doneMinutes += day.doneMinutes;
    result.skipped += day.skipped;
    result.moved += day.moved;
    result.pending += day.pending;
    result.perDay.push(day);
    cursor = addDaysToKey(cursor, 1);
    guard += 1;
  }

  result.kpi = result.plannedMinutes > 0
    ? Math.round((result.doneMinutes / result.plannedMinutes) * 100)
    : 0;
  result.completion = result.planned > 0
    ? Math.round((result.done / result.planned) * 100)
    : 0;
  return result;
}

/** КПД за диапазон в процентах (обёртка над getRangeStats). */
export function getEfficiency(state, fromKey, toKey) {
  return getRangeStats(state, fromKey, toKey).kpi;
}

/** Период «неделя» для даты (понедельник–воскресенье). */
export function getWeekRange(dateKey) {
  return { from: startOfWeekKey(dateKey), to: endOfWeekKey(dateKey) };
}

/** Период «месяц» для даты. */
export function getMonthRange(dateKey) {
  return { from: startOfMonthKey(dateKey), to: endOfMonthKey(dateKey) };
}

/** Обрезает конец периода сегодняшним днём: будущее не портит КПД. */
export function clampRangeToToday(fromKey, toKey, todayKey) {
  return {
    from: fromKey,
    to: compareKeys(toKey, todayKey) > 0 ? todayKey : toKey,
  };
}

/** Статистика за последние N дней (включая todayKey) — для графика. */
export function getLastDaysStats(state, todayKey, days = 7) {
  const list = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const key = addDaysToKey(todayKey, -offset);
    const stats = getDayStats(state, key);
    list.push({
      ...stats,
      weekdayShort: WEEKDAYS[weekdayFromKey(key) - 1].short,
      isToday: key === todayKey,
    });
  }
  return list;
}

/**
 * Серия привычки: сколько расписанных дней подряд выполнено.
 * Дни вне расписания (например, выходные у привычки «Пн–Пт») серию не рвут.
 * Незакрытый «сегодняшний» день тоже не рвёт серию — его ещё можно выполнить.
 * @returns {number}
 */
export function getHabitStreak(state, habitId, todayKey, maxDays = 730) {
  const habit = findHabit(state, habitId);
  if (!habit) return 0;

  let streak = 0;
  let cursor = todayKey;
  for (let step = 0; step < maxDays; step += 1) {
    if (!isHabitScheduledForDate(habit, cursor)) {
      cursor = addDaysToKey(cursor, -1);
      continue;
    }
    const status = getStatus(state, cursor, habitId);
    if (status === STATUS.DONE) {
      streak += 1;
    } else if (status === STATUS.PENDING && cursor === todayKey) {
      // Сегодня ещё не отмечено — считаем, что день в работе.
    } else {
      break;
    }
    cursor = addDaysToKey(cursor, -1);
  }
  return streak;
}

/**
 * Лучшая серия привычки за всю историю (от даты создания до todayKey).
 */
export function getBestStreak(state, habitId, todayKey, maxDays = 2000) {
  const habit = findHabit(state, habitId);
  if (!habit) return 0;

  let cursor = habit.createdAt && compareKeys(habit.createdAt, todayKey) <= 0
    ? habit.createdAt
    : todayKey;
  let best = 0;
  let current = 0;
  for (let step = 0; step < maxDays; step += 1) {
    if (compareKeys(cursor, todayKey) > 0) break;
    if (isHabitScheduledForDate(habit, cursor)) {
      const status = getStatus(state, cursor, habitId);
      if (status === STATUS.DONE) {
        current += 1;
        best = Math.max(best, current);
      } else if (status === STATUS.PENDING && cursor === todayKey) {
        // Сегодняшний открытый день серию не рвёт.
      } else {
        current = 0;
      }
    }
    cursor = addDaysToKey(cursor, 1);
  }
  return best;
}

/** Полная карточка статистики по привычке за период. */
export function getHabitStats(state, habitId, fromKey, toKey, todayKey) {
  const habit = findHabit(state, habitId);
  if (!habit) return null;

  let planned = 0;
  let done = 0;
  let plannedMinutes = 0;
  let doneMinutes = 0;

  let cursor = fromKey;
  let guard = 0;
  while (compareKeys(cursor, toKey) <= 0 && guard < 1000) {
    if (isHabitScheduledForDate(habit, cursor)) {
      planned += 1;
      plannedMinutes += habit.duration;
      if (getStatus(state, cursor, habitId) === STATUS.DONE) {
        done += 1;
        doneMinutes += habit.duration;
      }
    }
    cursor = addDaysToKey(cursor, 1);
    guard += 1;
  }

  return {
    habitId,
    title: habit.title,
    color: habit.color,
    planned,
    done,
    plannedMinutes,
    doneMinutes,
    completion: planned > 0 ? Math.round((done / planned) * 100) : 0,
    kpi: plannedMinutes > 0 ? Math.round((doneMinutes / plannedMinutes) * 100) : 0,
    streak: getHabitStreak(state, habitId, todayKey),
    bestStreak: getBestStreak(state, habitId, todayKey),
  };
}

/* ------------------------------------------------------------------ *
 * 7. НАПОМИНАНИЯ (расчёт — здесь, показ — в notifier.js)
 * ------------------------------------------------------------------ */

/** Попадает ли время в тихие часы (интервал может пересекать полночь). */
export function isQuietTime(minutes, quietFrom, quietTo) {
  const from = parseTimeToMinutes(quietFrom);
  const to = parseTimeToMinutes(quietTo);
  if (Number.isNaN(from) || Number.isNaN(to) || from === to) return false;
  const minute = normalizeMinutes(minutes);
  if (from < to) return minute >= from && minute < to;
  return minute >= from || minute < to; // например 22:30 -> 07:30
}

/**
 * Пора ли напомнить о привычке.
 * @returns {{ remind: boolean, reason: string, at: number, atTime: string }}
 *   reason: 'not-scheduled' | 'already-logged' | 'quiet-hours' | 'too-early' | 'too-late' | 'due'
 */
export function shouldRemind(habit, dateKey, nowMinutes, state) {
  const lead = clamp(state.settings.reminderLeadMinutes ?? 0, 0, 240);
  const start = parseTimeToMinutes(habit.time);
  const at = start - lead;
  const base = { at, atTime: minutesToTime(at) };

  if (!isHabitScheduledForDate(habit, dateKey)) return { remind: false, reason: 'not-scheduled', ...base };
  if (getStatus(state, dateKey, habit.id) !== STATUS.PENDING) return { remind: false, reason: 'already-logged', ...base };
  if (isQuietTime(at, state.settings.quietFrom, state.settings.quietTo)) return { remind: false, reason: 'quiet-hours', ...base };
  if (nowMinutes < at) return { remind: false, reason: 'too-early', ...base };
  if (nowMinutes > start + habit.duration) return { remind: false, reason: 'too-late', ...base };
  return { remind: true, reason: 'due', ...base };
}

/**
 * Список напоминаний на дату: кому и когда напомнить.
 * UI планирует их в notifier и отсеивает уже сработавшие по полю key.
 * @returns {Array<{key:string, habitId:string, at:Date, atMinutes:number, atTime:string, title:string, body:string, reason:string}>}
 */
export function collectReminders(state, dateKey) {
  const lead = clamp(state.settings.reminderLeadMinutes ?? 0, 0, 240);
  const result = [];

  state.habits.forEach((habit) => {
    if (!isHabitScheduledForDate(habit, dateKey)) return;
    if (getStatus(state, dateKey, habit.id) !== STATUS.PENDING) return;

    const startMinutes = parseTimeToMinutes(habit.time);
    const atMinutes = startMinutes - lead;
    // Напоминание, попадающее в тихие часы, не планируем вообще.
    if (isQuietTime(atMinutes, state.settings.quietFrom, state.settings.quietTo)) return;

    result.push({
      key: `${dateKey}|${habit.id}|${atMinutes}`,
      habitId: habit.id,
      at: dateFromKeyAndMinutes(dateKey, atMinutes),
      atMinutes,
      atTime: minutesToTime(atMinutes),
      title: lead > 0 ? `Через ${lead} мин: ${habit.title}` : `Пора: ${habit.title}`,
      body: `${minutesToTime(startMinutes)} · ${formatDuration(habit.duration)}`,
    });
  });

  return result.sort((a, b) => a.atMinutes - b.atMinutes);
}

/* ------------------------------------------------------------------ *
 * 8. СЕРИАЛИЗАЦИЯ И ВАЛИДАЦИЯ
 * ------------------------------------------------------------------ */

/** Состояние -> строка JSON (для storage и для экспорта файла). */
export function serialize(state, pretty = true) {
  const clean = {
    version: STATE_VERSION,
    habits: state.habits,
    logs: pruneLogs(state.logs || {}),
    settings: { ...defaultSettings(), ...state.settings },
  };
  return JSON.stringify(clean, null, pretty ? 2 : 0);
}

/**
 * Принимает строку JSON или уже разобранный объект и возвращает корректное
 * состояние. Всё, что не проходит проверку, отбрасывается, а не ломает приложение.
 */
export function deserialize(source) {
  const raw = typeof source === 'string' ? JSON.parse(source) : source;
  if (!raw || typeof raw !== 'object') throw new Error('Некорректный формат данных');

  const habits = Array.isArray(raw.habits)
    ? raw.habits
      .filter((habit) => habit && typeof habit === 'object' && habit.id)
      .map((habit) => createHabit(habit))
    : [];

  const logs = {};
  if (raw.logs && typeof raw.logs === 'object') {
    Object.keys(raw.logs).forEach((dateKey) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return;
      const day = raw.logs[dateKey];
      if (!day || typeof day !== 'object') return;
      const entries = {};
      Object.keys(day).forEach((habitId) => {
        const log = day[habitId];
        if (!log || !Object.values(STATUS).includes(log.status)) return;
        entries[habitId] = { status: log.status, at: log.at ?? null };
      });
      if (Object.keys(entries).length) logs[dateKey] = entries;
    });
  }

  return {
    version: STATE_VERSION,
    habits,
    logs,
    settings: normalizeSettings(raw.settings),
  };
}

/** Дополняет и проверяет настройки. */
export function normalizeSettings(settings) {
  const base = defaultSettings();
  const source = settings && typeof settings === 'object' ? settings : {};
  return {
    reminderLeadMinutes: clamp(source.reminderLeadMinutes ?? base.reminderLeadMinutes, 0, 240),
    quietFrom: isValidTime(source.quietFrom) ? source.quietFrom : base.quietFrom,
    quietTo: isValidTime(source.quietTo) ? source.quietTo : base.quietTo,
    theme: ['auto', 'light', 'dark'].includes(source.theme) ? source.theme : base.theme,
    notificationsEnabled: Boolean(source.notificationsEnabled),
  };
}

/** Краткая сводка по привычке для списка привычек. */
export function getHabitSummary(state, habit, todayKey) {
  const range = getHabitStats(state, habit.id, habit.createdAt || todayKey, todayKey, todayKey);
  return {
    streak: range ? range.streak : 0,
    bestStreak: range ? range.bestStreak : 0,
    completion: range ? range.completion : 0,
  };
}
