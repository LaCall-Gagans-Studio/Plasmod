# app-media.patch を当てた plasmod_bridge.py の、会話に載ったファイルの取り出し（パス検査つき）の動作確認。
# 使い方: ~/.plasmod-bridge/venv/bin/python test_app_media.py [plasmod_bridge.py のパス]
import asyncio, base64, json, os, sys, tempfile, importlib.util, pwd
spec = importlib.util.spec_from_file_location("b", sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "plasmod_bridge.py")); b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
d = os.path.realpath(tempfile.mkdtemp())
b.APP_SOCK = os.path.join(d, "app.sock"); b.STATE = os.path.join(d, "state.json"); b.HISTORY_DIR = os.path.join(d, "history")
b.WORK = os.path.join(d, "work"); b.INBOX = os.path.join(b.WORK, ".inbox")
b.APP_USER = pwd.getpwuid(os.getuid()).pw_name
os.makedirs(os.path.join(b.WORK, "site"))
for rel, data in (("site/chart.png", b"\x89PNG-chart"), ("site/.env", b"KEY=1"), ("site/report.pdf", b"%PDF-1")):
    open(os.path.join(b.WORK, rel), "wb").write(data)
os.symlink("/etc/hostname", os.path.join(b.WORK, "site", "link.png"))


class FakeThread:
    def __init__(self, tid): self.id, self.sent = int(tid), []
    async def send(self, text, **kw): self.sent.append(text)


async def main():
    br = b.Bridge()
    br.st = {"threads": {"42": {"title": "t", "created": 1}}}
    th = FakeThread("42")
    async def get_thread(tid): return th
    br.get_thread = get_thread
    async def deliver(thread, content, meta): pass
    br.deliver = deliver
    srv = await asyncio.start_unix_server(br.on_app_conn, path=b.APP_SOCK)
    r, w = await asyncio.open_unix_connection(b.APP_SOCK)
    await r.readline()
    chats = []

    async def ask(obj):
        w.write((json.dumps(obj) + "\n").encode()); await w.drain()
        while True:
            m = json.loads(await asyncio.wait_for(r.readline(), 5))
            if m.get("type") == "chat":
                chats.append(m)
                continue
            return m

    def P(rel): return os.path.join(b.WORK, rel)
    await br.log_chat("42", {"id": "m1", "author": "dev", "content": "図を作ったよ", "attachments": ["chart.png", "report.pdf"],
                             "media": [{"name": "chart.png", "path": P("site/chart.png")}, {"name": "report.pdf", "path": P("site/report.pdf")}]})
    for i, rel in enumerate(["site/.env", "site/link.png"]):
        await br.log_chat("42", {"id": f"bad{i}", "author": "dev", "content": "x", "media": [{"name": os.path.basename(rel), "path": P(rel)}]})
    await br.log_chat("42", {"id": "out", "author": "dev", "content": "x", "media": [{"name": "passwd", "path": "/etc/passwd"}]})
    await br.log_chat("42", {"id": "plain", "author": "dev", "content": "ファイル無し"})

    # アプリに流れる・返す形にはパスが無い（名前と大きさだけ）
    m = await ask({"type": "history", "id": 1, "thread": "42"})
    first = next(x for x in m["messages"] if x["id"] == "m1")
    assert first["media"] == [{"name": "chart.png", "size": 10}, {"name": "report.pdf", "size": 6}], first
    assert all("path" not in f for x in m["messages"] for f in x["media"]) and all(P("site") not in json.dumps(c) for c in chats)
    # 取り出せる
    m = await ask({"type": "file", "id": 2, "thread": "42", "msg": "m1", "i": 0})
    assert m["ok"] and base64.b64decode(m["data"]) == b"\x89PNG-chart" and m["name"] == "chart.png", m
    # 記録に無い番号・メッセージ・ファイル無しのメッセージは断る
    for obj in ({"msg": "m1", "i": 2}, {"msg": "m1", "i": -1}, {"msg": "nope", "i": 0}, {"msg": "plain", "i": 0}):
        m = await ask({"type": "file", "id": 3, "thread": "42", **obj})
        assert not m["ok"], (obj, m)
    # .env・シンボリックリンクの先・~/work と /tmp の外は断る
    for mid in ("bad0", "bad1", "out"):
        m = await ask({"type": "file", "id": 4, "thread": "42", "msg": mid, "i": 0})
        assert not m["ok"] and ("見せない" in m["error"]), (mid, m)
    # スレッドが違えば、同じ ID でも取れない
    m = await ask({"type": "file", "id": 5, "thread": "43", "msg": "m1", "i": 0})
    assert not m["ok"], m
    # 大きすぎる
    b.MEDIA_MAX = 4
    m = await ask({"type": "file", "id": 6, "thread": "42", "msg": "m1", "i": 0})
    assert not m["ok"] and "大きすぎ" in m["error"], m
    b.MEDIA_MAX = 15 * 1024 * 1024
    # アプリから送った添付（~/work/.inbox/<thread>/）も、その会話の中なら取り出せる
    m = await ask({"type": "send", "id": 7, "thread": "42", "text": "これ", "files": [{"name": "secret-menu.pdf", "data": base64.b64encode(b"%PDF-x").decode()}]})
    assert m["ok"], m
    sent = [c["message"] for c in chats if c["message"]["author"] == "owner"][-1]
    assert sent["media"][0]["name"].endswith("secret-menu.pdf") and "path" not in sent["media"][0], sent
    m = await ask({"type": "file", "id": 8, "thread": "42", "msg": sent["id"], "i": 0})
    assert m["ok"] and base64.b64decode(m["data"]) == b"%PDF-x", m
    w.close(); srv.close()
    print("bridge app-media OK")

asyncio.run(asyncio.wait_for(main(), 30))
