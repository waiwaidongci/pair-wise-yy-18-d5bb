#!/usr/bin/env python3
"""端到端业务验证：装箱核对/封签/到场解封/更正失效/闭环/一致性。"""
import json
import urllib.request
import urllib.error
import urllib.parse

BASE = 'http://localhost:3914'
results = []


def call(method, path, body=None, expected=None):
    data = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
    if '?' in path:
        base_path, query = path.split('?', 1)
        path = base_path + '?' + urllib.parse.urlencode(urllib.parse.parse_qsl(query))
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as resp:
            status = resp.status
            payload = json.loads(resp.read().decode('utf-8') or 'null')
    except urllib.error.HTTPError as error:
        status = error.code
        payload = json.loads(error.read().decode('utf-8') or 'null')
    ok = expected is None or status == expected
    results.append((ok, method + ' ' + path, status, expected, payload))
    return status, payload


# 1. 装箱核对：含不可演出偶头 + 箱号不符 + 不存在配件 -> 409，整单不写入
status, payload = call('POST', '/api/tourBoxes/pack', {
    'showName': '西北巡演-兰州站', 'venue': '兰州大剧院', 'play': '火焰山',
    'headIds': ['head-seed-2', 'head-seed-1'],
    'accessoryIds': ['accessory-seed-2', 'no-such-item'],
    'boxes': {'head-seed-2': '木箱Z-99'},
    'actor': '箱务甲'
}, expected=409)
assert status == 409
problems = {(p['type'], p.get('itemId')) for p in payload['details']['problems']}
assert ('状态不符', 'head-seed-1') in problems
assert ('箱号不符', 'head-seed-2') in problems
assert ('缺档案', 'no-such-item') in problems

status, boxes = call('GET', '/api/tourBoxes')
assert boxes == [], boxes
status, head2 = call('GET', '/api/puppetHeads/head-seed-2')
assert head2['status'] == '可演出', head2

# 2. 正常装箱 -> 201，偶头/配件置为已装箱
status, box1 = call('POST', '/api/tourBoxes/pack', {
    'showName': '西北巡演-兰州站', 'venue': '兰州大剧院', 'play': '火焰山',
    'headIds': ['head-seed-2', 'head-seed-3'],
    'accessoryIds': ['accessory-seed-2', 'accessory-seed-3'],
    'actor': '箱务甲'
}, expected=201)
box1_id = box1['id']
assert box1['status'] == '已装箱'
assert box1['sealNo'] is None
assert box1['canPerform'] is False
assert {m['itemId'] for m in box1['manifest']} == {
    'head-seed-2', 'head-seed-3', 'accessory-seed-2', 'accessory-seed-3'}
status, head2 = call('GET', '/api/puppetHeads/head-seed-2')
assert head2['status'] == '已装箱'
status, acc2 = call('GET', '/api/accessories/accessory-seed-2')
assert acc2['status'] == '已装箱'

# 3. 重复装箱同一偶头（未结束单） -> 409，整单不写入
status, payload = call('POST', '/api/tourBoxes/pack', {
    'showName': '重复单', 'venue': '西宁', 'play': '火焰山',
    'headIds': ['head-seed-2'], 'accessoryIds': [], 'actor': '箱务乙'
}, expected=409)
assert any(p['type'] == '重复装箱' for p in payload['details']['problems'])
status, boxes = call('GET', '/api/tourBoxes')
assert len(boxes) == 1

# 4. 补封签
status, sealed = call('POST', f'/api/tourBoxes/{box1_id}/seal',
                      {'sealNo': 'SF-2026-0001', 'actor': '箱务甲'}, expected=201)
assert sealed['status'] == '已封箱' and sealed['sealNo'] == 'SF-2026-0001'

# 4b. 同封签号重试/并发 -> 沿用首次结果（reused 标记），不产生新封签
status, again = call('POST', f'/api/tourBoxes/{box1_id}/seal',
                     {'sealNo': 'SF-2026-0001', 'actor': '箱务甲'}, expected=200)
assert again['_reusedFirstSeal'] is True and again['sealedAt'] == sealed['sealedAt']

# 4c. 不同封签号覆盖 -> 409
status, payload = call('POST', f'/api/tourBoxes/{box1_id}/seal',
                       {'sealNo': 'SF-OTHER'}, expected=409)
assert '不一致' in payload['error']

# 5. 封签号在未结束装箱单中唯一：另一张正常装箱单使用同封签号 -> 409
status, box2 = call('POST', '/api/tourBoxes/pack', {
    'showName': '西北巡演-西宁站', 'venue': '西宁人民剧院', 'play': '火焰山',
    'headIds': [], 'accessoryIds': ['accessory-seed-1'], 'actor': '箱务乙'
}, expected=201)
box2_id = box2['id']
status, payload = call('POST', f'/api/tourBoxes/{box2_id}/seal',
                       {'sealNo': 'SF-2026-0001'}, expected=409)
assert '占用' in payload['error']
# 冲突后该单仍为已装箱、无封签
status, box2_check = call('GET', f'/api/tourBoxes/{box2_id}')
assert box2_check['status'] == '已装箱' and box2_check['sealNo'] is None
call('POST', f'/api/tourBoxes/{box2_id}/seal', {'sealNo': 'SF-2026-0002'}, expected=201)

# 6. 到场：未封箱不能解封（box2 已封，改用直接构造：先测兰州站封签不符 -> 待复核）
status, arrival_bad = call('POST', f'/api/tourBoxes/{box1_id}/arrive', {
    'receiver': '前台刘经理', 'actualSeal': 'SF-FORGED',
    'actualItems': [
        {'id': 'head-seed-2'},
        {'id': 'head-seed-3'},
        {'id': 'accessory-seed-2'}  # 凤冠缺失
    ],
    'boxes': {'head-seed-2': '木箱X-00'},  # 错箱
    'actor': '前台刘经理'
}, expected=201)
assert arrival_bad['status'] == '待复核'
assert arrival_bad['canPerform'] is False
assert '不得演出' in arrival_bad['qualificationNote']
arr = arrival_bad['arrivals'][0]
kinds = {d['type'] for d in arr['discrepancies']}
assert kinds == {'封签不符', '错箱', '缺件'}, kinds
assert arr['valid'] is False

# 7. 待复核状态不得演出（列表判定一致）
status, review_list = call('GET', '/api/tourBoxes?status=待复核')
assert len(review_list) == 1 and review_list[0]['canPerform'] is False
status, ready_list = call('GET', '/api/tourBoxes?status=可演出')
assert ready_list == []

# 8. 不允许直接用通用接口改状态绕过
status, payload = call('PATCH', f'/api/tourBoxes/{box1_id}',
                       {'status': '可演出'}, expected=405)

# 9. 更正：换封签 + 改箱号 + 清单（补入撤出） -> 原解封失效留档
status, corrected = call('POST', f'/api/tourBoxes/{box1_id}/correct', {
    'sealNo': 'SF-2026-0003',
    'boxes': {'head-seed-2': '木箱甲-01'},
    'headIds': ['head-seed-2'],  # 撤出铁扇公主
    'accessoryIds': ['accessory-seed-2', 'accessory-seed-3'],
    'note': '兰州现场发现错装铁扇公主，换箱重封',
    'actor': '箱务甲'
}, expected=200)
assert corrected['status'] == '待复核'
assert corrected['sealNo'] == 'SF-2026-0003'
assert corrected['canPerform'] is False
assert '失效' in corrected['qualificationNote']
old = corrected['arrivals'][0]
assert old['valid'] is False and old['invalidatedAt']
assert len(corrected['corrections']) == 1
# 撤出件恢复可演出
status, head3 = call('GET', '/api/puppetHeads/head-seed-3')
assert head3['status'] == '可演出'

# 10. 只改箱号不换封签 -> 409
status, payload = call('POST', f'/api/tourBoxes/{box1_id}/correct', {
    'boxes': {'head-seed-2': '木箱甲-09'}
}, expected=409)

# 11. 用已占用封签更正 -> 409（0002 在 box2 上，且 box2 未结束）
status, payload = call('POST', f'/api/tourBoxes/{box1_id}/correct',
                       {'sealNo': 'SF-2026-0002'}, expected=409)

# 12. 重新到场解封，全部核对无误 -> 可演出
status, arrival_ok = call('POST', f'/api/tourBoxes/{box1_id}/arrive', {
    'receiver': '前台刘经理', 'actualSeal': 'SF-2026-0003',
    'actualItems': [
        {'id': 'head-seed-2'},
        {'id': 'accessory-seed-2'},
        {'id': 'accessory-seed-3'}
    ],
    'boxes': {'head-seed-2': '木箱甲-01', 'accessory-seed-2': '配件箱-01',
              'accessory-seed-3': '配件箱-01'},
    'actor': '前台刘经理'
}, expected=201)
assert arrival_ok['status'] == '可演出'
assert arrival_ok['canPerform'] is True
assert arrival_ok['arrivals'][0]['valid'] is True
# 旧解封（失败登记）作为历史留档
assert arrival_ok['arrivals'][1]['valid'] is False

# 13. 缺件（仅清单缺项，封签对、箱对）-> 待复核，且不覆盖可演出登记（追加留档）
# 更正前确认成功解封当前有效、具备演出资格
assert arrival_ok['arrivals'][0]['valid'] is True
call('POST', f'/api/tourBoxes/{box1_id}/correct',
     {'sealNo': 'SF-2026-0004', 'note': '二次改封'}, expected=200)
status, miss = call('POST', f'/api/tourBoxes/{box1_id}/arrive', {
    'receiver': '前台刘经理', 'actualSeal': 'SF-2026-0004',
    'actualItems': [{'id': 'head-seed-2'}, {'id': 'accessory-seed-2'}]
}, expected=201)
assert miss['status'] == '待复核' and miss['canPerform'] is False
assert {d['type'] for d in miss['arrivals'][0]['discrepancies']} == {'缺件'}

# 14. 履历与通用 timeline 同源；列表状态 = 详情 = timeline.record
# 至此三次到场（失败 / 成功 / 再失败）都在档，canPerform=False；
# 其中成功解封被第二次更正作失效留档，最早的失败登记被第一次更正失效，
# 最新一条是更正后的新登记，不带失效时间。
assert [a['valid'] for a in miss['arrivals']] == [False, False, False]
assert 'invalidatedAt' not in miss['arrivals'][0]   # 更正后的新登记
assert 'invalidatedAt' in miss['arrivals'][1]       # 曾成功的解封被更正失效
assert 'invalidatedAt' in miss['arrivals'][2]       # 最早的失败登记被更正失效
status, tl1 = call('GET', f'/api/tourBoxes/{box1_id}/timeline')
status, tl2 = call('GET', f'/api/tourBoxes/{box1_id}/timeline')
actions = [e['action'] for e in tl1['events']]
for needed in ['装箱核对通过', '补封签', '到场解封-待复核', '更正-原解封与演出资格失效',
               '到场解封-可演出', '到场解封-待复核']:
    assert needed in actions, (needed, actions)
assert tl1['record']['status'] == tl2['record']['status'] == '待复核'
status, detail = call('GET', f'/api/tourBoxes/{box1_id}')
status, listed = call('GET', '/api/tourBoxes?status=待复核')
assert detail['updatedAt'] == tl1['record']['updatedAt']
assert any(b['id'] == box1_id and b['status'] == '待复核' for b in listed)
# 偶头履历也记录了装箱/更正撤出（通过通用 timeline）
status, head_tl = call('GET', '/api/puppetHeads/head-seed-3/timeline')
head_actions = [e['action'] for e in head_tl['events']]
assert '装箱' in head_actions and '更正撤出' in head_actions

# 15. 闭环：封签号释放，物件返库；旧封签号可被新单复用
status, closed = call('POST', f'/api/tourBoxes/{box2_id}/close', {'actor': '箱务乙'}, expected=200)
assert closed['status'] == '已闭环'
status, acc1 = call('GET', '/api/accessories/accessory-seed-1')
assert acc1['status'] == '在库'
status, box3 = call('POST', '/api/tourBoxes/pack', {
    'showName': '返场复用单', 'venue': '西安', 'play': '火焰山',
    'headIds': ['head-seed-3'], 'accessoryIds': ['accessory-seed-1']
}, expected=201)
box3_id = box3['id']
# box2 已闭环，SF-2026-0002 现在可再用
status, reused_seal = call('POST', f'/api/tourBoxes/{box3_id}/seal',
                           {'sealNo': 'SF-2026-0002'}, expected=201)
assert reused_seal['sealNo'] == 'SF-2026-0002'

# 16. 已闭环单不能再封箱/到场/更正
call('POST', f'/api/tourBoxes/{box2_id}/seal', {'sealNo': 'X'}, expected=409)
call('POST', f'/api/tourBoxes/{box2_id}/arrive', {'receiver': '张三'}, expected=409)
call('POST', f'/api/tourBoxes/{box2_id}/correct', {'sealNo': 'Y'}, expected=409)

# 17. 入参校验
call('POST', f'/api/tourBoxes/{box1_id}/seal', {'sealNo': ''}, expected=400)
call('POST', f'/api/tourBoxes/{box1_id}/arrive', {'receiver': ''}, expected=400)
call('POST', '/api/tourBoxes/pack',
     {'showName': 'X', 'venue': 'Y', 'play': 'Z', 'headIds': [], 'accessoryIds': []},
     expected=201)

print(f'\n全部断言通过：{len(results)} 次调用')
for ok, path, status, expected, _ in results:
    mark = 'OK ' if ok else 'FAIL'
    print(f'  {mark} {status:>3} {path}')
