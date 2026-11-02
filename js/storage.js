/**
 * storage.js — СЛОЙ ХРАНЕНИЯ.
 *
 * Публичный интерфейс (единственное, что видит ui.js):
 *   storage.load()   -> объект состояния | null
 *   storage.save(obj)-> boolean (успех)
 *   storage.clear()  -> boolean
 *
 * Плюс служебные методы: storage.key(), storage.isAvailable(), storage.raw().
 *
 * Слой ничего не знает про core.js и notifier.js: он умеет только
 * «положить/достать JSON по ключу». Валидацией занимается core.deserialize().
 *
 * ─────────────────────────────────────────────────────────────────────
 * ПЕРЕНОС НА ТЕЛЕФОН (Android / iOS / React Native / Capacitor):
 *
 *   Меняется ТОЛЬКО этот файл. ui.js, core.js, notifier.js — без правок.
 *   Нужно сохранить те же три метода и ту же сигнатуру (объект in/out).
 *
 *   Пример замены на SQLite (Capacitor + @capacitor-community/sqlite):
 *
 *     import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
 *     const sqlite = new SQLiteConnection(CapacitorSQLite);
 *     let db;
 *
 *     async function open() {
 *       if (db) return db;
 *       const conn = await sqlite.createConnection('kpd', false, 'no-encryption', 1, false);
 *       await conn.open();
 *       await conn.execute(`
 *         CREATE TABLE IF NOT EXISTS habits (
 *           id TEXT PRIMARY KEY, title TEXT, time TEXT, duration INTEGER,
 *           days TEXT, priority INTEGER, color TEXT, created_at TEXT,
 *           note TEXT, archived INTEGER);
 *         CREATE TABLE IF NOT EXISTS logs (
 *           date_key TEXT NOT NULL, habit_id TEXT NOT NULL,
 *           status TEXT NOT NULL, at TEXT, note TEXT, moved_to TEXT,
 *           PRIMARY KEY (date_key, habit_id));
 *         CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
 *       `);
 *       db = conn;
 *       return db;
 *     }
 *
 *     export const storage = {
 *       async load()  { ... SELECT ... -> собрать тот же объект state ... },
 *       async save(s) { ... DELETE/INSERT или REPLACE ... },
 *       async clear() { ... DELETE FROM ... },
 *     };
 *
 *   Важное отличие: методы становятся async. Поэтому в ui.js все обращения
 *   к storage уже обёрнуты в await-friendly вид (см. комментарий в ui.js
 *   у функции persist()), и при переносе достаточно добавить await.
 * ─────────────────────────────────────────────────────────────────────
 */

/** Ключ, под которым состояние лежит в localStorage. */
const STORAGE_KEY = 'kpd-tracker:state:v1';

/**
 * Проверяет, доступен ли localStorage.
 * В приватном режиме Safari обращение к нему может бросать исключение.
 */
function hasLocalStorage() {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch (error) {
    return false;
  }
}

export const storage = {
  /** Имя ключа хранения (нужно тестам и отладке). */
  key() {
    return STORAGE_KEY;
  },

  /** Доступно ли постоянное хранилище. */
  isAvailable() {
    if (!hasLocalStorage()) return false;
    try {
      const probe = '__kpd_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch (error) {
      return false;
    }
  },

  /**
   * Читает состояние.
   * @returns {object|null} разобранный объект или null, если данных нет/они битые
   */
  load() {
    if (!hasLocalStorage()) return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (error) {
      console.warn('[storage] Не удалось прочитать состояние:', error);
      return null;
    }
  },

  /** Сырая строка (для резервного копирования вручную). */
  raw() {
    if (!hasLocalStorage()) return null;
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return null;
    }
  },

  /**
   * Записывает состояние.
   * @param {object} state
   * @returns {boolean} удалось ли сохранить
   */
  save(state) {
    if (!hasLocalStorage()) return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (error) {
      // Частая причина — переполнение квоты (QuotaExceededError).
      console.warn('[storage] Не удалось сохранить состояние:', error);
      return false;
    }
  },

  /**
   * Полностью очищает хранилище приложения.
   * @returns {boolean}
   */
  clear() {
    if (!hasLocalStorage()) return false;
    try {
      localStorage.removeItem(STORAGE_KEY);
      return true;
    } catch (error) {
      console.warn('[storage] Не удалось очистить хранилище:', error);
      return false;
    }
  },
};

export default storage;
