"""Playwright 启动参数（本容器 /dev/shm 只有 64M，默认参数会 TargetClosedError: Page crashed）。

用法：
    from _launch import LAUNCH_ARGS
    browser = p.chromium.launch(args=LAUNCH_ARGS)

需要覆盖时设环境变量 CHROME_ARGS（空格分隔），例如 CHROME_ARGS="--no-sandbox"。
"""

import os

DEFAULT_ARGS = [
    '--no-sandbox',              # 容器内非 root 命名空间受限
    '--disable-dev-shm-usage',   # /dev/shm 64M，不关掉会把渲染进程压崩
    '--disable-gpu',             # 无 GPU，软件渲染反而更稳
    '--single-process',          # 不加它渲染这份大页面必崩（Page crashed）；代价：多 context 会卡死，
                                 # 需要多页面时每个场景单独 launch 一个浏览器
    '--disable-features=LocalNetworkAccessChecks',  # 页面以 127.0.0.1 为 origin，别被本地网络校验拦
]

LAUNCH_ARGS = os.environ.get('CHROME_ARGS', '').split() or DEFAULT_ARGS
