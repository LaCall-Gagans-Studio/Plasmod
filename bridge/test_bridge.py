# plasmod_bridge.py の確認: 新規・再開・返事・承認・履歴
# 使い方: ~/.plasmod-bridge/venv/bin/python test_bridge.py [plasmod_bridge.py のパス]
import asyncio, importlib.util, json, os, pwd, sys, tempfile

spec = importlib.util.spec_from_file_location("b", sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "plasmod_bridge.py"))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
d = tempfile.mkdtemp()
b.APP_SOCK = os.path.join(d, "app.sock"); b.SOCK = os.path.join(d, "bridge.sock"); b.STATE = os.path.join(d, "state.json")
b.STATE_DIR = d; b.HISTORY_DIR = os.path.join(d, "history")
b.APP_USER = pwd.getpwuid(os.getuid()).pw_name
started = []
def fake_tmux(*a, **k):
    if a[0] == "new-session":
        started.append(a[-1])
    return type("R", (), {"returncode": 0, "stderr": "", "stdout": ""})()
b.tmux = fake_tmux
b.tmux_alive = lambda tid: False
b.read_model = lambda target: None

async def main():
    br = b.Bridge()
    br.st = {"threads": {"42": {"title": "古いスレッド", "created": 1, "session_id": "s42"}}}
    async def babysit(thread, s): pass
    br.babysit_start = babysit
    delivered = []
    async def write(s, payload): delivered.append(payload)
    br.write = write
    await br.start()
    r, w = await asyncio.open_unix_connection(b.APP_SOCK, limit=8 * 1024 * 1024)
    await r.readline()
    n = [0]
    pushed = []

    async def ask(obj):
        n[0] += 1
        obj = {**obj, "id": n[0]}
        w.write((json.dumps(obj) + "\n").encode()); await w.drain()
        while True:
            m = json.loads(await asyncio.wait_for(r.readline(), 3))
            if m.get("type") == "result" and m.get("id") == obj["id"]:
                return m
            pushed.append(m)

    # 新しいセッション: 番号は数字、記録に残る
    res = await ask({"type": "send", "text": "はじめまして"})
    assert res["ok"] and res["thread"].isdigit(), res
    new = res["thread"]
    assert br.st["threads"][new]["title"] == "はじめまして"
    assert "--session-id" in started[-1]

    # 前からあるスレッドも同じ番号のまま再開する
    res = await ask({"type": "send", "thread": "42", "text": "続き"})
    assert res["ok"] and res["thread"] == "42", res
    assert "--resume s42" in started[-1], started[-1]

    # 返事は記録に残り、アプリに流れる
    ok, err = await br.post_reply({"thread": "42", "chat_id": "42", "text": "返事です"})
    assert ok and err is None, err
    h = await ask({"type": "history", "thread": "42"})
    said = [m for m in h["messages"] if m["author"] != "system"]
    assert [m["content"] for m in said] == ["続き", "返事です"], h
    assert said[1]["author"] == "dev"
    # 別のスレッド宛ては断る
    ok, err = await br.post_reply({"thread": "42", "chat_id": "43", "text": "x"})
    assert not ok and err

    # 記録の無いスレッドの履歴は空
    br.st["threads"]["77"] = {"title": "記録なし", "created": 1, "session_id": "s77"}
    h = await ask({"type": "history", "thread": "77"})
    assert h["ok"] and h["messages"] == [], h

    # 承認: アプリに届き、答えると解決する
    await br.post_permission({"thread": "42", "request_id": "abcde", "tool_name": "Bash", "description": "d", "input_preview": "p"})
    assert ("42", "abcde") in br.pending_perms
    w.write((json.dumps({"type": "verdict", "thread": "42", "request_id": "abcde", "behavior": "deny"}) + "\n").encode()); await w.drain()
    for _ in range(100):
        if ("42", "abcde") not in br.pending_perms:
            break
        await asyncio.sleep(0.01)
    assert ("42", "abcde") not in br.pending_perms

    # 一覧・画面・止める
    br.sessions["42"] = b.Session("42")
    r0 = await ask({"type": "list_sessions"})
    assert r0["ok"] and {x["thread"] for x in r0["sessions"]} >= {"42", new}, r0
    assert (await ask({"type": "pane", "thread": "42"}))["ok"]
    assert (await ask({"type": "stop", "thread": "42"}))["ok"]
    assert (await ask({"type": "pane", "thread": "999"}))["ok"] is False

    # 起動できないときの知らせも記録に残る
    t = await br.get_thread("42")
    await t.send("⚠️ テスト")
    h = await ask({"type": "history", "thread": "42"})
    assert h["messages"][-1]["author"] == "system"
    w.close()


asyncio.run(main())
print("bridge OK")
