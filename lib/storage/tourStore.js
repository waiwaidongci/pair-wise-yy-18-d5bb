'use strict';

// 存储层（装箱域）：records / events / active_seals 的语句拼装与查询。
// 不知道“对错”，只提供原子写入与读取原语。
const { randomUUID } = require('crypto');
const { sqlValue, select, selectOne, now } = require('./db');

const COLLECTION = 'tourBoxes';

function insertRecordStmt({ id, status, title, data, createdAt }) {
  return (
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue(COLLECTION),
      sqlValue(status),
      sqlValue(title),
      sqlValue(JSON.stringify(data)),
      sqlValue(createdAt),
      sqlValue(createdAt)
    ].join(', ') + ');'
  );
}

function updateRecordStmt({ id, status, title, data }) {
  return (
    'UPDATE records SET status = ' + sqlValue(status) +
    ', title = ' + sqlValue(title) +
    ', data = ' + sqlValue(JSON.stringify(data)) +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE collection = ' + sqlValue(COLLECTION) +
    ' AND id = ' + sqlValue(id) + ';'
  );
}

function insertEventStmt({ recordId, action, status, actor, note, data, createdAt }) {
  return (
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
    [
      sqlValue(randomUUID()),
      sqlValue(recordId),
      sqlValue(COLLECTION),
      sqlValue(action || '记录'),
      sqlValue(status || ''),
      sqlValue(actor || ''),
      sqlValue(note || ''),
      sqlValue(JSON.stringify(data || {})),
      sqlValue(createdAt || now())
    ].join(', ') + ');'
  );
}

function claimSealStmt({ sealNo, tourBoxId, createdAt }) {
  return (
    'INSERT INTO active_seals (seal_no, tour_box_id, created_at) VALUES (' +
    [sqlValue(sealNo), sqlValue(tourBoxId), sqlValue(createdAt || now())].join(', ') + ');'
  );
}

function releaseSealStmt(sealNo) {
  return 'DELETE FROM active_seals WHERE seal_no = ' + sqlValue(sealNo) + ';';
}

function releaseBoxSealsStmt(tourBoxId) {
  return 'DELETE FROM active_seals WHERE tour_box_id = ' + sqlValue(tourBoxId) + ';';
}

function findSealOwner(sealNo) {
  return selectOne(
    'SELECT seal_no, tour_box_id, created_at FROM active_seals WHERE seal_no = ' + sqlValue(sealNo) + ';'
  );
}

function findActiveSealByBox(tourBoxId) {
  return selectOne(
    'SELECT seal_no, tour_box_id, created_at FROM active_seals WHERE tour_box_id = ' + sqlValue(tourBoxId) + ';'
  );
}

module.exports = {
  COLLECTION,
  insertRecordStmt,
  updateRecordStmt,
  insertEventStmt,
  claimSealStmt,
  releaseSealStmt,
  releaseBoxSealsStmt,
  findSealOwner,
  findActiveSealByBox
};
