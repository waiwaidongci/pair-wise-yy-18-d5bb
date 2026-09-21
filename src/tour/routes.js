// 入口模块（巡演装箱）：只做 HTTP 入参/出参与路由分发，业务判定全部委托 service。
const express = require('express');
const service = require('./service');

const router = express.Router();

function actorOf(req) {
  return req.body && (req.body.actor || req.body.operator) ? (req.body.actor || req.body.operator) : '';
}

// 统一承接 async 判定函数抛出的 HttpError，交给 server.js 的错误中间件。
function asyncHandler(handler, successStatus) {
  return async (req, res, next) => {
    try {
      const result = await handler(req);
      if (successStatus) res.status(successStatus(req, result));
      res.json(result);
    } catch (error) {
      next(error);
    }
  };
}

// 装箱（创建装箱单）：核对偶头配件状态与箱号，不符返回 409 且整单不写入。
router.post('/pack', asyncHandler(
  (req) => service.packBoxes(req.body || {}, actorOf(req)).then(({ box }) => box),
  () => 201
));

// 装箱单列表：支持 status / sealNo / showName / play / venue 过滤。
router.get('/', (req, res, next) => {
  try {
    res.json(service.listBoxes(req.query));
  } catch (error) {
    next(error);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    res.json(service.getBox(req.params.id));
  } catch (error) {
    next(error);
  }
});

// 补封签：封签号在未结束装箱单中唯一；已封箱（含并发/重试）沿用首次结果。
router.post('/:id/seal', asyncHandler(
  (req) => service.sealBox(req.params.id, req.body || {}, actorOf(req))
    .then((result) => ({ ...result.box, _reusedFirstSeal: result.reused })),
  (req, result) => (result._reusedFirstSeal ? 200 : 201)
));

// 到场解封：登记接收人、实到清单与封签状态；不符只转待复核，不得演出。
router.post('/:id/arrive', asyncHandler(
  (req) => service.arriveBox(req.params.id, req.body || {}, actorOf(req)),
  () => 201
));

// 更正箱号/清单/封签：原解封记录及演出资格失效留档，须重新到场解封。
router.post('/:id/correct', asyncHandler(
  (req) => service.correctBox(req.params.id, req.body || {}, actorOf(req))
));

// 闭环：结束装箱单，释放封签号占用与偶头/配件占用。
router.post('/:id/close', asyncHandler(
  (req) => service.closeBox(req.params.id, req.body || {}, actorOf(req))
));

// 装箱履历：与通用 GET /api/:collection/:id/timeline 同源，刷新后状态一致。
router.get('/:id/timeline', (req, res, next) => {
  try {
    res.json(service.boxTimeline(req.params.id));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
