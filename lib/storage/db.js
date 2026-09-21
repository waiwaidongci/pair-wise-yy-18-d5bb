'use strict';

// 存储层（共享底座）：封装 SQLite(sql.js / WASM) 与落盘。
// 仅负责读写，不承载任何业务判定。
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const config = require('../../project.config');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

let db = null;

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const bytes = Buffer.from(db.export());
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, DB_FILE);
}

function execRaw(sql) {
  db.run(sql);
}

function select(sql) {
  const stmt = db.prepare(sql);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function selectOne(sql) {
  return select(sql)[0] || null;
}

// 事务内执行一批语句；任一条抛错则整批回滚（整单不写入）。
// 成功后一次性落盘，保证列表 / 履历 / 刷新后看到的状态一致。
function transaction(statements) {
  db.run('BEGIN IMMEDIATE;');
  try {
    for (const sql of statements) {
      if (sql) db.run(sql);
    }
    db.run('COMMIT;');
  } catch (error) {
    db.run('ROLLBACK;');
    throw error;
  }
  persist();
}

function mutate(statements) {
  return transaction(statements);
}

function now() {
  return new Date().toISOString();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);
-- 封签号只在“未结束装箱单”（草稿/已装箱/巡演中/待复核/已解封）中唯一；
-- 已闭环的单子不再占号。
CREATE TABLE IF NOT EXISTS active_seals (
  seal_no TEXT PRIMARY KEY,
  tour_box_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return initSqlJs().then((SQL) => {
    if (fs.existsSync(DB_FILE)) {
      db = new SQL.Database(fs.readFileSync(DB_FILE));
    } else {
      db = new SQL.Database();
    }
    db.run(SCHEMA);

    // 历史数据补齐占号：从已存在的未结束装箱单恢复封签占号。
    const sealRows = select(
      "SELECT id, data FROM records WHERE collection = 'tourBoxes' AND status != '已闭环' AND data IS NOT NULL;"
    );
    for (const row of sealRows) {
      const data = JSON.parse(row.data || '{}');
      if (data.sealNo) {
        db.run(
          'INSERT OR IGNORE INTO active_seals (seal_no, tour_box_id, created_at) VALUES (' +
          [sqlValue(data.sealNo), sqlValue(row.id), sqlValue(now())].join(', ') + ');'
        );
      }
    }

    const count = selectOne('SELECT COUNT(*) AS count FROM records;').count;
    if (count === 0) seedData();
    persist();
  });
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function seedData() {
  const { randomUUID } = require('crypto');
  const stmts = [];
  for (const seed of config.seed || []) {
    const collectionConfig = config.collections[seed.collection];
    const id = seed.id || randomUUID();
    const createdAt = seed.createdAt || now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    stmts.push(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
      [
        sqlValue(id),
        sqlValue(seed.collection),
        sqlValue(status),
        sqlValue(titleFor(collectionConfig, data)),
        sqlValue(JSON.stringify(data)),
        sqlValue(createdAt),
        sqlValue(seed.updatedAt || createdAt)
      ].join(', ') + ');'
    );
    stmts.push(
      'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
      [
        sqlValue(randomUUID()),
        sqlValue(id),
        sqlValue(seed.collection),
        sqlValue(seed.eventAction || '创建'),
        sqlValue(status),
        sqlValue(seed.actor || 'system'),
        sqlValue(seed.note || ''),
        sqlValue(JSON.stringify(data)),
        sqlValue(createdAt)
      ].join(', ') + ');'
    );
  }
  transaction(stmts);
}

module.exports = {
  sqlValue,
  select,
  selectOne,
  mutate,
  execRaw,
  now,
  initDb,
  titleFor
};
