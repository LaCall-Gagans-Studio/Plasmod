# app-biglines.patch を当てた plasmod_bridge.py の、大きな添付（写真）が1行で届いても app.sock が切れないことの確認。
# 使い方: ~/.plasmod-bridge/venv/bin/python test_app_biglines.py [plasmod_bridge.py のパス]
import asyncio, base64, json, os, sys, tempfile, importlib.util, pwd
spec = importlib.util.spec_from_file_location("b", sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "plasmod_bridge.py")); b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
d = tempfile.mkdtemp()
b.STATE_DIR = d; b.SOCK = os.path.join(d, "bridge.sock"); b.APP_SOCK = os.path.join(d, "app.sock"); b.STATE = os.path.join(d, "state.json")
b.HISTORY_DIR = os.path.join(d, "history"); b.INBOX = os.path.join(d, "inbox")
b.APP_USER = pwd.getpwuid(os.getuid()).pw_name


class FakeThread:
    def __init__(self, tid): self.id, self.sent = int(tid), []
    async def send(self, text, **kw): self.sent.append(text)


async def main():
    br = b.Bridge()
    br.loop = asyncio.get_running_loop()
    br.st = {"threads": {"42": {"title": "t", "created": 1}}}
    await br.start()   # 本物の起動処理で app.sock を作る（制限もここで決まる）
    th = FakeThread("42")
    async def get_thread(tid): return th
    br.get_thread = get_thread
    async def deliver(thread, content, meta): pass
    br.deliver = deliver
    r, w = await asyncio.open_unix_connection(b.APP_SOCK, limit=64 * 1024 * 1024)
    await r.readline()
    big = base64.b64encode(os.urandom(6 * 1024 * 1024)).decode()   # 約 8MB の1行（写真1枚の大きさ）
    w.write((json.dumps({"type": "send", "id": 1, "thread": "42", "text": "写真", "files": [{"name": "photo.jpg", "data": big}]}) + "\n").encode())
    await w.drain()
    while True:
        m = json.loads(await asyncio.wait_for(r.readline(), 10))
        if m.get("type") == "result":
            break
    assert m["ok"], m
    saved = os.listdir(os.path.join(b.INBOX, "42"))
    assert len(saved) == 1 and os.path.getsize(os.path.join(b.INBOX, "42", saved[0])) == 6 * 1024 * 1024
    w.close()
    br.app_server.close(); br.server.close()
    print("bridge app-biglines OK")

asyncio.run(asyncio.wait_for(main(), 40))
