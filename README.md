# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱封签、到场解封与返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

> 存储使用 SQLite。优先调用系统 `sqlite3` CLI；环境缺少该可执行文件时，
> 自动回退到随仓库附带的 `src/storage/sqlite_shim.py`（依赖 Python3 标准库）。
> 数据库文件首次启动时创建在 `data/app.db`。

## 模块划分

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 入口 | `src/tour/routes.js` | HTTP 路由、入参出参、状态码，不含业务判定 |
| 判定 | `src/tour/service.js` | 装箱核对、封签唯一/并发沿用、到场判定、更正失效、闭环 |
| 存储 | `src/storage/db.js` | SQLite 读写、单事务多表原子写、写操作串行队列 |
| 装配 | `server.js` | 建库种子、挂载路由、通用集合 CRUD、统一错误处理 |

## 巡演装箱流程

1. **装箱** `POST /api/tourBoxes/pack`
   - 提交 `showName/venue/play/headIds/accessoryIds`，可附 `boxes`（按物件 id 申报实际箱号）。
   - 装箱前核对偶头/配件的**状态**（偶头须可演出、配件须在库）与**箱号**（申报须与档案一致），
     并拦截已在其它未结束装箱单中的物件。
   - **任一不符返回 `409`，整单不写入**（偶头/配件状态也不变更）。核对通过才建单，
     清单内偶头/配件同时置为“已装箱”。
2. **补封签** `POST /api/tourBoxes/:id/seal`，body `{ "sealNo": "..." }`
   - 封签号在**未结束（未闭环）装箱单**中唯一，重复占用返回 `409`。
   - **并发/重试封箱沿用首次结果**：同号返回 `200`（`_reusedFirstSeal: true`），
     首封返回 `201`；不同封签号返回 `409`，首封结果不可覆盖。
3. **到场解封** `POST /api/tourBoxes/:id/arrive`
   - 登记 `receiver`（接收人，必填）、`actualSeal`（实到封签号）、
     `actualItems`（实到清单 id 数组）、`boxes`（到场箱号）。
   - 封签不符、错箱、缺件任一时只转为 **`待复核`，`canPerform=false`，不得演出**；
     全部一致才转为 `可演出`。每次到场都追加留档（`arrivals`）。
4. **更正** `POST /api/tourBoxes/:id/correct`
   - 可更正 `sealNo`、`boxes`（箱号）、`headIds/accessoryIds`（清单）。
   - 动箱号或清单必须同时更换封签；新封签仍受未结束唯一性约束；新增件按装箱标准重新核对。
   - 更正后**原解封记录及演出资格一律失效并留档**（`arrivals[*].valid=false`，
     记录 `invalidatedAt`/`invalidateReason`，另写 `corrections` 与“更正-原解封与演出资格失效”事件），
     单据回到待复核，必须重新到场解封。撤出的偶头/配件恢复可演出/在库。
5. **闭环** `POST /api/tourBoxes/:id/close`：结束装箱单，释放封签号与物件占用（返库），
   封签号可被后续装箱单复用。

## 查询一致

- `GET /api/tourBoxes`（支持 `status/sealNo/showName/play/venue` 过滤）与
  通用 `GET /api/tourBoxes/` 同源同数据。
- `GET /api/tourBoxes/:id/timeline` 返回最新记录 + 装箱履历（事件流），
  与通用 `GET /api/:collection/:id/timeline` 完全一致；重启/刷新后状态以库中记录为准。

## 其它接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

装箱单的通用 `POST/PATCH/events/DELETE` 已被禁用（返回 `405`），防止绕过核对、
封签与解封状态机；历史不可物理删除，只能走闭环。

## 测试

```bash
# 需先启动服务；脚本会按干净库的前提断言，必要时删除 data/app.db 后重启
npm test
# 或：python3 test/e2e.py
```
