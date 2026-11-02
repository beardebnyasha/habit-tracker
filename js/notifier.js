/**
 * notifier.js — СЛОЙ НАПОМИНАНИЙ.
 *
 * Публичный интерфейс (единственное, что видит ui.js):
 *   await notifier.requestPermission() -> 'granted' | 'denied' | 'default' | 'unsupported'
 *   notifier.schedule({ id, at, title, body }) -> id | null   (at — объект Date)
 *   notifier.cancel(id) -> boolean
 *   notifier.cancelAll()
 *   notifier.getPermission() -> строка
 *   notifier.onFire(callback) -> unsubscribe
 *
 * Реализация браузерная: Notification API + setTimeout.
 * Ничего из core.js здесь не используется — расчёт времени делает core,
 * а этот слой только показывает уведомление в нужный момент.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ПЕРЕНОС НА ANDROID:
 *
 *   Этот файл заменяется целиком на обёртку над AlarmManager
 *   (+ NotificationManagerCompat / NotificationChannel). Сигнатура та же:
 *   schedule({ id, at, title, body }) / cancel(id) / cancelAll().
 *   В Kotlin это выглядит так:
 *
 *     AlarmManagerCompat.setExactAndAllowWhileIdle(
 *       alarmManager, AlarmManager.RTC_WAKEUP,
 *       at.timeInMillis,
 *       PendingIntent.getBroadcast(context, id.hashCode(), intent, FLAG_IMMUTABLE)
 *     );
 *
 *   Дополнительно понадобится разрешение SCHEDULE_EXACT_ALARM и
 *   «неоптимизируемая» батарея — но это уже платформенные детали.
 *   Остальные файлы (core.js, storage.js, ui.js) НЕ ТРОГАЮТСЯ.
 * ─────────────────────────────────────────────────────────────────────
 */

/** Максимальная задержка setTimeout (~24.8 суток); больше — планируем заново позже. */
const MAX_TIMEOUT_MS = 2147483647;

/** Идентификатор иконки уведомления (относительный путь работает и на GitHub Pages). */
const ICON_PATH = 'icons/icon-192.png';

export const notifier = {
  /** id -> { timeoutId, payload } активных таймеров. */
  timers: new Map(),

  /** Подписчики на событие «напоминание сработало» (для всплывашки внутри приложения). */
  listeners: new Set(),

  /** Поддерживает ли браузер системные уведомления. */
  isSupported() {
    return typeof window !== 'undefined' && 'Notification' in window;
  },

  /** Текущий статус разрешения: 'granted' | 'denied' | 'default' | 'unsupported'. */
  getPermission() {
    if (!this.isSupported()) return 'unsupported';
    return Notification.permission;
  },

  /**
   * Запрашивает у пользователя разрешение на уведомления.
   * @returns {Promise<string>} итоговый статус разрешения
   */
  async requestPermission() {
    if (!this.isSupported()) return 'unsupported';
    if (Notification.permission === 'granted' || Notification.permission === 'denied') {
      return Notification.permission;
    }
    try {
      return await Notification.requestPermission();
    } catch (error) {
      console.warn('[notifier] Ошибка запроса разрешения:', error);
      return 'denied';
    }
  },

  /**
   * Подписка на срабатывание напоминания (нужна, чтобы показать его
   * внутри приложения даже без разрешения на системные уведомления).
   * @param {(payload: object) => void} callback
   * @returns {() => void} функция отписки
   */
  onFire(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  },

  /**
   * Планирует напоминание.
   * @param {{ id: string, at: Date, title: string, body?: string }} options
   * @returns {string|null} id запланированного напоминания (null, если момент уже прошёл)
   */
  schedule(options) {
    const { id, at, title, body = '' } = options || {};
    if (!id || !(at instanceof Date) || Number.isNaN(at.getTime())) return null;

    this.cancel(id); // повторное планирование заменяет старое

    const delay = at.getTime() - Date.now();
    if (delay <= 0) return null;

    // Очень далёкое будущее одним таймером не удержать — обрежем и перепланируем.
    const timeout = Math.min(delay, MAX_TIMEOUT_MS);
    const payload = { id, at, title, body };

    const timeoutId = setTimeout(() => {
      this.timers.delete(id);
      if (timeout < delay) {
        this.schedule(payload); // «перезаводим» длинный таймер
        return;
      }
      this.fire(payload);
    }, timeout);

    this.timers.set(id, { timeoutId, payload });
    return id;
  },

  /** Отменяет ранее запланированное напоминание. */
  cancel(id) {
    const entry = this.timers.get(id);
    if (!entry) return false;
    clearTimeout(entry.timeoutId);
    this.timers.delete(id);
    return true;
  },

  /** Отменяет все напоминания (например, при смене дня или импорте данных). */
  cancelAll() {
    this.timers.forEach((entry) => clearTimeout(entry.timeoutId));
    this.timers.clear();
  },

  /** Сколько напоминаний сейчас в очереди. */
  pendingCount() {
    return this.timers.size;
  },

  /**
   * Показывает уведомление немедленно и оповещает подписчиков.
   * Используется, когда таймер сработал.
   */
  fire(payload) {
    if (this.isSupported() && Notification.permission === 'granted') {
      try {
        const notification = new Notification(payload.title, {
          body: payload.body,
          icon: ICON_PATH,
          badge: ICON_PATH,
          tag: payload.id, // одинаковый tag не даёт дублировать уведомление
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      } catch (error) {
        console.warn('[notifier] Не удалось показать уведомление:', error);
      }
    }
    this.listeners.forEach((listener) => {
      try {
        listener(payload);
      } catch (error) {
        console.warn('[notifier] Ошибка в подписчике:', error);
      }
    });
  },

  /** Показать тестовое уведомление (кнопка в настройках). */
  async test() {
    const permission = await this.requestPermission();
    if (permission !== 'granted') return permission;
    this.fire({
      id: 'test',
      at: new Date(),
      title: 'Уведомления включены',
      body: 'Так будет выглядеть напоминание о привычке.',
    });
    return permission;
  },
};

export default notifier;
