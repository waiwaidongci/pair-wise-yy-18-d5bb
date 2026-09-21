'use strict';

// 入口层（装箱域路由）：仅做参数解析、形状校验与 HTTP 响应映射，
// 业务判定全部委托 lib/domain/tourService。
const express = require('express');
const { sqlValue, select } = require('../storage/db');
const inventory = require('../storage/inventoryStore');
const tourService = require('../domain/tourService');

const router = express.Router();
const COLLECTION = 'tourBoxes';

function actorOf(req) {
  return (req.body && req.body.actor) || req.get('x-actor') || '';
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim());
}

function isStringMap(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string');
}

function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) {
    const error = new tourService.DomainError(400, 'BAD_REQUEST', '缺少必填字段: ' + missing.join(', '), { missing });
    throw error;
  }
}

function toTimeline(recordId) {
  return select(
    'SELECT * FROM events WHERE record_id = ' + sqlValue(recordId) + ' ORDER BY created_at ASC;'
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

// 创建装箱单（装箱前核对）
router.post('/', (req, res, next) => {
  try {
    const body = req.body || {};
    requireFields(body, ['showName', 'venue', 'play']);
    if (!isStringArray(body.headIds) && body.headIds !== undefined) {
      throw new tourService.DomainError(400, 'BAD_REQUEST', 'headIds 必须为字符串数组');
    }
    if (!isStringArray(body.accessoryIds) && body.accessoryIds !== undefined) {
      throw new tourService.DomainError(400, 'BAD_REQUEST', 'accessoryIds 必须为字符串数组');
    }
    if (body.headBoxNos !== undefined && !isStringMap(body.headBoxNos)) {
      throw new tourService.DomainError(400, 'BAD_REQUEST', 'headBoxNos 必须为 {偶头id: 箱号} 对象');
    }
    if (body.accessoryBoxNos !== undefined && !isStringMap(body.accessoryBoxNos)) {
      throw new tourService.DomainError(400, 'BAD_REQUEST', 'accessoryBoxNos 必须为 {配件id: 箱号} 对象');
    }
    if (![...(body.headIds || []), ...(body.accessoryIds || [])].length) {
      throw new tourService.DomainError(400, 'BAD_REQUEST', 'headIds 与 accessoryIds 至少各/合计包含一项');
    }
    const record = tourService.createPackingOrder(body, actorOf(req));
    res.status(201).json(record);
  } catch (error) {
    next(error);
  }
});

// 封箱补封签（并发安全，同号幂等）
router.post('/:id/seal', (req, res, next) => {
  Promise.resolve()
    .then(() => {
      const body = req.body || {};
      requireFields(body, ['sealNo']);
      return tourService.sealBox(req.params.id, body, actorOf(req));
    })
    .then(({ record, reused }) => res.status(reused ? 200 : 200).json({ record, reused: !!reused }))
    .catch(next);
});

// 到场解封登记
router.post('/:id/arrival', (req, res, next) => {
  Promise.resolve()
    .then(() => {
      const body = req.body || {};
      requireFields(body, ['receiver', 'sealNo', 'sealStatus']);
      for (const key of ['arrivedHeadIds', 'arrivedAccessoryIds']) {
        if (body[key] !== undefined && !isStringArray(body[key])) {
          throw new tourService.DomainError(400, 'BAD_REQUEST', key + ' 必须为字符串数组');
        }
      }
      if (body.observedBoxes !== undefined && !isStringMap(body.observedBoxes)) {
        throw new tourService.DomainError(400, 'BAD_REQUEST', 'observedBoxes 必须为 {物件id: 箱号} 对象');
      }
      return tourService.registerArrival(req.params.id, body, actorOf(req));
    })
    .then((result) => res.json(result))
    .catch(next);
});

// 更正箱号 / 清单 / 封签（原解封与演出资格失效留档）
router.post('/:id/correct', (req, res, next) => {
  Promise.resolve()
    .then(() => tourService.correctOrder(req.params.id, req.body || {}, actorOf(req)))
    .then((record) => res.json(record))
    .catch(next);
});

// 闭环
router.post('/:id/close', (req, res, next) => {
  Promise.resolve()
    .then(() => tourService.closeOrder(req.params.id, req.body || {}, actorOf(req)))
    .then((record) => res.json(record))
    .catch(next);
});

// 装箱履历（= 装箱单时间线）
router.get('/:id/history', (req, res, next) => {
  try {
    const record = inventory.loadRecord(COLLECTION, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json({ record, events: toTimeline(req.params.id) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
