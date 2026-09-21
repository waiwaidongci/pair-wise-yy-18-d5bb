'use strict';

// 存储层（在库档案）：偶头 / 配件档案的查询与状态更新原语。
const { randomUUID } = require('crypto');
const { sqlValue, select, selectOne, now } = require('./db');

const ITEM_COLLECTIONS = {
  head: 'puppetHeads',
  accessory: 'accessories'
};

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

function loadRecord(collection, id) {
  const row = selectOne(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ' LIMIT 1;'
  );
  return row ? toRecord(row) : null;
}

function listByIds(collection, ids) {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  return select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) +
    ' AND id IN (' + unique.map(sqlValue).join(', ') + ');'
  ).map(toRecord);
}

// 返回一批“某档案占用某箱”的记录，供装箱核对复用状态。
function findOccupancy(collection, ids, excludeBoxId) {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  return select(
    'SELECT id, status, title, data FROM records WHERE collection = ' + sqlValue(collection) +
    ' AND id IN (' + unique.map(sqlValue).join(', ') + ');'
  ).map(toRecord).filter((item) => {
    const data = item;
    return data.tourBoxId && data.tourBoxId !== excludeBoxId;
  });
}

function updateItemStatusStmt({ collection, id, status, extra }) {
  const current = selectOne(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ';'
  );
  if (!current) return null;
  const data = { ...JSON.parse(current.data || '{}'), ...(extra || {}), status };
  return (
    'UPDATE records SET status = ' + sqlValue(status) +
    ', data = ' + sqlValue(JSON.stringify(data)) +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE id = ' + sqlValue(id) + ';'
  );
}

function insertInventoryEventStmt({ recordId, collection, action, status, actor, note, data }) {
  return (
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
    [
      sqlValue(randomUUID()),
      sqlValue(recordId),
      sqlValue(collection),
      sqlValue(action),
      sqlValue(status || ''),
      sqlValue(actor || ''),
      sqlValue(note || ''),
      sqlValue(JSON.stringify(data || {})),
      sqlValue(now())
    ].join(', ') + ');'
  );
}

module.exports = {
  ITEM_COLLECTIONS,
  toRecord,
  loadRecord,
  listByIds,
  findOccupancy,
  updateItemStatusStmt,
  insertInventoryEventStmt
};
