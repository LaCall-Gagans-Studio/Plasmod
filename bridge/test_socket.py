# パッチを当てた plasmod_bridge.py の、アプリ用窓口の動作確認。
# 使い方: ~/.plasmod-bridge/venv/bin/python test_app_socket.py [plasmod_bridge.py のパス]
import asyncio, json, os, sys, tempfile, importlib.util
spec = importlib.util.spec_from_file_location("b", sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "plasmod_bridge.py")); b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
d = tempfile.mkdtemp(); b.APP_SOCK = os.path.join(d, "app.sock"); b.STATE = os.path.join(d, "state.json"); b.HISTORY_DIR = getattr(b, "HISTORY_DIR", None) and os.path.join(d, "history")
import pwd; b.APP_USER = pwd.getpwuid(os.getuid()).pw_name   # テストでは「自分」を許可ユーザーとみなす
async def nxt(r):
    """chat（会話の記録）は読み飛ばす"""
    while True:
        m = json.loads(await asyncio.wait_for(r.readline(), 2))
        if m.get("type") != "chat":
            return m


async def main():
    br = b.Bridge()
    br.st = {"threads": {"42": {"title": "テスト"}}}
    srv = await asyncio.start_unix_server(br.on_app_conn, path=b.APP_SOCK)
    # 先に依頼が来ている → 接続時に送られる
    await br.post_permission({"thread": "42", "request_id": "abcde", "tool_name": "Bash", "description": "git push", "input_preview": "git push origin main"})
    r, w = await asyncio.open_unix_connection(b.APP_SOCK)
    got = [await nxt(r) for _ in range(2)]
    assert got[0]["type"] == "hello" and got[1]["type"] == "permission_request" and got[1]["thread_title"] == "テスト", got
    # 接続中に来た依頼も届く
    await br.post_permission({"thread": "42", "request_id": "fghij", "tool_name": "Edit", "description": "", "input_preview": ""})
    m = await nxt(r); assert m["request_id"] == "fghij", m
    # アプリからの verdict → resolved が返り、保留から消える
    w.write((json.dumps({"type": "verdict", "thread": "42", "request_id": "abcde", "behavior": "allow"}) + "\n").encode()); await w.drain()
    m = await nxt(r); assert m == {"type": "permission_resolved", "thread": "42", "request_id": "abcde", "behavior": "allow"}, m
    assert ("42", "abcde") not in br.pending_perms and ("42", "fghij") in br.pending_perms
    # 未知の依頼への verdict は無視
    w.write((json.dumps({"type": "verdict", "thread": "42", "request_id": "zzzzz", "behavior": "allow"}) + "\n").encode()); await w.drain()
    # 別の経路で解決 → アプリにも resolved
    await br.send_verdict("42", "fghij", "deny")
    m = await nxt(r); assert m["request_id"] == "fghij" and m["behavior"] == "deny", m
    w.close()
    # 許可ユーザー以外（存在しないユーザー）からの接続は、hello も返さず切られる
    b.APP_USER = "no-such-user-gh"
    r2, w2 = await asyncio.open_unix_connection(b.APP_SOCK)
    assert await asyncio.wait_for(r2.readline(), 2) == b"", "uid が違う接続が切られていない"
    w2.close(); srv.close()
    print("bridge app-socket OK")
asyncio.run(main())
