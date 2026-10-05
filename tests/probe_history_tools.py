"""看历史消息里同一 run 的工具行构成（tool_calls 公告行 vs 结果行），确认计数翻倍来源。"""
import json
from urllib import request as urlreq

TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'


def api(path):
    req = urlreq.Request(BASE + path, headers={'Authorization': 'Bearer ' + TOKEN,
                                               'X-Hermes-Profile': 'enderiose'})
    with urlreq.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


sess = api('/api/studio/sessions?profile=enderiose&limit=100').get('sessions') or []
sess.sort(key=lambda s: s.get('message_count') or 0, reverse=True)
for s in sess[:3]:
    print('==', s['id'], s.get('title', '')[:40], s.get('message_count'))

sid = sess[0]['id']
res = api('/api/studio/sessions/conversations/%s/messages/paginated?offset=0&limit=300&profile=enderiose' % sid)
msgs = res.get('messages') or []
print('消息数:', len(msgs), '顶层字段样例:', sorted(msgs[-1].keys()) if msgs else [])
runs = {}
for m in msgs:
    rm = m.get('run_marker')
    if not rm:
        continue
    runs.setdefault(rm, []).append(m)
big = max(runs.items(), key=lambda kv: len(kv[1]))
rm, rows = big
print('\n最大 run:', rm, len(rows), '条')
for m in rows[:14]:
    print(' -', m.get('display_role') or m.get('role'), '| tool_name=', m.get('tool_name'),
          '| tool_call_id=', m.get('tool_call_id'),
          '| tool_calls=', bool(m.get('tool_calls')),
          '| content=', repr(str(m.get('content'))[:40]))
