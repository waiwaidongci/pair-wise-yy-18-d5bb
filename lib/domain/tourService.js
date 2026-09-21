'use strict';

// 判定层（装箱域服务）：装箱前核对、封签唯一与并发幂等、到场解封判定、
// 更正失效留档、闭环释放。只通过存储层读写，不碰 HTTP。
const { randomUUID } = require('crypto');
const { mutate, now } = require('../storage/db');
const tourStore = require('../storage/tourStore');
const inventory = require('../storage/inventoryStore');
const config = require('../../project.config');

const COLLECTION = 'tourBoxes';
const SEALED_STATUSES = ['已装箱', '巡演中'];
const ARRIVAL_STATUSES = ['已装箱', '巡演中', '待复核'];
const SEAL_OK_STATUS = '完好';
const SEAL_BAD_STATUS = '异常';

class DomainError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// 进程内串行锁：并发封箱时保证“检查占号 → 写入”原子，
// 后到的同号封箱沿用首次结果，异号冲突 409。
let chain = Promise.resolve();
function withLock(task) {
  const run = chain.then(() => task());
  chain = run.then(() => undefined, () => undefined);
  return run;
}

function uniq(ids) {
  return [...new Set(ids || [])];
}

function cleanOrderData(record) {
  const data = { ...record };
  delete data.id;
  delete data.collection;
  delete data.createdAt;
  delete data.updatedAt;
  return data;
}

function orderTitle(data) {
  return [data.showName, data.play].filter(Boolean).join(' / ') || data.showName || '';
}

// ---------- 装箱前核对：偶头/配件状态 + 箱号，全部通过才可写入 ----------
function verifyManifest({ headIds, accessoryIds, headBoxMap, accessoryBoxMap, excludeBoxId }) {
  const problems = [];
  const seen = new Map();

  const markDuplicates = (ids, kind) => {
    const counts = new Map();
    for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
    for (const [id, count] of counts) {
      if (count > 1) {
        problems.push({ type: '重复列入', itemType: kind, itemId: id, message: `${kind === 'head' ? '偶头' : '配件'} ${id} 在清单中重复` });
      }
    }
  };

  markDuplicates(headIds, 'head');
  markDuplicates(accessoryIds, 'accessory');

  const heads = inventory.listByIds(inventory.ITEM_COLLECTIONS.head, uniq(headIds));
  const accessories = inventory.listByIds(inventory.ITEM_COLLECTIONS.accessory, uniq(accessoryIds));

  const headMap = new Map(heads.map((h) => [h.id, h]));
  const accessoryMap = new Map(accessories.map((a) => [a.id, a]));

  for (const id of uniq(headIds)) {
    const item = headMap.get(id);
    if (!item) {
      problems.push({ type: '档案缺失', itemType: 'head', itemId: id, message: `偶头 ${id} 不存在` });
      continue;
    }
    if (item.status !== '可演出') {
      problems.push({ type: '状态不符', itemType: 'head', itemId: id, itemName: item.role, expected: '可演出', actual: item.status, message: `偶头「${item.role || id}」当前状态为「${item.status}」，不可装箱` });
    }
    const declared = headBoxMap[id];
    if (declared && item.boxNo && declared !== item.boxNo) {
      problems.push({ type: '箱号不符', itemType: 'head', itemId: id, itemName: item.role, expected: item.boxNo, actual: declared, message: `偶头「${item.role || id}」箱号应为「${item.boxNo}」，清单填写「${declared}」` });
    }
  }

  for (const id of uniq(accessoryIds)) {
    const item = accessoryMap.get(id);
    if (!item) {
      problems.push({ type: '档案缺失', itemType: 'accessory', itemId: id, message: `配件 ${id} 不存在` });
      continue;
    }
    if (item.status !== '在库') {
      problems.push({ type: '状态不符', itemType: 'accessory', itemId: id, itemName: item.name, expected: '在库', actual: item.status, message: `配件「${item.name || id}」当前状态为「${item.status}」，不可装箱` });
    }
    const declared = accessoryBoxMap[id];
    if (declared && item.boxNo && declared !== item.boxNo) {
      problems.push({ type: '箱号不符', itemType: 'accessory', itemId: id, itemName: item.name, expected: item.boxNo, actual: declared, message: `配件「${item.name || id}」箱号应为「${item.boxNo}」，清单填写「${declared}」` });
    }
  }

  // 已被其它未结束装箱单占用的档案不得重复装箱
  for (const item of inventory.findOccupancy(inventory.ITEM_COLLECTIONS.head, uniq(headIds), excludeBoxId)) {
    problems.push({ type: '重复占用', itemType: 'head', itemId: item.id, itemName: item.role, occupiedBy: item.tourBoxId, message: `偶头「${item.role || item.id}」已在装箱单 ${item.tourBoxId} 中` });
  }
  for (const item of inventory.findOccupancy(inventory.ITEM_COLLECTIONS.accessory, uniq(accessoryIds), excludeBoxId)) {
    problems.push({ type: '重复占用', itemType: 'accessory', itemId: item.id, itemName: item.name, occupiedBy: item.tourBoxId, message: `配件「${item.name || item.id}」已在装箱单 ${item.tourBoxId} 中` });
  }

  return problems;
}

function loadOrderOr404(id) {
  const record = inventory.loadRecord(COLLECTION, id);
  if (!record) throw new DomainError(404, 'NOT_FOUND', '装箱单不存在: ' + id);
  return record;
}

// ---------- 创建装箱单（装箱前核对不过则 409，整单不写入） ----------
function createPackingOrder(body, actor) {
  const headIds = Array.isArray(body.headIds) ? body.headIds : [];
  const accessoryIds = Array.isArray(body.accessoryIds) ? body.accessoryIds : [];
  const headBoxInput = body.headBoxNos || {};
  const accessoryBoxInput = body.accessoryBoxNos || {};

  const heads = inventory.listByIds(inventory.ITEM_COLLECTIONS.head, uniq(headIds));
  const accessories = inventory.listByIds(inventory.ITEM_COLLECTIONS.accessory, uniq(accessoryIds));
  const headBoxMap = {};
  const accessoryBoxMap = {};
  for (const h of heads) headBoxMap[h.id] = headBoxInput[h.id] || h.boxNo;
  for (const a of accessories) accessoryBoxMap[a.id] = accessoryBoxInput[a.id] || a.boxNo;

  const problems = verifyManifest({ headIds, accessoryIds, headBoxMap, accessoryBoxMap });
  if (problems.length) {
    throw new DomainError(409, 'MANIFEST_MISMATCH', '装箱前核对未通过，整单未写入', { problems });
  }

  const id = randomUUID();
  const ts = now();
  const data = {
    showName: body.showName,
    venue: body.venue,
    play: body.play,
    headIds: uniq(headIds),
    accessoryIds: uniq(accessoryIds),
    headBoxMap,
    accessoryBoxMap,
    sealNo: null,
    sealedAt: null,
    sealedBy: null,
    sealNote: '',
    arrival: null,
    archivedArrivals: [],
    performanceAllowed: false,
    createdBy: actor || '',
    note: body.note || ''
  };
  data.status = '草稿';

  mutate([
    tourStore.insertRecordStmt({ id, status: '草稿', title: orderTitle(data), data, createdAt: ts }),
    tourStore.insertEventStmt({
      recordId: id,
      action: '建单',
      status: '草稿',
      actor: actor || '',
      note: body.note || '',
      data: { headIds: data.headIds, accessoryIds: data.accessoryIds },
      createdAt: ts
    })
  ]);

  return inventory.loadRecord(COLLECTION, id);
}

// ---------- 封箱补封签 ----------
function sealBox(id, body, actor) {
  return withLock(() => {
    const sealNo = String(body.sealNo || '').trim();
    if (!sealNo) throw new DomainError(400, 'BAD_REQUEST', 'sealNo 为必填项');

    const order = loadOrderOr404(id);

    // 已封箱：并发/重复封箱沿用首次结果（同号幂等），异号冲突
    if (order.status !== '草稿') {
      if (order.sealNo === sealNo) {
        return { record: order, reused: true };
      }
      throw new DomainError(409, 'SEAL_MISMATCH', '该装箱单已加封封签「' + order.sealNo + '」，与本次封签号不符', {
        existingSealNo: order.sealNo,
        submittedSealNo: sealNo
      });
    }

    // 封签号在未结束装箱单中唯一（active_seals 主键保证，先给可读错误）
    const owner = tourStore.findSealOwner(sealNo);
    if (owner) {
      throw new DomainError(409, 'SEAL_CONFLICT', '封签号「' + sealNo + '」已被未结束装箱单 ' + owner.tour_box_id + ' 占用', {
        sealNo,
        occupiedBy: owner.tour_box_id
      });
    }

    // 封箱前再次核对：建单后档案状态/箱号若漂移，同样整单不写入封箱结果
    const problems = verifyManifest({
      headIds: order.headIds,
      accessoryIds: order.accessoryIds,
      headBoxMap: order.headBoxMap || {},
      accessoryBoxMap: order.accessoryBoxMap || {},
      excludeBoxId: id
    });
    if (problems.length) {
      throw new DomainError(409, 'MANIFEST_MISMATCH', '封箱核对未通过，封箱结果未写入', { problems });
    }

    const ts = now();
    const data = cleanOrderData(order);
    data.status = '已装箱';
    data.sealNo = sealNo;
    data.sealedAt = ts;
    data.sealedBy = actor || '';
    data.sealNote = body.note || '';
    data.performanceAllowed = false;

    const statements = [
      tourStore.updateRecordStmt({ id, status: '已装箱', title: orderTitle(data), data }),
      tourStore.claimSealStmt({ sealNo, tourBoxId: id, createdAt: ts }),
      tourStore.insertEventStmt({
        recordId: id,
        action: '封箱加签',
        status: '已装箱',
        actor: actor || '',
        note: body.note || '',
        data: { sealNo },
        createdAt: ts
      })
    ];

    for (const headId of data.headIds) {
      statements.push(inventory.updateItemStatusStmt({
        collection: inventory.ITEM_COLLECTIONS.head,
        id: headId,
        status: '已装箱',
        extra: { tourBoxId: id, currentUsable: false }
      }));
      statements.push(inventory.insertInventoryEventStmt({
        recordId: headId,
        collection: inventory.ITEM_COLLECTIONS.head,
        action: '随单装箱',
        status: '已装箱',
        actor: actor || '',
        note: `装箱单 ${id} 封签 ${sealNo}`,
        data: { tourBoxId: id, sealNo }
      }));
    }
    for (const accessoryId of data.accessoryIds) {
      statements.push(inventory.updateItemStatusStmt({
        collection: inventory.ITEM_COLLECTIONS.accessory,
        id: accessoryId,
        status: '已装箱',
        extra: { tourBoxId: id }
      }));
      statements.push(inventory.insertInventoryEventStmt({
        recordId: accessoryId,
        collection: inventory.ITEM_COLLECTIONS.accessory,
        action: '随单装箱',
        status: '已装箱',
        actor: actor || '',
        note: `装箱单 ${id} 封签 ${sealNo}`,
        data: { tourBoxId: id, sealNo }
      }));
    }

    try {
      mutate(statements.filter(Boolean));
    } catch (error) {
      // 极端并发下占号被抢先：整批回滚，不产生部分写入
      if (String(error.message || '').includes('UNIQUE constraint failed: active_seals.seal_no')) {
        const winner = tourStore.findSealOwner(sealNo);
        if (winner && winner.tour_box_id === id) {
          return { record: inventory.loadRecord(COLLECTION, id), reused: true };
        }
        throw new DomainError(409, 'SEAL_CONFLICT', '封签号「' + sealNo + '」并发冲突，已被其它装箱单抢先占用', {
          sealNo,
          occupiedBy: winner ? winner.tour_box_id : null
        });
      }
      throw error;
    }

    return { record: inventory.loadRecord(COLLECTION, id), reused: false };
  });
}

// ---------- 到场解封 ----------
function registerArrival(id, body, actor) {
  return withLock(() => {
    const order = loadOrderOr404(id);
    if (!ARRIVAL_STATUSES.includes(order.status)) {
      throw new DomainError(409, 'INVALID_STATE', `当前状态「${order.status}」不可到场登记`);
    }
    if (!order.sealNo) {
      throw new DomainError(409, 'NOT_SEALED', '装箱单尚未封箱加签，无法到场解封');
    }

    const receiver = String(body.receiver || '').trim();
    const sealNo = String(body.sealNo || '').trim();
    const sealStatus = body.sealStatus;
    if (!receiver) throw new DomainError(400, 'BAD_REQUEST', 'receiver（接收人）为必填项');
    if (!sealNo) throw new DomainError(400, 'BAD_REQUEST', 'sealNo（到场封签号）为必填项');
    if (![SEAL_OK_STATUS, SEAL_BAD_STATUS].includes(sealStatus)) {
      throw new DomainError(400, 'BAD_REQUEST', `sealStatus 仅支持「${SEAL_OK_STATUS}」或「${SEAL_BAD_STATUS}」`);
    }
    const arrivedHeadIds = Array.isArray(body.arrivedHeadIds) ? uniq(body.arrivedHeadIds) : [];
    const arrivedAccessoryIds = Array.isArray(body.arrivedAccessoryIds) ? uniq(body.arrivedAccessoryIds) : [];
    const observedBoxes = body.observedBoxes || {};

    const problems = [];

    if (sealNo !== order.sealNo) {
      problems.push({
        type: '封签不符',
        expected: order.sealNo,
        actual: sealNo,
        message: `到场封签号「${sealNo}」与装箱封签号「${order.sealNo}」不符`
      });
    }
    if (sealStatus === SEAL_BAD_STATUS) {
      problems.push({ type: '封签异常', actual: sealStatus, message: '封签状态为「异常」（破损/拆动痕迹）' });
    }

    // 缺件：装箱清单有、实到清单无
    for (const headId of order.headIds) {
      if (!arrivedHeadIds.includes(headId)) {
        problems.push({ type: '缺件', itemType: 'head', itemId: headId, message: `偶头 ${headId} 未到场` });
      }
    }
    for (const accessoryId of order.accessoryIds) {
      if (!arrivedAccessoryIds.includes(accessoryId)) {
        problems.push({ type: '缺件', itemType: 'accessory', itemId: accessoryId, message: `配件 ${accessoryId} 未到场` });
      }
    }
    // 多件：实到清单有、装箱清单无
    for (const headId of arrivedHeadIds) {
      if (!order.headIds.includes(headId)) {
        problems.push({ type: '多件', itemType: 'head', itemId: headId, message: `偶头 ${headId} 不在装箱清单中（错箱）` });
      }
    }
    for (const accessoryId of arrivedAccessoryIds) {
      if (!order.accessoryIds.includes(accessoryId)) {
        problems.push({ type: '多件', itemType: 'accessory', itemId: accessoryId, message: `配件 ${accessoryId} 不在装箱清单中（错箱）` });
      }
    }
    // 错箱：实物箱号与清单箱号不符
    const declaredBoxes = { ...(order.headBoxMap || {}), ...(order.accessoryBoxMap || {}) };
    for (const [itemId, observedBox] of Object.entries(observedBoxes)) {
      const declared = declaredBoxes[itemId];
      if (declared && observedBox && declared !== observedBox) {
        problems.push({
          type: '错箱',
          itemId,
          expected: declared,
          actual: observedBox,
          message: `物件 ${itemId} 实到箱号「${observedBox}」与装箱清单「${declared}」不符`
        });
      }
    }

    const ts = now();
    const data = cleanOrderData(order);
    const archivedArrivals = Array.isArray(data.archivedArrivals) ? [...data.archivedArrivals] : [];
    if (data.arrival) {
      archivedArrivals.push({ ...data.arrival, invalidatedAt: ts, invalidReason: '重新到场登记' });
    }

    const arrival = {
      receiver,
      sealNo,
      sealStatus,
      arrivedHeadIds,
      arrivedAccessoryIds,
      observedBoxes,
      problems,
      ok: problems.length === 0,
      arrivedAt: ts,
      registeredBy: actor || ''
    };
    data.arrival = arrival;
    data.archivedArrivals = archivedArrivals;

    let status;
    if (problems.length) {
      status = '待复核';
      data.performanceAllowed = false;
    } else {
      status = '已解封';
      data.performanceAllowed = true;
    }
    data.status = status;

    mutate([
      tourStore.updateRecordStmt({ id, status, title: orderTitle(data), data }),
      tourStore.insertEventStmt({
        recordId: id,
        action: problems.length ? '到场解封·待复核' : '到场解封',
        status,
        actor: actor || '',
        note: problems.length ? problems.map((p) => p.message).join('；') : '封签完好，清单相符，准予解封',
        data: { receiver, sealNo, sealStatus, arrivedHeadIds, arrivedAccessoryIds, observedBoxes, problems },
        createdAt: ts
      })
    ]);

    return {
      record: inventory.loadRecord(COLLECTION, id),
      problems,
      performanceAllowed: problems.length === 0
    };
  });
}

// ---------- 更正箱号 / 清单 / 封签：原解封及演出资格失效留档 ----------
function correctOrder(id, body, actor) {
  return withLock(() => {
    const order = loadOrderOr404(id);
    if (order.status === '已闭环') {
      throw new DomainError(409, 'INVALID_STATE', '已闭环装箱单不可更正');
    }

    const data = cleanOrderData(order);
    const ts = now();
    const changeLog = {};
    const statements = [];
    const sealed = order.status !== '草稿';

    // 清单更正
    if (Array.isArray(body.headIds) || Array.isArray(body.accessoryIds)) {
      const nextHeadIds = Array.isArray(body.headIds) ? uniq(body.headIds) : data.headIds;
      const nextAccessoryIds = Array.isArray(body.accessoryIds) ? uniq(body.accessoryIds) : data.accessoryIds;
      const heads = inventory.listByIds(inventory.ITEM_COLLECTIONS.head, uniq(nextHeadIds));
      const accessories = inventory.listByIds(inventory.ITEM_COLLECTIONS.accessory, uniq(nextAccessoryIds));
      const nextHeadBoxMap = { ...(data.headBoxMap || {}) };
      const nextAccessoryBoxMap = { ...(data.accessoryBoxMap || {}) };
      for (const h of heads) if (!nextHeadBoxMap[h.id]) nextHeadBoxMap[h.id] = h.boxNo;
      for (const a of accessories) if (!nextAccessoryBoxMap[a.id]) nextAccessoryBoxMap[a.id] = a.boxNo;

      const problems = sealed
        ? verifyManifest({ headIds: nextHeadIds, accessoryIds: nextAccessoryIds, headBoxMap: nextHeadBoxMap, accessoryBoxMap: nextAccessoryBoxMap, excludeBoxId: id })
        // 草稿阶段只校验存在性/重复，不占用
        : verifyManifest({ headIds: nextHeadIds, accessoryIds: nextAccessoryIds, headBoxMap: nextHeadBoxMap, accessoryBoxMap: nextAccessoryBoxMap })
          .filter((p) => p.type === '档案缺失' || p.type === '重复列入');
      if (problems.length) {
        throw new DomainError(409, 'MANIFEST_MISMATCH', '清单更正核对未通过，更正未写入', { problems });
      }

      if (sealed) {
        // 移除的档案释放
        for (const headId of data.headIds.filter((x) => !nextHeadIds.includes(x))) {
          statements.push(inventory.updateItemStatusStmt({ collection: inventory.ITEM_COLLECTIONS.head, id: headId, status: '可演出', extra: { tourBoxId: null, currentUsable: true } }));
          statements.push(inventory.insertInventoryEventStmt({ recordId: headId, collection: inventory.ITEM_COLLECTIONS.head, action: '更正移出', status: '可演出', actor: actor || '', note: `装箱单 ${id} 清单更正移出`, data: { tourBoxId: id } }));
        }
        for (const accessoryId of data.accessoryIds.filter((x) => !nextAccessoryIds.includes(x))) {
          statements.push(inventory.updateItemStatusStmt({ collection: inventory.ITEM_COLLECTIONS.accessory, id: accessoryId, status: '在库', extra: { tourBoxId: null } }));
          statements.push(inventory.insertInventoryEventStmt({ recordId: accessoryId, collection: inventory.ITEM_COLLECTIONS.accessory, action: '更正移出', status: '在库', actor: actor || '', note: `装箱单 ${id} 清单更正移出`, data: { tourBoxId: id } }));
        }
        // 新增的档案占用
        for (const headId of nextHeadIds.filter((x) => !data.headIds.includes(x))) {
          statements.push(inventory.updateItemStatusStmt({ collection: inventory.ITEM_COLLECTIONS.head, id: headId, status: '已装箱', extra: { tourBoxId: id, currentUsable: false } }));
          statements.push(inventory.insertInventoryEventStmt({ recordId: headId, collection: inventory.ITEM_COLLECTIONS.head, action: '更正补入', status: '已装箱', actor: actor || '', note: `装箱单 ${id} 清单更正补入`, data: { tourBoxId: id } }));
        }
        for (const accessoryId of nextAccessoryIds.filter((x) => !data.accessoryIds.includes(x))) {
          statements.push(inventory.updateItemStatusStmt({ collection: inventory.ITEM_COLLECTIONS.accessory, id: accessoryId, status: '已装箱', extra: { tourBoxId: id } }));
          statements.push(inventory.insertInventoryEventStmt({ recordId: accessoryId, collection: inventory.ITEM_COLLECTIONS.accessory, action: '更正补入', status: '已装箱', actor: actor || '', note: `装箱单 ${id} 清单更正补入`, data: { tourBoxId: id } }));
        }
      }

      changeLog.headIds = { from: data.headIds, to: nextHeadIds };
      changeLog.accessoryIds = { from: data.accessoryIds, to: nextAccessoryIds };
      data.headIds = nextHeadIds;
      data.accessoryIds = nextAccessoryIds;
      data.headBoxMap = nextHeadBoxMap;
      data.accessoryBoxMap = nextAccessoryBoxMap;
    }

    // 箱号更正
    if (body.headBoxNos && typeof body.headBoxNos === 'object') {
      data.headBoxMap = { ...(data.headBoxMap || {}), ...body.headBoxNos };
      changeLog.headBoxNos = body.headBoxNos;
    }
    if (body.accessoryBoxNos && typeof body.accessoryBoxNos === 'object') {
      data.accessoryBoxMap = { ...(data.accessoryBoxMap || {}), ...body.accessoryBoxNos };
      changeLog.accessoryBoxNos = body.accessoryBoxNos;
    }

    // 封签更正（仅已封箱单；未结束装箱单内唯一）
    let nextSealNo = null;
    if (body.sealNo !== undefined) {
      nextSealNo = String(body.sealNo || '').trim();
      if (!nextSealNo) throw new DomainError(400, 'BAD_REQUEST', 'sealNo 不可为空');
      if (!sealed) throw new DomainError(409, 'INVALID_STATE', '草稿装箱单尚未封箱，不能更正封签；请直接封箱');
      if (nextSealNo !== order.sealNo) {
        const owner = tourStore.findSealOwner(nextSealNo);
        if (owner && owner.tour_box_id !== id) {
          throw new DomainError(409, 'SEAL_CONFLICT', '封签号「' + nextSealNo + '」已被未结束装箱单 ' + owner.tour_box_id + ' 占用', { sealNo: nextSealNo, occupiedBy: owner.tour_box_id });
        }
        statements.push(tourStore.releaseSealStmt(order.sealNo));
        statements.push(tourStore.claimSealStmt({ sealNo: nextSealNo, tourBoxId: id, createdAt: ts }));
        changeLog.sealNo = { from: order.sealNo, to: nextSealNo };
        data.sealNo = nextSealNo;
      }
    }

    for (const field of ['showName', 'venue', 'play', 'note']) {
      if (body[field] !== undefined) {
        data[field] = body[field];
        changeLog[field] = body[field];
      }
    }

    // 原解封及演出资格失效留档
    let invalidated = false;
    if (data.arrival) {
      invalidated = true;
      data.archivedArrivals = Array.isArray(data.archivedArrivals) ? data.archivedArrivals : [];
      data.archivedArrivals.push({
        ...data.arrival,
        invalidatedAt: ts,
        invalidReason: body.reason || '装箱单更正（箱号/清单/封签）',
        changeLog
      });
      data.arrival = null;
      data.performanceAllowed = false;
      data.status = '待复核';
    } else if (sealed) {
      // 已封箱但未解封：封签/箱号更正后仍需重新确认到场，不影响在途状态
      data.status = order.status === '巡演中' ? '巡演中' : '已装箱';
    }

    statements.unshift(
      tourStore.updateRecordStmt({ id, status: data.status, title: orderTitle(data), data }),
      tourStore.insertEventStmt({
        recordId: id,
        action: invalidated ? '装箱更正·解封失效' : '装箱更正',
        status: data.status,
        actor: actor || '',
        note: body.reason || (invalidated ? '更正后原解封与演出资格失效，转待复核，需重新到场解封' : '更正装箱信息'),
        data: { changeLog, invalidatedArrival: invalidated },
        createdAt: ts
      })
    );

    try {
      mutate(statements.filter(Boolean));
    } catch (error) {
      if (String(error.message || '').includes('UNIQUE constraint failed: active_seals.seal_no')) {
        throw new DomainError(409, 'SEAL_CONFLICT', '封签号「' + nextSealNo + '」并发冲突，已被其它装箱单占用', { sealNo: nextSealNo });
      }
      throw error;
    }

    return inventory.loadRecord(COLLECTION, id);
  });
}

// ---------- 闭环：释放封签占号与档案占用 ----------
function closeOrder(id, body, actor) {
  return withLock(() => {
    const order = loadOrderOr404(id);
    if (order.status === '草稿') throw new DomainError(409, 'INVALID_STATE', '草稿装箱单未封箱，不可闭环');
    if (order.status === '已闭环') return order;

    const data = cleanOrderData(order);
    data.status = '已闭环';
    data.performanceAllowed = false;
    data.closedAt = now();
    const ts = data.closedAt;

    const statements = [
      tourStore.updateRecordStmt({ id, status: '已闭环', title: orderTitle(data), data }),
      tourStore.releaseBoxSealsStmt(id),
      tourStore.insertEventStmt({
        recordId: id,
        action: '闭环',
        status: '已闭环',
        actor: actor || '',
        note: (body && body.note) || '装箱单闭环，释放封签占号与档案占用',
        data: {},
        createdAt: ts
      })
    ];
    for (const headId of data.headIds) {
      statements.push(inventory.updateItemStatusStmt({ collection: inventory.ITEM_COLLECTIONS.head, id: headId, status: '可演出', extra: { tourBoxId: null, currentUsable: true } }));
      statements.push(inventory.insertInventoryEventStmt({ recordId: headId, collection: inventory.ITEM_COLLECTIONS.head, action: '返场释放', status: '可演出', actor: actor || '', note: `装箱单 ${id} 闭环`, data: { tourBoxId: id } }));
    }
    for (const accessoryId of data.accessoryIds) {
      statements.push(inventory.updateItemStatusStmt({ collection: inventory.ITEM_COLLECTIONS.accessory, id: accessoryId, status: '在库', extra: { tourBoxId: null } }));
      statements.push(inventory.insertInventoryEventStmt({ recordId: accessoryId, collection: inventory.ITEM_COLLECTIONS.accessory, action: '返场释放', status: '在库', actor: actor || '', note: `装箱单 ${id} 闭环`, data: { tourBoxId: id } }));
    }

    mutate(statements.filter(Boolean));
    return inventory.loadRecord(COLLECTION, id);
  });
}

module.exports = {
  DomainError,
  createPackingOrder,
  sealBox,
  registerArrival,
  correctOrder,
  closeOrder
};
