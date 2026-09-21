// 判定模块（巡演装箱/封签/到场解封）：纯业务规则，不直接碰 HTTP，也不写裸 SQL。
// 所有读写都经由 storage 模块；多表变更通过 db.writeAll 在单个事务内提交，
// 因此“核对不符 => 409 且整单不写入”由“先校验、后事务”的顺序天然保证。
const db = require('../storage/db');

const COLLECTION = 'tourBoxes';
const HEAD_COLLECTION = 'puppetHeads';
const ACCESSORY_COLLECTION = 'accessories';

// 未结束 = 尚未闭环的装箱单：其封签号仍在占用，其中的偶头/配件仍被占用。
const CLOSED_STATUS = '已闭环';
const PACKED_STATUS = '已装箱';
const SEALED_STATUS = '已封箱';
const REVIEW_STATUS = '待复核';
const READY_STATUS = '可演出';

const HEAD_USABLE_STATUS = '可演出';
const ACCESSORY_USABLE_STATUS = '在库';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// 变更类业务在存储写锁内串行执行：锁内的读取与判定不会与其它写请求穿插。
function locked(fn) {
  return (...args) => db.withLock(() => fn(...args));
}

function titleFor(data) {
  return [data.showName, data.play].filter(Boolean).join(' / ') || data.venue || '';
}

function uniqueArray(values) {
  return [...new Set(values)];
}

// 取所有“未结束”装箱单（不含 excludeId），返回 { box, headIds, accessoryIds }[]
function activeBoxes(excludeId) {
  return db.listRecords(COLLECTION)
    .filter((box) => box.status !== CLOSED_STATUS && box.id !== excludeId)
    .map((box) => ({
      box,
      headIds: (box.manifest || []).filter((item) => item.itemType === 'head').map((item) => item.itemId),
      accessoryIds: (box.manifest || []).filter((item) => item.itemType === 'accessory').map((item) => item.itemId)
    }));
}

function manifestEntries(boxData) {
  return boxData.manifest || [];
}

// ---------- 装箱前核对 ----------

function checkPackableItems({ headIds, accessoryIds, declaredBoxes, excludeBoxId }) {
  const problems = [];
  const resolvedHeads = [];
  const resolvedAccessories = [];

  const claimHeads = new Set();
  const claimAccessories = new Set();
  for (const active of activeBoxes(excludeBoxId)) {
    active.headIds.forEach((id) => claimHeads.add(id));
    active.accessoryIds.forEach((id) => claimAccessories.add(id));
  }

  headIds.forEach((headId) => {
    const head = db.getRecord(HEAD_COLLECTION, headId);
    if (!head) {
      problems.push({ type: '缺档案', itemType: 'head', itemId: headId, message: '偶头不存在：' + headId });
      return;
    }
    if (head.status !== HEAD_USABLE_STATUS || head.currentUsable === false) {
      problems.push({
        type: '状态不符',
        itemType: 'head',
        itemId: headId,
        expected: HEAD_USABLE_STATUS,
        actual: head.status,
        message: '偶头当前不可演出：' + (head.role || headId)
      });
    }
    const declared = declaredBoxes[headId];
    if (declared !== undefined && declared !== head.boxNo) {
      problems.push({
        type: '箱号不符',
        itemType: 'head',
        itemId: headId,
        expected: head.boxNo,
        actual: declared,
        message: '偶头申报箱号与档案不符：' + (head.role || headId)
      });
    }
    if (claimHeads.has(headId)) {
      problems.push({
        type: '重复装箱',
        itemType: 'head',
        itemId: headId,
        message: '偶头已在其它未结束装箱单中：' + (head.role || headId)
      });
    }
    resolvedHeads.push({ head, boxNo: head.boxNo });
  });

  accessoryIds.forEach((accessoryId) => {
    const accessory = db.getRecord(ACCESSORY_COLLECTION, accessoryId);
    if (!accessory) {
      problems.push({ type: '缺档案', itemType: 'accessory', itemId: accessoryId, message: '配件不存在：' + accessoryId });
      return;
    }
    if (accessory.status !== ACCESSORY_USABLE_STATUS) {
      problems.push({
        type: '状态不符',
        itemType: 'accessory',
        itemId: accessoryId,
        expected: ACCESSORY_USABLE_STATUS,
        actual: accessory.status,
        message: '配件当前不在库：' + (accessory.name || accessoryId)
      });
    }
    const declared = declaredBoxes[accessoryId];
    if (declared !== undefined && declared !== accessory.boxNo) {
      problems.push({
        type: '箱号不符',
        itemType: 'accessory',
        itemId: accessoryId,
        expected: accessory.boxNo,
        actual: declared,
        message: '配件申报箱号与档案不符：' + (accessory.name || accessoryId)
      });
    }
    if (claimAccessories.has(accessoryId)) {
      problems.push({
        type: '重复装箱',
        itemType: 'accessory',
        itemId: accessoryId,
        message: '配件已在其它未结束装箱单中：' + (accessory.name || accessoryId)
      });
    }
    resolvedAccessories.push({ accessory, boxNo: accessory.boxNo });
  });

  return { problems, resolvedHeads, resolvedAccessories };
}

// 装箱：核对偶头/配件状态与箱号，任一不符整体拒绝、不写入任何记录。
async function packBoxes(input, actor) {
  const headIds = Array.isArray(input.headIds) ? input.headIds.map(String) : [];
  const accessoryIds = Array.isArray(input.accessoryIds) ? input.accessoryIds.map(String) : [];
  const declaredBoxes = input.boxes && typeof input.boxes === 'object' ? input.boxes : {};

  const missing = ['showName', 'venue', 'play'].filter(
    (field) => input[field] === undefined || input[field] === ''
  );
  if (missing.length) {
    throw new HttpError(400, '缺少必填字段：' + missing.join('、'));
  }
  if (!Array.isArray(input.headIds) || !Array.isArray(input.accessoryIds)) {
    throw new HttpError(400, 'headIds 与 accessoryIds 必须为数组');
  }
  if (uniqueArray(headIds).length !== headIds.length || uniqueArray(accessoryIds).length !== accessoryIds.length) {
    throw new HttpError(400, '装箱清单存在重复条目');
  }

  const { problems, resolvedHeads, resolvedAccessories } = checkPackableItems({
    headIds,
    accessoryIds,
    declaredBoxes,
    excludeBoxId: null
  });
  if (problems.length) {
    // 关键规则：整单不写入——此处直接抛出，之后才进入事务写库。
    throw new HttpError(409, '装箱前核对未通过，整单未写入', { problems });
  }

  const timestamp = db.now();
  const boxId = db.uuid();
  const manifest = [
    ...resolvedHeads.map(({ head, boxNo }) => ({
      itemType: 'head',
      itemId: head.id,
      name: head.role,
      play: head.play,
      boxNo,
      packedStatus: head.status
    })),
    ...resolvedAccessories.map(({ accessory, boxNo }) => ({
      itemType: 'accessory',
      itemId: accessory.id,
      name: accessory.name,
      play: accessory.play,
      boxNo,
      packedStatus: accessory.status
    }))
  ];

  const boxData = {
    showName: input.showName,
    venue: input.venue,
    play: input.play,
    manifest,
    sealNo: null,
    sealedAt: null,
    sealedBy: null,
    arrivals: [],
    corrections: [],
    canPerform: false,
    qualificationNote: '未到场解封，不得演出'
  };
  const data = { ...boxData, status: PACKED_STATUS };

  const ops = [
    {
      type: 'insertRecord',
      id: boxId,
      collection: COLLECTION,
      status: PACKED_STATUS,
      title: titleFor(boxData),
      data,
      createdAt: timestamp
    },
    {
      type: 'insertEvent',
      recordId: boxId,
      collection: COLLECTION,
      action: '装箱核对通过',
      status: PACKED_STATUS,
      actor: actor || '',
      note: input.note || '',
      data: { headIds, accessoryIds },
      createdAt: timestamp
    }
  ];

  resolvedHeads.forEach(({ head }) => {
    const nextData = { ...head, status: '已装箱' };
    ops.push({
      type: 'updateRecord',
      id: head.id,
      collection: HEAD_COLLECTION,
      status: '已装箱',
      title: [head.role, head.play].filter(Boolean).join(' / '),
      data: nextData,
      updatedAt: timestamp
    });
    ops.push({
      type: 'insertEvent',
      recordId: head.id,
      collection: HEAD_COLLECTION,
      action: '装箱',
      status: '已装箱',
      actor: actor || '',
      note: '随装箱单 ' + boxId,
      data: { tourBoxId: boxId },
      createdAt: timestamp
    });
  });

  resolvedAccessories.forEach(({ accessory }) => {
    const nextData = { ...accessory, status: '已装箱' };
    ops.push({
      type: 'updateRecord',
      id: accessory.id,
      collection: ACCESSORY_COLLECTION,
      status: '已装箱',
      title: [accessory.name, accessory.role].filter(Boolean).join(' / '),
      data: nextData,
      updatedAt: timestamp
    });
    ops.push({
      type: 'insertEvent',
      recordId: accessory.id,
      collection: ACCESSORY_COLLECTION,
      action: '装箱',
      status: '已装箱',
      actor: actor || '',
      note: '随装箱单 ' + boxId,
      data: { tourBoxId: boxId },
      createdAt: timestamp
    });
  });

  db.transact(db.buildStatements(ops));
  return { box: db.getRecord(COLLECTION, boxId), reused: false };
}

// ---------- 封签 ----------

// 封签唯一性与并发沿用由存储写锁保证：并发请求在锁外排队，首封落库后，
// 后来者在锁内读到已存在的封签——同号即沿用首次结果，异号即冲突拒绝。
function findSealConflict(sealNo, excludeBoxId) {
  return db.listRecords(COLLECTION).find(
    (box) => box.status !== CLOSED_STATUS && box.id !== excludeBoxId && box.sealNo === sealNo
  ) || null;
}

async function sealBoxOnce(boxId, input, actor) {
  const sealNo = input && input.sealNo !== undefined ? String(input.sealNo) : '';
  if (!sealNo) {
    throw new HttpError(400, '封签号不能为空');
  }

  const box = db.getRecord(COLLECTION, boxId);
  if (!box) throw new HttpError(404, '装箱单不存在');
  if (box.status === CLOSED_STATUS) {
    throw new HttpError(409, '装箱单已闭环，不能再补封签');
  }

  // 已封箱：同封签号（含并发/重试）直接沿用首次结果；不同封签号一律冲突。
  if (box.sealNo) {
    if (box.sealNo === sealNo) {
      return { box, reused: true };
    }
    throw new HttpError(409, '装箱单已加封签且封签号不一致，首封结果不可覆盖', {
      existingSealNo: box.sealNo,
      submittedSealNo: sealNo
    });
  }
  if (box.status !== PACKED_STATUS) {
    throw new HttpError(409, '当前状态不能补封签：' + box.status);
  }

  const conflict = findSealConflict(sealNo, boxId);
  if (conflict) {
    throw new HttpError(409, '封签号在未结束装箱单中已被占用', {
      conflictBoxId: conflict.id,
      sealNo
    });
  }

  const timestamp = db.now();
  const nextData = {
    ...box,
    status: SEALED_STATUS,
    sealNo,
    sealedAt: timestamp,
    sealedBy: actor || box.sealedBy || null
  };
  db.transact(db.buildStatements([
    {
      type: 'updateRecord',
      id: boxId,
      collection: COLLECTION,
      status: SEALED_STATUS,
      title: titleFor(nextData),
      data: nextData,
      updatedAt: timestamp
    },
    {
      type: 'insertEvent',
      recordId: boxId,
      collection: COLLECTION,
      action: '补封签',
      status: SEALED_STATUS,
      actor: actor || '',
      note: input.note || '',
      data: { sealNo },
      createdAt: timestamp
    }
  ]));
  return { box: db.getRecord(COLLECTION, boxId), reused: false };
}

// ---------- 到场解封 ----------

function normalizeActualItems(input) {
  const raw = Array.isArray(input.actualItems)
    ? input.actualItems
    : Array.isArray(input.items)
      ? input.items
      : null;
  if (raw === null) return null;
  const items = [];
  raw.forEach((entry) => {
    if (typeof entry === 'string') {
      items.push({ itemType: null, itemId: entry });
    } else if (entry && (entry.id || entry.itemId)) {
      items.push({
        itemType: entry.itemType || entry.type || null,
        itemId: String(entry.id || entry.itemId),
        boxNo: entry.boxNo
      });
    }
  });
  return items;
}

async function arriveOnce(boxId, input, actor) {
  const box = db.getRecord(COLLECTION, boxId);
  if (!box) throw new HttpError(404, '装箱单不存在');
  if (box.status === CLOSED_STATUS) {
    throw new HttpError(409, '装箱单已闭环，不能再登记到场');
  }
  if (!box.sealNo) {
    throw new HttpError(409, '装箱单尚未加封封签，无法到场解封');
  }

  const receiver = input.receiver !== undefined ? String(input.receiver) : '';
  if (!receiver) throw new HttpError(400, '接收人不能为空');

  const submittedSeal = input.actualSeal !== undefined && input.actualSeal !== null && input.actualSeal !== ''
    ? String(input.actualSeal)
    : null;
  const sealMismatch = submittedSeal !== null && submittedSeal !== box.sealNo;

  const actualBoxes = input.boxes && typeof input.boxes === 'object' ? input.boxes : {};
  const wrongBoxes = [];
  manifestEntries(box).forEach((entry) => {
    const actualBoxNo = actualBoxes[entry.itemId];
    if (actualBoxNo !== undefined && actualBoxNo !== entry.boxNo) {
      wrongBoxes.push({
        itemType: entry.itemType,
        itemId: entry.itemId,
        name: entry.name,
        expectedBoxNo: entry.boxNo,
        actualBoxNo
      });
    }
  });

  // 实到清单缺省 = 按装箱单全数到场；显式传数组则据此核缺件。
  const expectedHeads = manifestEntries(box).filter((entry) => entry.itemType === 'head');
  const expectedAccessories = manifestEntries(box).filter((entry) => entry.itemType === 'accessory');
  const actualItems = normalizeActualItems(input);
  let actualIds = null;
  let missingHeads = [];
  let missingAccessories = [];
  let extraItems = [];
  if (actualItems) {
    const present = new Map();
    actualItems.forEach((item) => present.set(item.itemId, item));
    actualIds = [...present.keys()];
    missingHeads = expectedHeads
      .filter((entry) => !present.has(entry.itemId))
      .map((entry) => ({ itemId: entry.itemId, name: entry.name, expectedBoxNo: entry.boxNo }));
    missingAccessories = expectedAccessories
      .filter((entry) => !present.has(entry.itemId))
      .map((entry) => ({ itemId: entry.itemId, name: entry.name, expectedBoxNo: entry.boxNo }));
    const expectedIds = new Set(manifestEntries(box).map((entry) => entry.itemId));
    extraItems = actualItems.filter((item) => !expectedIds.has(item.itemId));
  }

  const discrepancies = [];
  if (sealMismatch) {
    discrepancies.push({ type: '封签不符', expectedSealNo: box.sealNo, actualSealNo: submittedSeal });
  }
  wrongBoxes.forEach((item) => discrepancies.push({ type: '错箱', ...item }));
  missingHeads.forEach((item) => discrepancies.push({ type: '缺件', itemType: 'head', ...item }));
  missingAccessories.forEach((item) => discrepancies.push({ type: '缺件', itemType: 'accessory', ...item }));

  const canPerform = discrepancies.length === 0;
  const nextStatus = canPerform ? READY_STATUS : REVIEW_STATUS;
  const timestamp = db.now();

  const arrival = {
    arrivedAt: timestamp,
    receiver,
    actor: actor || '',
    actualSealNo: submittedSeal,
    sealIntact: submittedSeal === null ? true : !sealMismatch,
    sealMismatch,
    actualBoxes,
    actualItems: actualIds,
    wrongBoxes,
    missingHeads,
    missingAccessories,
    extraItems,
    canPerform,
    discrepancies,
    // 可演出的解封资格也只是“当前有效”：一旦发生更正即被置为 false 留档。
    valid: canPerform
  };

  const nextData = {
    ...box,
    status: nextStatus,
    arrivals: [arrival, ...(box.arrivals || [])],
    canPerform,
    qualificationNote: canPerform
      ? '到场核对无误，具备演出资格'
      : '封签/箱号/清单不符，转待复核，不得演出'
  };

  db.transact(db.buildStatements([
    {
      type: 'updateRecord',
      id: boxId,
      collection: COLLECTION,
      status: nextStatus,
      title: titleFor(nextData),
      data: nextData,
      updatedAt: timestamp
    },
    {
      type: 'insertEvent',
      recordId: boxId,
      collection: COLLECTION,
      action: canPerform ? '到场解封-可演出' : '到场解封-待复核',
      status: nextStatus,
      actor: actor || '',
      note: receiver + ' 接收' + (canPerform ? '，核对无误' : '，不符待复核'),
      data: { receiver, sealMismatch, wrongBoxes, missingHeads, missingAccessories, extraItems },
      createdAt: timestamp
    }
  ]));

  return db.getRecord(COLLECTION, boxId);
}

// ---------- 更正后失效留档 ----------

async function correctOnce(boxId, input, actor) {
  const box = db.getRecord(COLLECTION, boxId);
  if (!box) throw new HttpError(404, '装箱单不存在');
  if (box.status === CLOSED_STATUS) {
    throw new HttpError(409, '装箱单已闭环，不能再更正');
  }

  const hasSeal = input.sealNo !== undefined;
  const hasBoxes = input.boxes !== undefined;
  const hasManifest = input.headIds !== undefined || input.accessoryIds !== undefined;
  if (!hasSeal && !hasBoxes && !hasManifest) {
    throw new HttpError(400, '未提供任何更正内容（sealNo / boxes / headIds / accessoryIds）');
  }

  const newSealNo = hasSeal ? String(input.sealNo) : null;
  if (hasSeal && !newSealNo) throw new HttpError(400, '封签号不能为空');
  if (hasSeal && newSealNo === box.sealNo) {
    throw new HttpError(400, '新封签号与原封签号相同，未形成更正');
  }
  if ((hasBoxes || hasManifest) && !hasSeal) {
    // 动箱号或清单即破坏原封签所封状态，必须随附新封签重新封存。
    throw new HttpError(409, '更正箱号或清单必须同时更换封签后重新到场解封');
  }
  if (newSealNo) {
    const conflict = findSealConflict(newSealNo, boxId);
    if (conflict) {
      throw new HttpError(409, '新封签号在未结束装箱单中已被占用', {
        conflictBoxId: conflict.id,
        sealNo: newSealNo
      });
    }
  }

  const oldEntries = manifestEntries(box);
  const oldHeadIds = new Set(oldEntries.filter((e) => e.itemType === 'head').map((e) => e.itemId));
  const oldAccessoryIds = new Set(oldEntries.filter((e) => e.itemType === 'accessory').map((e) => e.itemId));

  let nextHeadIds = [...oldHeadIds];
  let nextAccessoryIds = [...oldAccessoryIds];
  if (hasManifest) {
    nextHeadIds = Array.isArray(input.headIds)
      ? input.headIds.map(String)
      : [...oldHeadIds];
    nextAccessoryIds = Array.isArray(input.accessoryIds)
      ? input.accessoryIds.map(String)
      : [...oldAccessoryIds];
    if (uniqueArray(nextHeadIds).length !== nextHeadIds.length ||
        uniqueArray(nextAccessoryIds).length !== nextAccessoryIds.length) {
      throw new HttpError(400, '更正清单存在重复条目');
    }
  }

  const removedHeads = [...oldHeadIds].filter((id) => !nextHeadIds.includes(id));
  const removedAccessories = [...oldAccessoryIds].filter((id) => !nextAccessoryIds.includes(id));
  const addedHeads = nextHeadIds.filter((id) => !oldHeadIds.has(id));
  const addedAccessories = nextAccessoryIds.filter((id) => !oldAccessoryIds.has(id));

  // 新增件仍按装箱前标准核对：状态、箱号、是否已在其它未结束装箱单中。
  const declaredBoxes = hasBoxes && input.boxes && typeof input.boxes === 'object' ? input.boxes : {};
  const { problems, resolvedHeads, resolvedAccessories } = checkPackableItems({
    headIds: addedHeads,
    accessoryIds: addedAccessories,
    declaredBoxes,
    excludeBoxId: boxId
  });
  if (problems.length) {
    throw new HttpError(409, '更正清单核对未通过，更正未写入', { problems });
  }

  // 用更正后的清单重建快照：保留旧条目的箱号，再由 boxes 覆盖，新增件取档案箱号。
  const resolvedHeadMap = new Map(resolvedHeads.map((item) => [item.head.id, item]));
  const resolvedAccessoryMap = new Map(resolvedAccessories.map((item) => [item.accessory.id, item]));
  const rebuildEntry = (itemType, itemId) => {
    const old = oldEntries.find((entry) => entry.itemType === itemType && entry.itemId === itemId);
    if (old) {
      const overriddenBoxNo = declaredBoxes[itemId] !== undefined ? declaredBoxes[itemId] : old.boxNo;
      return { ...old, boxNo: overriddenBoxNo };
    }
    if (itemType === 'head') {
      const resolved = resolvedHeadMap.get(itemId);
      return {
        itemType,
        itemId,
        name: resolved.head.role,
        play: resolved.head.play,
        boxNo: resolved.boxNo,
        packedStatus: resolved.head.status
      };
    }
    const resolved = resolvedAccessoryMap.get(itemId);
    return {
      itemType,
      itemId,
      name: resolved.accessory.name,
      play: resolved.accessory.play,
      boxNo: resolved.boxNo,
      packedStatus: resolved.accessory.status
    };
  };
  const newManifest = [
    ...nextHeadIds.map((id) => rebuildEntry('head', id)),
    ...nextAccessoryIds.map((id) => rebuildEntry('accessory', id))
  ];

  // 仅更正箱号（不动清单）时，对清单内全部条目套用 boxes 覆盖。
  if (!hasManifest && hasBoxes) {
    newManifest.splice(0, newManifest.length, ...oldEntries.map((entry) => {
      const overriddenBoxNo = declaredBoxes[entry.itemId] !== undefined ? declaredBoxes[entry.itemId] : entry.boxNo;
      return { ...entry, boxNo: overriddenBoxNo };
    }));
  }

  const timestamp = db.now();
  const previousArrivals = (box.arrivals || []).map((arrival) => ({
    ...arrival,
    valid: false,
    invalidatedAt: timestamp,
    invalidateReason: '装箱单信息已更正'
  }));

  const correction = {
    correctedAt: timestamp,
    actor: actor || '',
    note: input.note || '',
    previousSealNo: box.sealNo,
    newSealNo,
    boxes: declaredBoxes,
    removedHeads,
    removedAccessories,
    addedHeads,
    addedAccessories,
    previousArrivalCount: previousArrivals.length
  };

  const nextData = {
    ...box,
    status: REVIEW_STATUS,
    manifest: newManifest,
    sealNo: newSealNo || box.sealNo,
    sealedAt: newSealNo ? timestamp : box.sealedAt,
    sealedBy: newSealNo ? (actor || box.sealedBy || null) : box.sealedBy,
    arrivals: previousArrivals,
    corrections: [correction, ...(box.corrections || [])],
    canPerform: false,
    qualificationNote: '原解封及演出资格已随更正失效留档，须重新到场解封'
  };

  const ops = [
    {
      type: 'updateRecord',
      id: boxId,
      collection: COLLECTION,
      status: REVIEW_STATUS,
      title: titleFor(nextData),
      data: nextData,
      updatedAt: timestamp
    },
    {
      type: 'insertEvent',
      recordId: boxId,
      collection: COLLECTION,
      action: '更正-原解封与演出资格失效',
      status: REVIEW_STATUS,
      actor: actor || '',
      note: input.note || '原解封记录留档，须重新到场解封',
      data: correction,
      createdAt: timestamp
    }
  ];

  // 撤出清单的偶头/配件恢复在库；新增件置为已装箱。
  removedHeads.forEach((headId) => {
    const head = db.getRecord(HEAD_COLLECTION, headId);
    if (!head) return;
    const nextHead = { ...head, status: HEAD_USABLE_STATUS, currentUsable: true };
    ops.push({
      type: 'updateRecord',
      id: headId,
      collection: HEAD_COLLECTION,
      status: HEAD_USABLE_STATUS,
      title: [head.role, head.play].filter(Boolean).join(' / '),
      data: nextHead,
      updatedAt: timestamp
    });
    ops.push({
      type: 'insertEvent',
      recordId: headId,
      collection: HEAD_COLLECTION,
      action: '更正撤出',
      status: HEAD_USABLE_STATUS,
      actor: actor || '',
      note: '装箱单 ' + boxId + ' 更正后撤出，恢复可演出',
      data: { tourBoxId: boxId },
      createdAt: timestamp
    });
  });

  removedAccessories.forEach((accessoryId) => {
    const accessory = db.getRecord(ACCESSORY_COLLECTION, accessoryId);
    if (!accessory) return;
    const nextAccessory = { ...accessory, status: ACCESSORY_USABLE_STATUS };
    ops.push({
      type: 'updateRecord',
      id: accessoryId,
      collection: ACCESSORY_COLLECTION,
      status: ACCESSORY_USABLE_STATUS,
      title: [accessory.name, accessory.role].filter(Boolean).join(' / '),
      data: nextAccessory,
      updatedAt: timestamp
    });
    ops.push({
      type: 'insertEvent',
      recordId: accessoryId,
      collection: ACCESSORY_COLLECTION,
      action: '更正撤出',
      status: ACCESSORY_USABLE_STATUS,
      actor: actor || '',
      note: '装箱单 ' + boxId + ' 更正后撤出，恢复在库',
      data: { tourBoxId: boxId },
      createdAt: timestamp
    });
  });

  resolvedHeads.forEach(({ head }) => {
    const nextHead = { ...head, status: '已装箱' };
    ops.push({
      type: 'updateRecord',
      id: head.id,
      collection: HEAD_COLLECTION,
      status: '已装箱',
      title: [head.role, head.play].filter(Boolean).join(' / '),
      data: nextHead,
      updatedAt: timestamp
    });
    ops.push({
      type: 'insertEvent',
      recordId: head.id,
      collection: HEAD_COLLECTION,
      action: '更正补入',
      status: '已装箱',
      actor: actor || '',
      note: '装箱单 ' + boxId + ' 更正后补入',
      data: { tourBoxId: boxId },
      createdAt: timestamp
    });
  });

  resolvedAccessories.forEach(({ accessory }) => {
    const nextAccessory = { ...accessory, status: '已装箱' };
    ops.push({
      type: 'updateRecord',
      id: accessory.id,
      collection: ACCESSORY_COLLECTION,
      status: '已装箱',
      title: [accessory.name, accessory.role].filter(Boolean).join(' / '),
      data: nextAccessory,
      updatedAt: timestamp
    });
    ops.push({
      type: 'insertEvent',
      recordId: accessory.id,
      collection: ACCESSORY_COLLECTION,
      action: '更正补入',
      status: '已装箱',
      actor: actor || '',
      note: '装箱单 ' + boxId + ' 更正后补入',
      data: { tourBoxId: boxId },
      createdAt: timestamp
    });
  });

  db.transact(db.buildStatements(ops));
  return db.getRecord(COLLECTION, boxId);
}

// ---------- 闭环（结束装箱单） ----------

async function closeOnce(boxId, input, actor) {
  const box = db.getRecord(COLLECTION, boxId);
  if (!box) throw new HttpError(404, '装箱单不存在');
  if (box.status === CLOSED_STATUS) return box;

  const timestamp = db.now();
  const nextData = {
    ...box,
    status: CLOSED_STATUS,
    closedAt: timestamp,
    qualificationNote: box.canPerform ? '已结束：曾具备演出资格' : '已结束：未取得演出资格'
  };

  const ops = [
    {
      type: 'updateRecord',
      id: boxId,
      collection: COLLECTION,
      status: CLOSED_STATUS,
      title: titleFor(nextData),
      data: nextData,
      updatedAt: timestamp
    },
    {
      type: 'insertEvent',
      recordId: boxId,
      collection: COLLECTION,
      action: '闭环',
      status: CLOSED_STATUS,
      actor: actor || '',
      note: (input && input.note) || '',
      data: {},
      createdAt: timestamp
    }
  ];

  // 闭环即巡演结束：清单内物件返库，封签号随之释放（可被后续装箱单使用）。
  manifestEntries(box).forEach((entry) => {
    const collection = entry.itemType === 'head' ? HEAD_COLLECTION : ACCESSORY_COLLECTION;
    const usableStatus = entry.itemType === 'head' ? HEAD_USABLE_STATUS : ACCESSORY_USABLE_STATUS;
    const item = db.getRecord(collection, entry.itemId);
    if (!item || item.status !== '已装箱') return;
    const restored = entry.itemType === 'head'
      ? { ...item, status: usableStatus, currentUsable: true }
      : { ...item, status: usableStatus };
    ops.push({
      type: 'updateRecord',
      id: item.id,
      collection,
      status: usableStatus,
      title: entry.itemType === 'head'
        ? [item.role, item.play].filter(Boolean).join(' / ')
        : [item.name, item.role].filter(Boolean).join(' / '),
      data: restored,
      updatedAt: timestamp
    });
    ops.push({
      type: 'insertEvent',
      recordId: item.id,
      collection,
      action: '巡演闭环返库',
      status: usableStatus,
      actor: actor || '',
      note: '随装箱单 ' + boxId + ' 返库',
      data: { tourBoxId: boxId },
      createdAt: timestamp
    });
  });

  db.transact(db.buildStatements(ops));
  return db.getRecord(COLLECTION, boxId);
}

// ---------- 查询：列表 / 装箱履历 ----------

function applyBoxQuery(boxes, query) {
  return boxes.filter((box) => {
    if (query.status && box.status !== query.status) return false;
    if (query.sealNo && box.sealNo !== query.sealNo) return false;
    if (query.showName && !String(box.showName || '').includes(String(query.showName))) return false;
    if (query.play && box.play !== query.play) return false;
    if (query.venue && !String(box.venue || '').includes(String(query.venue))) return false;
    return true;
  });
}

function listBoxes(query) {
  const boxes = db.listRecords(COLLECTION);
  return applyBoxQuery(boxes, query || {});
}

function getBox(boxId) {
  const box = db.getRecord(COLLECTION, boxId);
  if (!box) throw new HttpError(404, '装箱单不存在');
  return box;
}

// 装箱履历 = 该装箱单事件流；同时给出最新状态，便于校验“刷新后一致”。
function boxTimeline(boxId) {
  const box = getBox(boxId);
  const events = db.listEvents(boxId);
  return { record: box, events };
}

module.exports = {
  HttpError,
  COLLECTION,
  // 所有写操作在存储写锁内串行：读-判定-写在同一临界区内完成。
  packBoxes: locked(packBoxes),
  sealBox: locked(sealBoxOnce),
  arriveBox: locked(arriveOnce),
  correctBox: locked(correctOnce),
  closeBox: locked(closeOnce),
  listBoxes,
  getBox,
  boxTimeline
};
