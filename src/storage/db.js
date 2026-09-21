// 存储模块：只负责 SQLite 的读写与事务，不含任何装箱/解封业务判定。
// 底层沿用 sqlite3 CLI 子进程；多条写操作通过 transact() 合并为单次进程调用，
// 保证 BEGIN IMMEDIATE ... COMMIT 在同一连接内完成，避免“写入一半”。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');
const SHIM_FILE = path.join(__dirname, 'sqlite_shim.py');

function now() {
  return new Date().toISOString();
}

function uuid() {
  return randomUUID();
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function runSql(sql) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    return execFileSync('sqlite3', [DB_FILE], {
      input: sql,
      encoding: 'utf8'
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // 运行环境无 sqlite3 CLI 时，回退到随仓库附带的 Python sqlite3 shim。
    return execFileSync('python3', [SHIM_FILE, DB_FILE], {
      input: sql,
      encoding: 'utf8'
    });
  }
}

function query(sql) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const output = execFileSync('sqlite3', [DB_FILE], {
      input: '.mode json\n' + sql,
      encoding: 'utf8'
    });
    if (!output.trim()) return [];
    return JSON.parse(output);
  } catch (cliError) {
    if (cliError.code !== 'ENOENT') throw cliError;
    const output = execFileSync('python3', [SHIM_FILE, DB_FILE, '--json'], {
      input: sql,
      encoding: 'utf8'
    });
    if (!output.trim()) return [];
    return JSON.parse(output);
  }
}

// 写操作串行队列：子进程调用会让出事件循环，HTTP 请求可并发穿插。
// 所有多表变更经由 transaction() 排队执行，保证“先读后判定后写入”的
// 业务操作不会互相交错；纯读取（query/getRecord/listRecords）不加锁。
let writeChain = Promise.resolve();

function transaction(worker) {
  const run = writeChain.then(() => worker());
  // 不让单个失败打断整条链；消费方仍能拿到各自的 rejection。
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

// 在单条连接、单个事务里顺序执行多条 SQL；任一条失败则整体 ROLLBACK。
// 调用方（判定模块）必须在 worker 内、进入写入前完成全部读取与校验。
function transact(statements) {
  if (!statements.length) return;
  const sql = [
    'BEGIN IMMEDIATE;',
    ...statements,
    'COMMIT;'
  ].join('\n');
  try {
    runSql(sql);
  } catch (error) {
    // 子进程可能已在出错时退出，显式回滚一次，释放可能残留的事务状态。
    try {
      runSql('ROLLBACK;');
    } catch (_) {
      // ignore
    }
    throw error;
  }
}

function initSchema() {
  runSql(`
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
CREATE INDEX IF NOT EXISTS idx_events_collection ON events(collection);
`);
}

function countRecords() {
  return query('SELECT COUNT(*) AS count FROM records;')[0].count;
}

function toRecord(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

function getRecord(collection, id) {
  const rows = query(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) +
    ' AND id = ' + sqlValue(id) + ' LIMIT 1;'
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

function listRecords(collection) {
  return query(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) +
    ' ORDER BY updated_at DESC;'
  ).map(toRecord);
}

function insertRecordStatement({ id, collection, status, title, data, createdAt }) {
  return (
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue(collection),
      sqlValue(status),
      sqlValue(title || ''),
      sqlValue(JSON.stringify(data || {})),
      sqlValue(createdAt),
      sqlValue(createdAt)
    ].join(', ') +
    ');'
  );
}

function updateRecordStatement({ id, collection, status, title, data, updatedAt }) {
  return (
    'UPDATE records SET status = ' + sqlValue(status) +
    ', title = ' + sqlValue(title || '') +
    ', data = ' + sqlValue(JSON.stringify(data || {})) +
    ', updated_at = ' + sqlValue(updatedAt || now()) +
    ' WHERE id = ' + sqlValue(id) +
    ' AND collection = ' + sqlValue(collection) + ';'
  );
}

function insertEventStatement({ recordId, collection, action, status, actor, note, data, createdAt }) {
  return (
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
    [
      sqlValue(uuid()),
      sqlValue(recordId),
      sqlValue(collection),
      sqlValue(action || '记录'),
      sqlValue(status || ''),
      sqlValue(actor || ''),
      sqlValue(note || ''),
      sqlValue(JSON.stringify(data || {})),
      sqlValue(createdAt || now())
    ].join(', ') +
    ');'
  );
}

// 批量原子写：ops = [{ type:'insertRecord'|'updateRecord'|'insertEvent', ... }]
// 对外保留给“无需在锁内先读取判定”的简单写入；判定模块的读-判定-写流程
// 应使用 withLock + buildStatements + transact（在同一个临界区内同步完成）。
async function writeAll(ops) {
  return transaction(() => transact(buildStatements(ops)));
}

function buildStatements(ops) {
  return ops.map((op) => {
    if (op.type === 'insertRecord') return insertRecordStatement(op);
    if (op.type === 'updateRecord') return updateRecordStatement(op);
    if (op.type === 'insertEvent') return insertEventStatement(op);
    throw new Error('unknown write op: ' + op.type);
  });
}

// 需要“在锁内读取并判定再写入”的业务操作，用 withLock 包住整个 worker；
// worker 内部用 transact(buildStatements(ops)) 同步提交，切勿再 await writeAll
// （那会排在写队列自己后面，形成死锁）。
async function withLock(worker) {
  return transaction(worker);
}

function listEvents(recordId) {
  return query(
    'SELECT * FROM events WHERE record_id = ' + sqlValue(recordId) + ' ORDER BY created_at ASC, rowid ASC;'
  ).map((event) => ({
    id: event.id,
    action: event.action,
    status: event.status,
    actor: event.actor,
    note: event.note,
    data: JSON.parse(event.data || '{}'),
    createdAt: event.created_at
  }));
}

module.exports = {
  now,
  uuid,
  sqlValue,
  query,
  transact,
  transaction,
  withLock: transaction,
  initSchema,
  countRecords,
  getRecord,
  listRecords,
  writeAll,
  buildStatements,
  listEvents,
  toRecord
};
