// 启动/装配层：建库、种子、路由挂载与统一错误处理。
// 巡演装箱的业务入口统一在 /api/tourBoxes/*（src/tour/routes.js），
// 判定规则在 src/tour/service.js，读写与事务在 src/storage/db.js。
const express = require('express');
const { randomUUID } = require('crypto');
const config = require('./project.config');
const db = require('./src/storage/db');
const tourRouter = require('./src/tour/routes');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter(
    (field) => data[field] === undefined || data[field] === ''
  );
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

async function seedDatabase() {
  db.initSchema();
  if (db.countRecords() > 0) return;

  const ops = [];
  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const id = seed.id || randomUUID();
    const createdAt = seed.createdAt || db.now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    ops.push({
      type: 'insertRecord',
      id,
      collection: seed.collection,
      status,
      title: titleFor(collectionConfig, data),
      data,
      createdAt,
      updatedAt: seed.updatedAt || createdAt
    });
    ops.push({
      type: 'insertEvent',
      recordId: id,
      collection: seed.collection,
      action: seed.eventAction || '创建',
      status,
      actor: seed.actor || 'system',
      note: seed.note || '',
      data,
      createdAt
    });
  }
  await db.writeAll(ops);
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

// 业务入口模块：装箱、补封签、到场解封、更正、闭环、履历。
// 必须在通用 /api/:collection 路由之前挂载。
app.use('/api/tourBoxes', tourRouter);

// 装箱单有自己的状态机，禁止用通用写入接口绕过“核对/封签/解封”规则；
// 读取仍可走通用接口，保证与专用列表看到的是同一份数据。
function guardTourBoxMutation(req, res, next) {
  if (req.params.collection === 'tourBoxes') {
    return res.status(405).json({
      error: '巡演装箱单请使用专用接口：/api/tourBoxes/pack、/:id/seal、/:id/arrive、/:id/correct、/:id/close'
    });
  }
  next();
}

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

app.get('/api/:collection', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const records = db.listRecords(req.params.collection);
    const filtered = applyQuery(records, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', guardTourBoxMutation, async (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    validate(collectionConfig, data);
    const id = randomUUID();
    const createdAt = db.now();
    await db.writeAll([
      {
        type: 'insertRecord',
        id,
        collection: req.params.collection,
        status,
        title: titleFor(collectionConfig, data),
        data,
        createdAt
      },
      {
        type: 'insertEvent',
        recordId: id,
        collection: req.params.collection,
        action: req.body.action || '创建',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data,
        createdAt
      }
    ]);
    res.status(201).json(db.getRecord(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = db.getRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', guardTourBoxMutation, async (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = db.getRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;
    const collectionConfig = findCollection(req.params.collection);
    const timestamp = db.now();
    await db.writeAll([
      {
        type: 'updateRecord',
        id: req.params.id,
        collection: req.params.collection,
        status,
        title: titleFor(collectionConfig, nextData),
        data: nextData,
        updatedAt: timestamp
      },
      {
        type: 'insertEvent',
        recordId: req.params.id,
        collection: req.params.collection,
        action: req.body.action || '更新',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body,
        createdAt: timestamp
      }
    ]);
    res.json(db.getRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', guardTourBoxMutation, async (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const record = db.getRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    const nextData = { ...record, ...(req.body.fields || {}), status };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const timestamp = db.now();
    await db.writeAll([
      {
        type: 'updateRecord',
        id: req.params.id,
        collection: req.params.collection,
        status,
        title: titleFor(collectionConfig, nextData),
        data: nextData,
        updatedAt: timestamp
      },
      {
        type: 'insertEvent',
        recordId: req.params.id,
        collection: req.params.collection,
        action: req.body.action || status || '记录',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body,
        createdAt: timestamp
      }
    ]);
    res.json(db.getRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

// 履历：装箱单与偶头/配件共用同一条事件流通道，专用路由与之同源。
app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = db.getRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json({ record, events: db.listEvents(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', guardTourBoxMutation, (req, res, next) => {
  // 通用删除保留给其它集合的维护用途；装箱单禁止物理删除，历史必须留档。
  try {
    findCollection(req.params.collection);
    db.transact([
      'DELETE FROM records WHERE collection = ' + db.sqlValue(req.params.collection) +
      ' AND id = ' + db.sqlValue(req.params.id) + ';',
      'DELETE FROM events WHERE record_id = ' + db.sqlValue(req.params.id) + ';'
    ]);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// 统一错误出口：业务判定抛出的 HttpError 携带 status（409/400/404/405）。
app.use((error, req, res, next) => {
  const payload = { error: error.message || 'server error' };
  if (error.details) payload.details = error.details;
  res.status(error.status || 500).json(payload);
});

seedDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(config.title + ' API running at http://localhost:' + PORT);
    });
  })
  .catch((error) => {
    console.error('启动失败：', error);
    process.exit(1);
  });

module.exports = app;
