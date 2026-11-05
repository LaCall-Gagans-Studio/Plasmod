# app-files.patch を当てた plasmod_bridge.py の、添付つき送信の動作確認。
# 使い方: ~/.plasmod-bridge/venv/bin/python test_app_files.py [plasmod_bridge.py のパス]
import asyncio, base64, json, os, sys, tempfile, importlib.util, pwd
spec = importlib.util.spec_from_file_location("b", sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "plasmod_bridge.py")); b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
d = tempfile.mkdtemp(); b.APP_SOCK = os.path.join(d, "app.sock"); b.STATE = os.path.join(d, "state.json"); b.HISTORY_DIR = getattr(b, "HISTORY_DIR", None) and os.path.join(d, "history"); b.INBOX = os.path.join(d, "inbox")
b.APP_USER = pwd.getpwuid(os.getuid()).pw_name


class FakeThread:
    def __init__(self, tid): self.id, self.sent = int(tid), []
    async def send(self, text, **kw): self.sent.append(text)


async def main():
    br = b.Bridge()
    br.st = {"threads": {"42": {"title": "t", "created": 1}}}
    th = FakeThread("42")
    async def get_thread(tid): return th
    br.get_thread = get_thread
    delivered = []
    async def deliver(thread, content, meta): delivered.append(content)
    br.deliver = deliver
    srv = await asyncio.start_unix_server(br.on_app_conn, path=b.APP_SOCK)
    r, w = await asyncio.open_unix_connection(b.APP_SOCK)
    await r.readline()

    async def ask(obj):
        w.write((json.dumps(obj) + "\n").encode()); await w.drain()
        while True:  # app-chat.patch 以降は、会話の記録の chat も流れてくるので読み飛ばす
            m = json.loads(await asyncio.wait_for(r.readline(), 3))
            if m.get("type") != "chat":
                return m

    files = [{"name": "../../スクショ.png", "data": base64.b64encode(b"PNG").decode()}, {"name": ".env", "data": base64.b64encode(b"x").decode()}]
    m = await ask({"type": "send", "id": 1, "thread": "42", "text": "これ見て", "files": files})
    assert m["ok"], m
    saved = sorted(os.listdir(os.path.join(b.INBOX, "42")))
    # パスは捨てて名前だけ、先頭のドットも外す（隠しファイルにしない）
    assert len(saved) == 2 and saved[0].endswith("-スクショ.png") and saved[1].endswith("-env"), saved
    assert open(os.path.join(b.INBOX, "42", saved[0]), "rb").read() == b"PNG"
    assert "[添付ファイル]" in delivered[-1] and saved[0] in delivered[-1], delivered[-1]
    # 壊れた base64・多すぎる添付は断る（届けない）
    m = await ask({"type": "send", "id": 2, "thread": "42", "text": "x", "files": [{"name": "a", "data": "!!!"}]})
    assert not m["ok"], m
    m = await ask({"type": "send", "id": 3, "thread": "42", "text": "x", "files": [{"name": "a", "data": ""}] * 11})
    assert not m["ok"] and "10個" in m["error"], m
    assert len(delivered) == 1
    w.close(); srv.close()
    print("bridge app-files OK")

asyncio.run(main())
