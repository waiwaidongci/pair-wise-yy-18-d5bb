'use strict';

// 补充验收：跨单并发抢同一封签号、重启（刷新进程）后状态与履历一致。
// 用法：
//   node scripts/e2e-extra.js                 # 造数据 + 并发抢号，落快照
//   （重启服务）
//   RESTART_CHECK=1 node scripts/e2e-extra.js # 仅比对重启后一致性
const fs = require('fs');
const os = require('os');
const BASE = process.env.BASE || 'http://localhost:3914';
const SNAP = path2snap();

function path2snap() {
  return require('path').join(os.tmpdir(), 'e2e-extra-snapshot.json');
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-actor': 'e2e-extra' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

(async () => {
  let failed = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (!cond && extra ? ' => ' + JSON.stringify(extra) : ''));
    if (!cond) failed++;
  };

  if (process.env.RESTART_CHECK === '1') {
    const snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
    const allAfter = (await api('GET', '/api/tourBoxes')).json;
    let same = true;
    for (const s of snap.orders) {
      const cur = allAfter.find((o) => o.id === s.id);
      if (!cur || cur.status !== s.status || cur.sealNo !== s.sealNo || !!cur.performanceAllowed !== !!s.performanceAllowed) same = false;
    }
    check('重启后全部装箱单状态/封签/演出资格与重启前一致', same && allAfter.length >= snap.orders.length, { snap: snap.orders.length, now: allAfter.length });
    const histA = (await api('GET', `/api/tourBoxes/${snap.idA}/history`)).json.events.map((e) => e.action);
    check('重启后装箱履历事件齐全', JSON.stringify(histA) === JSON.stringify(snap.histA), { snap: snap.histA, now: histA });

    const c = await api('POST', '/api/tourBoxes', { showName: '重启后新单', venue: 'V', play: '火焰山', headIds: [], accessoryIds: ['accessory-seed-3'] });
    const conflict = await api('POST', `/api/tourBoxes/${c.json.id}/seal`, { sealNo: 'SEAL-RACE-X' });
    check('重启后未结束单的封签仍保持唯一', conflict.status === 409 && conflict.json.code === 'SEAL_CONFLICT', conflict.json);
    process.exit(failed ? 1 : 0);
  }

  // 两张草稿单（占用互不重叠的空闲档案）
  const a = await api('POST', '/api/tourBoxes', { showName: '并发抢号A', venue: 'V', play: '火焰山', headIds: ['head-seed-3'], accessoryIds: [] });
  const b = await api('POST', '/api/tourBoxes', { showName: '并发抢号B', venue: 'V', play: '火焰山', headIds: [], accessoryIds: ['accessory-seed-2'] });
  const idA = a.json.id, idB = b.json.id;

  // 真正同时抢同一个封签号
  const [r1, r2] = await Promise.all([
    api('POST', `/api/tourBoxes/${idA}/seal`, { sealNo: 'SEAL-RACE-X' }),
    api('POST', `/api/tourBoxes/${idB}/seal`, { sealNo: 'SEAL-RACE-X' })
  ]);
  const winners = [r1, r2].filter((r) => r.status === 200);
  const losers = [r1, r2].filter((r) => r.status === 409);
  check('跨单并发抢号：恰好一单成功', winners.length === 1, { r1: r1.status, r2: r2.status });
  check('跨单并发抢号：另一单 409 且为 SEAL_CONFLICT', losers.length === 1 && losers[0].json.code === 'SEAL_CONFLICT', losers[0]?.json);
  const loserId = r1.status === 409 ? idA : idB;
  const loserDetail = (await api('GET', `/api/tourBoxes/${loserId}`)).json;
  check('败单保持草稿、无封签、无部分写入', loserDetail.status === '草稿' && loserDetail.sealNo === null, loserDetail);

  const own = await api('POST', `/api/tourBoxes/${loserId}/seal`, { sealNo: 'SEAL-RACE-Y' });
  check('败单可用其它封签号完成封箱', own.status === 200, own.json);

  const allBefore = (await api('GET', '/api/tourBoxes')).json;
  const snapshot = {
    idA, idB,
    orders: allBefore.map((o) => ({ id: o.id, status: o.status, sealNo: o.sealNo, performanceAllowed: o.performanceAllowed })),
    histA: (await api('GET', `/api/tourBoxes/${idA}/history`)).json.events.map((e) => e.action)
  };
  fs.writeFileSync(SNAP, JSON.stringify(snapshot, null, 2));
  console.log('快照已写入 ' + SNAP + '，重启服务后执行 RESTART_CHECK=1 node scripts/e2e-extra.js');

  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
