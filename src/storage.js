import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';

const DB_FILE = process.env.DB_FILE || path.resolve('data/state.db');
const OLD_DATA_FILE = process.env.DATA_FILE || path.resolve('data/state.json');

// Ensure data directory exists
const dir = path.dirname(DB_FILE);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DB_FILE);

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT
  );

  CREATE TABLE IF NOT EXISTS verifications (
    date TEXT,
    user_id TEXT,
    PRIMARY KEY (date, user_id)
  );

  CREATE TABLE IF NOT EXISTS fines (
    user_id TEXT PRIMARY KEY,
    total INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS fine_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    date TEXT,
    amount INTEGER
  );

  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migration logic
async function migrateIfNeeded() {
  const migratedKey = 'migrated_from_json';
  const check = db.prepare('SELECT value FROM metadata WHERE key = ?').get(migratedKey);
  
  if (check) return;

  if (fs.existsSync(OLD_DATA_FILE)) {
    console.log('[Storage] Migrating data from JSON to SQLite...');
    try {
      const raw = fs.readFileSync(OLD_DATA_FILE, 'utf8');
      const data = JSON.parse(raw);

      db.transaction(() => {
        // Migrate verifications
        if (data.verifications) {
          const stmt = db.prepare('INSERT OR IGNORE INTO verifications (date, user_id) VALUES (?, ?)');
          for (const [date, userIds] of Object.entries(data.verifications)) {
            for (const uid of userIds) {
              stmt.run(date, uid);
            }
          }
        }

        // Migrate fines
        if (data.fines) {
          const fineStmt = db.prepare('INSERT OR REPLACE INTO fines (user_id, total) VALUES (?, ?)');
          const historyStmt = db.prepare('INSERT INTO fine_history (user_id, date, amount) VALUES (?, ?, ?)');
          for (const [uid, v] of Object.entries(data.fines)) {
            fineStmt.run(uid, v.total || 0);
            if (v.history) {
              for (const entry of v.history) {
                historyStmt.run(uid, entry.date, entry.amount);
              }
            }
          }
        }

        // Migrate metadata
        if (data.lastProcessedDate) {
          db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('lastProcessedDate', data.lastProcessedDate);
        }

        db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run(migratedKey, 'true');
      })();
      console.log('[Storage] Migration completed.');
    } catch (e) {
      console.error('[Storage] Migration failed:', e);
    }
  }
}

// Run migration
await migrateIfNeeded();

export const Storage = {
  async updateUser(userId, username) {
    db.prepare('INSERT INTO users (id, username) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET username = EXCLUDED.username')
      .run(userId, username);
  },

  async markVerified(dateStr, userId) {
    db.prepare('INSERT OR IGNORE INTO verifications (date, user_id) VALUES (?, ?)')
      .run(dateStr, userId);
  },

  async hasVerified(dateStr, userId) {
    const row = db.prepare('SELECT 1 FROM verifications WHERE date = ? AND user_id = ?').get(dateStr, userId);
    return !!row;
  },

  async getVerified(dateStr) {
    const rows = db.prepare('SELECT user_id FROM verifications WHERE date = ?').all(dateStr);
    return rows.map(r => r.user_id);
  },

  async addFine(userId, amount, dateStr) {
    db.transaction(() => {
      // Update total
      db.prepare('INSERT INTO fines (user_id, total) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET total = total + EXCLUDED.total')
        .run(userId, amount);
      
      // Add history
      db.prepare('INSERT INTO fine_history (user_id, date, amount) VALUES (?, ?, ?)')
        .run(userId, dateStr, amount);
    })();
  },

  async getFine(userId) {
    const total = db.prepare('SELECT total FROM fines WHERE user_id = ?').get(userId);
    const history = db.prepare('SELECT date, amount FROM fine_history WHERE user_id = ? ORDER BY id DESC').all(userId);
    return {
      total: total ? total.total : 0,
      history: history || []
    };
  },

  async getRanking(limit = 10) {
    // Join with users table to get usernames if available
    // SQLite LIMIT -1 returns all rows.
    const rows = db.prepare(`
      SELECT f.user_id, f.total, u.username
      FROM fines f
      LEFT JOIN users u ON f.user_id = u.id
      ORDER BY f.total DESC
      LIMIT ?
    `).all(limit);

    return rows.map(r => ({
      userId: r.user_id,
      total: r.total,
      username: r.username
    }));
  },

  async getLastProcessedDate() {
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get('lastProcessedDate');
    return row ? row.value : null;
  },

  async setLastProcessedDate(dateStr) {
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('lastProcessedDate', dateStr);
  }
};
