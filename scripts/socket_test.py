"""socket 测试：与 app.js connectSocket 完全相同的参数直连 /chat-run，验证服务端握手、
事件到达（run / message.delta / run.completed）——绕开 Chromium 的本地网络访问检查。"""
import json
import sys
import time
import urllib.request

import socketio  # python-socketio

TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'

sio = socketio.Client(logger=False, engineio_logger=False)
events = []
done = {'flag': False, 'output': None}

@sio.event(namespace='/chat-run')
def connect():
    print('>> socket 已连接')

@sio.event(namespace='/chat-run')
def disconnect():
    print('>> socket 断开')

@sio.on('run.queued', namespace='/chat-run')
def on_queued(ev, *args):
    events.append(('run.queued', ev))
    print('>> run.queued', json.dumps(ev, ensure_ascii=False)[:120])

@sio.on('message.delta', namespace='/chat-run')
def on_delta(ev, *args):
    events.append(('message.delta', ev.get('delta', '')))
    done['flag'] = done['flag'] or False

@sio.on('run.completed', namespace='/chat-run')
def on_completed(ev, *args):
    done['flag'] = True
    done['output'] = ev.get('output')
    print('>> run.completed output=', str(ev.get('output'))[:160])

@sio.on('run.failed', namespace='/chat-run')
def on_failed(ev, *args):
    done['flag'] = True
    print('>> run.failed', json.dumps(ev, ensure_ascii=False)[:200])

@sio.on('run.started', namespace='/chat-run')
def on_started(ev, *args):
    events.append(('run.started', ev))
    print('>> run.started', json.dumps(ev, ensure_ascii=False)[:120])

try:
    sio.connect(
        BASE + '/chat-run?profile=enderiose',
        auth={'token': TOKEN},
        transports=['websocket', 'polling'],
        wait_timeout=15,
    )
except Exception as e:
    print('CONNECT_FAIL:', e)
    sys.exit(1)

sid = 'mu' + ''.join('abcdefghijklmnopqrstuvwxyz0123456789'[int(time.time_ns() >> 8) % 36] for _ in range(12))
print('>> 发送 run session_id=', sid)
sio.emit('run', {'input': '回复两个字：收到', 'session_id': sid, 'profile': 'enderiose'}, namespace='/chat-run')

deadline = time.time() + 120
while time.time() < deadline and not done['flag']:
    time.sleep(1)

text = ''.join(d for _, d in events if isinstance(d, str) and _ == 'message.delta')
print('>> delta 合并文本:', text[:200] or '(空)')
print('>> 事件计数:', len(events))
sio.disconnect()
print('SOCKET_DONE ok=', bool(done['flag'] and (done['output'] or text)))
