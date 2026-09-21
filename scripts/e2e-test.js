'use strict';

// 端到端验收：装箱核对/409整单不写入、封签唯一与并发幂等、
// 到场解封判定、更正失效留档、闭环释放、刷新一致。
const BASE = process.env.BASE || 'http://localhost:3914';

let passed = 0;
let failed = 0;

function check(name, condition, extra) {
  if (condition) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (extra ? '  => ' + JSON.stringify(extra) : ''));
  }
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-actor': 'e2e-script' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

async function countOrders() {
  const { json } = await api('GET', '/api/tourBoxes');
  return json.length;
}

(async () => {
  console.log('1) 装箱前核对：箱号不符 / 状态不符 -> 409 且整单不写入');
  const before = await countOrders();

  let r = await api('POST', '/api/tourBoxes', {
    showName: '错箱号测试单', venue: '测试台', play: '火焰山',
    headIds: ['head-seed-2'],
    accessoryIds: [],
    headBoxNos: { 'head-seed-2': '木箱乙-99' }
  });
  check('箱号不符返回409', r.status === 409, { status: r.status, body: r.json });
  check('错误类型为箱号不符', r.json?.code === 'MANIFEST_MISMATCH' && r.json.details?.problems?.[0]?.type === '箱号不符', r.json);

  r = await api('POST', '/api/tourBoxes', {
    showName: '坏偶头测试单', venue: '测试台', play: '火焰山',
    headIds: ['head-seed-1'],
    accessoryIds: []
  });
  check('待修补偶头装箱返回409', r.status === 409 && r.json.details.problems.some((p) => p.type === '状态不符'), r.json);

  r = await api('POST', '/api/tourBoxes', {
    showName: '缺档案测试单', venue: '测试台', play: '火焰山',
    headIds: ['not-exist-id'], accessoryIds: []
  });
  check('档案缺失返回409', r.status === 409, r.json);

  const after = await countOrders();
  check('409 后整单不写入（列表数量不变）', before === after, { before, after });

  console.log('2) 正常建单 -> 封箱加签 -> 列表/履历/刷新一致');
  r = await api('POST', '/api/tourBoxes', {
    showName: '泉州场', venue: '泉州木偶剧院', play: '火焰山',
    headIds: ['head-seed-2', 'head-seed-3'],
    accessoryIds: ['accessory-seed-2', 'accessory-seed-3'],
    headBoxNos: { 'head-seed-2': '木箱甲-01', 'head-seed-3': '木箱甲-02' }
  });
  check('核对通过建单201', r.status === 201 && r.json.status === '草稿', r.json);
  const orderId = r.json.id;
  check('箱号快照写入 headBoxMap', r.json.headBoxMap['head-seed-2'] === '木箱甲-01', r.json.headBoxMap);

  r = await api('GET', '/api/puppetHeads/head-seed-2');
  check('建单（草稿）不占用偶头状态', r.json.status === '可演出', r.json);

  r = await api('POST', `/api/tourBoxes/${orderId}/seal`, { sealNo: 'SEAL-2026-001', note: '首演封箱', actor: '箱头阿明' });
  check('封箱成功', r.status === 200 && r.json.record.status === '已装箱' && r.json.record.sealNo === 'SEAL-2026-001' && r.json.reused === false, r.json);

  r = await api('GET', '/api/puppetHeads/head-seed-2');
  check('封箱后偶头状态=已装箱（防止重复占用）', r.json.status === '已装箱' && r.json.tourBoxId === orderId, r.json);

  console.log('3) 封签号唯一 + 并发封箱沿用首次结果');
  // 另一单草稿，使用同一封签号
  let r2 = await api('POST', '/api/tourBoxes', {
    showName: '厦门场', venue: '厦门艺术剧场', play: '火焰山',
    headIds: [],
    accessoryIds: ['accessory-seed-1']
  });
  const order2Id = r2.json.id;
  r = await api('POST', `/api/tourBoxes/${order2Id}/seal`, { sealNo: 'SEAL-2026-001' });
  check('封签号被未结束单占用 -> 409', r.status === 409 && r.json.code === 'SEAL_CONFLICT', r.json);
  check('占号失败后订单仍是草稿（无部分写入）', (await api('GET', `/api/tourBoxes/${order2Id}`)).json.status === '草稿');

  // 重复封箱：同号幂等，异号 409
  r = await api('POST', `/api/tourBoxes/${orderId}/seal`, { sealNo: 'SEAL-2026-001' });
  check('同号重复封箱沿用首次结果 reused=true', r.status === 200 && r.json.reused === true && r.json.record.sealedAt, r.json);
  r = await api('POST', `/api/tourBoxes/${orderId}/seal`, { sealNo: 'SEAL-OTHER' });
  check('异号封箱 -> 409', r.status === 409 && r.json.code === 'SEAL_MISMATCH', r.json);

  // 真并发：同一单同号同时封箱两次（此时已封箱，两次都应幂等返回首次结果）
  const [c1, c2] = await Promise.all([
    api('POST', `/api/tourBoxes/${order2Id}/seal`, { sealNo: 'SEAL-2026-002' }),
    api('POST', `/api/tourBoxes/${order2Id}/seal`, { sealNo: 'SEAL-2026-002' })
  ]);
  check('并发同号封箱均成功', c1.status === 200 && c2.status === 200, { c1: c1.status, c2: c2.status });
  const reusedCount = [c1, c2].filter((x) => x.json.reused === true).length;
  check('并发同号封箱：一次首次、一次沿用', reusedCount === 1, { c1: c1.json.reused, c2: c2.json.reused });
  check('两单各自占号正确', c1.json.record.sealNo === 'SEAL-2026-002' && c2.json.record.sealNo === 'SEAL-2026-002');

  // 真并发：不同封签号抢占同一草稿单（订单2已被002占用，改测 order2 异号）
  const [d1, d2] = await Promise.all([
    api('POST', `/api/tourBoxes/${order2Id}/seal`, { sealNo: 'SEAL-DIFF-A' }),
    api('POST', `/api/tourBoxes/${order2Id}/seal`, { sealNo: 'SEAL-DIFF-B' })
  ]);
  check('已封箱并发异号：至少一个409，另一个幂等/409，无脏写',
    (d1.status === 409 || d2.status === 409), { d1: d1.status, d2: d2.status });

  console.log('4) 到场解封：封签不符/缺件/错箱 -> 待复核，不得演出');
  r = await api('POST', `/api/tourBoxes/${orderId}/arrival`, {
    receiver: '剧场李经理',
    sealNo: 'FAKE-SEAL',
    sealStatus: '完好',
    arrivedHeadIds: ['head-seed-2', 'head-seed-3'],
    arrivedAccessoryIds: ['accessory-seed-2', 'accessory-seed-3']
  });
  check('封签不符 -> 待复核且不得演出', r.status === 200 && r.json.record.status === '待复核' && r.json.performanceAllowed === false, r.json);
  check('问题清单含封签不符', r.json.problems.some((p) => p.type === '封签不符'), r.json.problems);

  r = await api('POST', `/api/tourBoxes/${orderId}/arrival`, {
    receiver: '剧场李经理',
    sealNo: 'SEAL-2026-001',
    sealStatus: '完好',
    arrivedHeadIds: ['head-seed-2'], // 缺 head-seed-3
    arrivedAccessoryIds: ['accessory-seed-2', 'accessory-seed-3']
  });
  check('缺件 -> 待复核', r.json.record.status === '待复核' && r.json.problems.some((p) => p.type === '缺件'), r.json);

  r = await api('POST', `/api/tourBoxes/${orderId}/arrival`, {
    receiver: '剧场李经理',
    sealNo: 'SEAL-2026-001',
    sealStatus: '完好',
    arrivedHeadIds: ['head-seed-2', 'head-seed-3'],
    arrivedAccessoryIds: ['accessory-seed-2', 'accessory-seed-3'],
    observedBoxes: { 'head-seed-2': '木箱丙-88' }
  });
  check('错箱 -> 待复核', r.json.record.status === '待复核' && r.json.problems.some((p) => p.type === '错箱'), r.json);

  // 封签异常
  r = await api('POST', `/api/tourBoxes/${orderId}/arrival`, {
    receiver: '剧场李经理',
    sealNo: 'SEAL-2026-001',
    sealStatus: '异常',
    arrivedHeadIds: ['head-seed-2', 'head-seed-3'],
    arrivedAccessoryIds: ['accessory-seed-2', 'accessory-seed-3']
  });
  check('封签异常 -> 待复核', r.json.problems.some((p) => p.type === '封签异常'), r.json);
  check('多次登记：前次记录归档', (r.json.record.archivedArrivals || []).length >= 1, { n: r.json.record.archivedArrivals?.length });

  console.log('5) 到场正常解封 -> 已解封，可演出；履历一致');
  r = await api('POST', `/api/tourBoxes/${orderId}/arrival`, {
    receiver: '剧场李经理',
    sealNo: 'SEAL-2026-001',
    sealStatus: '完好',
    arrivedHeadIds: ['head-seed-2', 'head-seed-3'],
    arrivedAccessoryIds: ['accessory-seed-2', 'accessory-seed-3']
  });
  check('到场无误 -> 已解封、可演出', r.json.record.status === '已解封' && r.json.performanceAllowed === true && r.json.record.performanceAllowed === true, r.json);

  // 刷新后列表与详情一致
  const list = (await api('GET', '/api/tourBoxes')).json;
  const listed = list.find((o) => o.id === orderId);
  check('列表状态=详情状态（刷新一致）', listed.status === '已解封' && listed.performanceAllowed === true && listed.arrival?.receiver === '剧场李经理', listed);
  const detail = (await api('GET', `/api/tourBoxes/${orderId}`)).json;
  check('详情与列表同源一致', detail.status === listed.status && detail.sealNo === listed.sealNo);
  const history = (await api('GET', `/api/tourBoxes/${orderId}/history`)).json;
  const actions = history.events.map((e) => e.action);
  check('装箱履历完整：建单/封箱/到场记录都在', actions.includes('建单') && actions.includes('封箱加签') && actions.filter((a) => a.startsWith('到场解封')).length >= 1, actions);

  console.log('6) 更正箱号/封签/清单 -> 原解封及演出资格失效留档');
  r = await api('POST', `/api/tourBoxes/${orderId}/correct`, {
    headBoxNos: { 'head-seed-3': '木箱甲-09' },
    reason: '到场发现箱号标签错误',
    actor: '箱头阿明'
  });
  check('更正后状态转待复核', r.status === 200 && r.json.status === '待复核', r.json);
  check('更正后演出资格失效', r.json.performanceAllowed === false, r.json);
  check('原解封失效留档', (r.json.archivedArrivals || []).some((a) => a.invalidReason && a.invalidatedAt), r.json.archivedArrivals?.map((a) => a.invalidReason));
  check('箱号已更正', r.json.headBoxMap['head-seed-3'] === '木箱甲-09');
  const history2 = (await api('GET', `/api/tourBoxes/${orderId}/history`)).json;
  check('履历含「装箱更正·解封失效」', history2.events.some((e) => e.action === '装箱更正·解封失效'));

  // 未解封的已封箱单更正封签：占号切换
  const order2Detail = (await api('GET', `/api/tourBoxes/${order2Id}`)).json;
  if (order2Detail.status === '已装箱') {
    r = await api('POST', `/api/tourBoxes/${order2Id}/correct`, { sealNo: 'SEAL-2026-009', reason: '封签补登更正' });
    check('封签更正成功', r.status === 200 && r.json.sealNo === 'SEAL-2026-009', r.json);
    // 旧号可被新单使用（占号已释放）
    const r3 = await api('POST', '/api/tourBoxes', {
      showName: '福州场', venue: '福州大戏院', play: '火焰山',
      headIds: [], accessoryIds: [], _skip: true
    });
    check('空清单不可建单(参数校验)', r3.status === 400, { status: r3.status });
  }

  // 清单更正后可重新解封
  r = await api('POST', `/api/tourBoxes/${orderId}/arrival`, {
    receiver: '剧场李经理',
    sealNo: 'SEAL-2026-001',
    sealStatus: '完好',
    arrivedHeadIds: ['head-seed-2', 'head-seed-3'],
    arrivedAccessoryIds: ['accessory-seed-2', 'accessory-seed-3'],
    observedBoxes: { 'head-seed-3': '木箱甲-09' }
  });
  check('按更正后信息重新解封 -> 已解封可演出', r.json.record.status === '已解封' && r.json.performanceAllowed === true, r.json);

  console.log('7) 闭环 -> 释放封签占号与档案占用');
  r = await api('POST', `/api/tourBoxes/${order2Id}/close`, { note: '厦门场结束返场' });
  check('order2 闭环成功', r.status === 200 && r.json.status === '已闭环', r.json);
  const acc = (await api('GET', '/api/accessories/accessory-seed-1')).json;
  check('闭环后配件回在库', acc.status === '在库' && !acc.tourBoxId, acc);

  // order1 闭环后，封签号可复用
  r = await api('POST', `/api/tourBoxes/${orderId}/close`, {});
  check('order1 闭环成功', r.json.status === '已闭环', r.json);
  const head = (await api('GET', '/api/puppetHeads/head-seed-2')).json;
  check('闭环后偶头回可演出', head.status === '可演出' && head.currentUsable === true && !head.tourBoxId, head);

  r = await api('POST', '/api/tourBoxes', {
    showName: '复用封签号新单', venue: '漳州站', play: '火焰山',
    headIds: ['head-seed-2'], accessoryIds: ['accessory-seed-1']
  });
  const newId = r.json.id;
  r = await api('POST', `/api/tourBoxes/${newId}/seal`, { sealNo: 'SEAL-2026-001' });
  check('闭环后旧封签号可重新使用', r.status === 200 && r.json.record.sealNo === 'SEAL-2026-001', r.json);

  console.log('8) 通用直写被拦截（必须走业务入口）');
  r = await api('PATCH', `/api/tourBoxes/${orderId}`, { status: '已解封' });
  check('PATCH 直写 tourBoxes -> 405', r.status === 405, { status: r.status });
  r = await api('POST', `/api/tourBoxes/${orderId}/events`, { status: '已解封' });
  check('events 直写 tourBoxes -> 405', r.status === 405, { status: r.status });

  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(2); });
