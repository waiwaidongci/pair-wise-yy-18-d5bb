const express = require('express');
const { randomUUID } = require('crypto');
const db = require('./lib/storage/db');
const tourRoutes = require('./lib/entry/tourRoutes');
const config = require('./project.config');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter((field) => data[field] === undefined || data[field] === '');
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
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

function loadRecord(collection, id) {
  const row = db.selectOne(
    'SELECT * FROM records WHERE collection = ' + db.sqlValue(collection) + ' AND id = ' + db.sqlValue(id) + ' LIMIT 1;'
  );
  return row ? toRecord(row) : null;
}

function insertEvent({ recordId, collection, action, status, actor, note, data }) {
  db.mutate([
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
    [
      db.sqlValue(randomUUID()),
      db.sqlValue(recordId),
      db.sqlValue(collection),
      db.sqlValue(action || '记录'),
      db.sqlValue(status || ''),
      db.sqlValue(actor || ''),
      db.sqlValue(note || ''),
      db.sqlValue(JSON.stringify(data || {})),
      db.sqlValue(db.now())
    ].join(', ') +
    ');'
  ]);
}

function saveRecord(collection, id, data, status) {
  const collectionConfig = findCollection(collection);
  db.mutate([
    'UPDATE records SET status = ' + db.sqlValue(status) +
    ', title = ' + db.sqlValue(titleFor(collectionConfig, data)) +
    ', data = ' + db.sqlValue(JSON.stringify(data)) +
    ', updated_at = ' + db.sqlValue(db.now()) +
    ' WHERE collection = ' + db.sqlValue(collection) + ' AND id = ' + db.sqlValue(id) + ';'
  ]);
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

// 装箱单的写入必须走专用业务接口（封箱/到场/更正/闭环），避免绕过判定
function guardTourBoxWrites(req, res, next) {
  if (req.params.collection === 'tourBoxes' && req.method !== 'GET') {
    return res.status(405).json({
      error: 'tourBoxes 写操作请使用专用接口',
      endpoints: [
        'POST /api/tourBoxes',
        'POST /api/tourBoxes/:id/seal',
        'POST /api/tourBoxes/:id/arrival',
        'POST /api/tourBoxes/:id/correct',
        'POST /api/tourBoxes/:id/close',
        'GET  /api/tourBoxes/:id/history'
      ]
    });
  }
  next();
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

// 入口层：装箱业务模块（必须挂在通用 /api/:collection 之前）
app.use('/api/tourBoxes', tourRoutes);

app.get('/api/:collection', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const rows = db.select(
      'SELECT * FROM records WHERE collection = ' + db.sqlValue(req.params.collection) + ' ORDER BY updated_at DESC;'
    ).map(toRecord);
    const filtered = applyQuery(rows, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', guardTourBoxWrites, (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    validate(collectionConfig, data);
    const id = randomUUID();
    const createdAt = db.now();
    db.mutate([
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
      [
        db.sqlValue(id),
        db.sqlValue(req.params.collection),
        db.sqlValue(status),
        db.sqlValue(titleFor(collectionConfig, data)),
        db.sqlValue(JSON.stringify(data)),
        db.sqlValue(createdAt),
        db.sqlValue(createdAt)
      ].join(', ') + ');'
    ]);
    insertEvent({
      recordId: id,
      collection: req.params.collection,
      action: req.body.action || '创建',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data
    });
    res.status(201).json(loadRecord(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', guardTourBoxWrites, (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;
    saveRecord(req.params.collection, req.params.id, nextData, status);
    insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || '更新',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', guardTourBoxWrites, (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
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
    saveRecord(req.params.collection, req.params.id, nextData, status);
    insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || status || '记录',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const events = db.select(
      'SELECT * FROM events WHERE record_id = ' + db.sqlValue(req.params.id) + ' ORDER BY created_at ASC;'
    ).map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
    res.json({ record, events });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', guardTourBoxWrites, (req, res, next) => {
  try {
    findCollection(req.params.collection);
    db.mutate([
      'DELETE FROM records WHERE collection = ' + db.sqlValue(req.params.collection) + ' AND id = ' + db.sqlValue(req.params.id) + ';',
      'DELETE FROM events WHERE record_id = ' + db.sqlValue(req.params.id) + ';'
    ]);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// 判定层错误统一映射
app.use((error, req, res, next) => {
  if (error && error.status) {
    return res.status(error.status).json({
      error: error.message || 'business error',
      code: error.code || 'BUSINESS_ERROR',
      ...(error.details ? { details: error.details } : {})
    });
  }
  res.status(500).json({ error: error.message || 'server error' });
});

db.initDb().then(() => {
  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
  });
}).catch((error) => {
  console.error('failed to initialize database:', error);
  process.exit(1);
});
