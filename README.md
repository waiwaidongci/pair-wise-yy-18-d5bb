# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪，支持巡演装箱的封签管理与到场解封流程。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

数据库为 SQLite（WASM 版 sql.js），每次写事务提交后落盘到 `data/app.db`（原子写：先写临时文件再 rename）。

## 模块分层

| 层 | 目录 | 职责 |
| --- | --- | --- |
| 入口 | `lib/entry/tourRoutes.js` | HTTP 路由、参数形状校验、错误状态码映射 |
| 判定 | `lib/domain/tourService.js` | 装箱核对、封签唯一与并发幂等、到场解封判定、更正失效留档、闭环 |
| 存储 | `lib/storage/` | `db.js`（表/事务/落盘）、`tourStore.js`（装箱单语句）、`inventoryStore.js`（偶头配件语句） |

状态只有一份来源：records 表 + events 履历，所有变更在同一事务内提交，因此列表、装箱履历与刷新后状态始终一致。

## 巡演装箱接口

### 建单（装箱前核对）

`POST /api/tourBoxes`

```json
{
  "showName": "泉州场",
  "venue": "泉州木偶剧院",
  "play": "火焰山",
  "headIds": ["head-seed-2"],
  "accessoryIds": ["accessory-seed-2"],
  "headBoxNos": { "head-seed-2": "木箱甲-01" },
  "accessoryBoxNos": {},
  "actor": "箱头阿明"
}
```

装箱前逐项核对偶头/配件：

- 偶头须为「可演出」、配件须为「在库」；
- 清单箱号与档案箱号一致（未填则以档案箱号为准）；
- 不得与其它未结束装箱单重复占用同一档案。

任一项不符返回 **409**（`MANIFEST_MISMATCH`，body 中给出全部问题），**整单不写入**。

### 封箱补封签

`POST /api/tourBoxes/:id/seal` — body：`{ "sealNo": "SEAL-2026-001" }`

- 封签号在所有**未结束**装箱单（草稿/已装箱/巡演中/待复核/已解封）中唯一，重复返回 **409**（`SEAL_CONFLICT`）；
- 封箱前再次核对档案状态与箱号，漂移则 409 且封箱结果不写入；
- 偶头/配件同步置为「已装箱」并记录占用；
- **并发封箱沿用首次结果**：同号重复/并发请求幂等返回（`reused: true`），异号返回 **409**（`SEAL_MISMATCH`）；跨单抢同一号时恰有一单成功，另一单 409 且无部分写入。

### 到场解封登记

`POST /api/tourBoxes/:id/arrival`

```json
{
  "receiver": "剧场李经理",
  "sealNo": "SEAL-2026-001",
  "sealStatus": "完好",
  "arrivedHeadIds": ["head-seed-2"],
  "arrivedAccessoryIds": ["accessory-seed-2"],
  "observedBoxes": { "head-seed-2": "木箱甲-01" }
}
```

`sealStatus` 仅支持 `完好` / `异常`。判定问题类型：

| 问题 | 条件 |
| --- | --- |
| 封签不符 | 到场封签号 ≠ 装箱封签号 |
| 封签异常 | sealStatus = 异常 |
| 缺件 | 装箱清单有、实到清单无 |
| 多件 | 实到清单有、装箱清单无（错箱） |
| 错箱 | 实物箱号 ≠ 清单箱号 |

只要存在任一问题：单据转 **待复核**、`performanceAllowed=false`，**不得演出**；全部通过：转 **已解封**、可演出。响应中带 `problems` 明细，重复到场登记会把上一次解封记录归档到 `archivedArrivals`。

### 更正（箱号 / 清单 / 封签）

`POST /api/tourBoxes/:id/correct` — body 可含 `headIds`、`accessoryIds`、`headBoxNos`、`accessoryBoxNos`、`sealNo`、`reason`

- 封签更正同样遵守未结束单唯一约束，旧号释放、新号占号；
- 清单增删会同步占用/释放偶头配件；
- **更正生效后，原解封结果与演出资格立即失效**，单据转待复核，原解封记录（含问题明细、接收人）写入 `archivedArrivals` 留档，履历记录「装箱更正·解封失效」；须按更正后信息重新到场解封方可演出。

### 闭环

`POST /api/tourBoxes/:id/close` — 释放封签占号（号码可被新单复用）与偶头配件占用（偶头回「可演出」、配件回「在库」）。

### 查询

- `GET /api/tourBoxes` — 装箱单列表（支持 `?status=` 等过滤）
- `GET /api/tourBoxes/:id` — 详情（刷新后状态与列表同源）
- `GET /api/tourBoxes/:id/history` — 装箱履历（建单 / 封箱加签 / 到场解封 / 更正 / 闭环）

通用 `PATCH /api/tourBoxes/...` 与 `/events` 直写被拒绝（405），必须走上述业务接口。

## 验收脚本

```bash
npm test                 # 43 项端到端规则（需先启动服务）
node scripts/e2e-extra.js # 跨单并发抢号 + 落快照
# 重启服务后：
RESTART_CHECK=1 node scripts/e2e-extra.js
```

## 其他常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`
