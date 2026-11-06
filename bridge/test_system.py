# app-system.patch を当てた plasmod_bridge.py の、使用量・モデル・ファイル閲覧の動作確認。
# 使い方: ~/.plasmod-bridge/venv/bin/python test_app_system.py [plasmod_bridge.py のパス]
import asyncio, json, os, sys, tempfile, time, importlib.util, pwd
spec = importlib.util.spec_from_file_location("b", sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "plasmod_bridge.py")); b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
d = tempfile.mkdtemp()
b.APP_SOCK = os.path.join(d, "app.sock"); b.STATE = os.path.join(d, "state.json"); b.HISTORY_DIR = getattr(b, "HISTORY_DIR", None) and os.path.join(d, "history")
b.APP_USER = pwd.getpwuid(os.getuid()).pw_name
b.HOME = d
b.MODEL_FILES = {"chat": os.path.join(d, "model-chat"), "worker": os.path.join(d, "model-worker")}
work = os.path.join(d, "work"); b.FS_ROOT = work
os.makedirs(os.path.join(work, "repo", ".git")); os.makedirs(os.path.join(work, "repo", "src"))
open(os.path.join(work, "repo", "README.md"), "w").write("# hello\n")
open(os.path.join(work, "repo", ".env"), "w").write("SECRET=1\n")
open(os.path.join(work, "repo", "deploy.pem"), "w").write("key\n")
open(os.path.join(work, "repo", "bin.dat"), "wb").write(b"\0\1\2")
os.symlink("/etc", os.path.join(work, "repo", "etc-link"))
proj = os.path.join(d, ".claude", "projects", "p"); os.makedirs(proj)
now = time.time()
iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))
with open(os.path.join(proj, "s.jsonl"), "w") as f:
    f.write(json.dumps({"timestamp": iso(now - 3600), "message": {"model": "claude-opus", "usage": {"input_tokens": 10, "output_tokens": 5, "cache_creation_input_tokens": 1, "cache_read_input_tokens": 999}, "content": "秘密"}}) + "\n")
    f.write(json.dumps({"timestamp": iso(now - 3 * 86400), "message": {"model": "claude-sonnet", "usage": {"input_tokens": 100, "output_tokens": 0}}}) + "\n")
    f.write("not json usage\n")


async def main():
    br = b.Bridge()
    br.st = {"threads": {}}
    srv = await asyncio.start_unix_server(br.on_app_conn, path=b.APP_SOCK)
    r, w = await asyncio.open_unix_connection(b.APP_SOCK)
    await r.readline()

    async def ask(obj):
        w.write((json.dumps(obj) + "\n").encode()); await w.drain()
        return json.loads(await asyncio.wait_for(r.readline(), 3))

    # 使用量: 数字だけ。中身（content）は返さない。cache_read は数えない
    m = await ask({"type": "usage", "id": 1})
    u = m["usage"]
    assert u["h5"] == {"claude-opus": 16} and u["d7"] == {"claude-opus": 16, "claude-sonnet": 100}, u
    assert u["messages_h5"] == 1 and "秘密" not in json.dumps(m), m
    # ログイン: 有無と期限だけ。メールと組織は渡さない
    bin_ = os.path.join(d, "bin"); os.makedirs(bin_, exist_ok=True)
    fake = os.path.join(bin_, "claude")
    with open(fake, "w") as f:
        f.write('#!/bin/sh\necho \'{"loggedIn": true, "authMethod": "claude.ai", "loginExpiresAt": "2026-12-05T22:50:08Z", "email": "me@example.com", "orgName": "秘密の組織"}\'\n')
    os.chmod(fake, 0o755)
    keep_path = os.environ["PATH"]
    os.environ["PATH"] = bin_
    m = await ask({"type": "auth_status", "id": 90})
    assert m["ok"] and m["claude"] == {"available": True, "loggedIn": True, "authMethod": "claude.ai", "loginExpiresAt": "2026-12-05T22:50:08Z"}, m
    assert "example.com" not in json.dumps(m) and "秘密" not in json.dumps(m), m
    os.remove(fake)
    m = await ask({"type": "auth_status", "id": 91})
    assert m["claude"] == {"available": False}, m
    os.environ["PATH"] = keep_path
    # モデル: 選べるものだけ。ファイルに書き、読み戻せる
    m = await ask({"type": "get_models", "id": 2})
    assert m["models"] == {"chat": None, "worker": None} and m["choices"] == ["opus", "sonnet"], m
    m = await ask({"type": "set_model", "id": 3, "target": "chat", "model": "opus"})
    assert m["ok"] and m["models"]["chat"] == "opus", m
    for bad in ({"target": "chat", "model": "gpt-5"}, {"target": "../x", "model": "opus"}):
        m = await ask({"type": "set_model", "id": 4, **bad})
        assert not m["ok"], m
    assert b.read_model("chat") == "opus"
    # ファイル一覧: 鍵・.env・.git は「鍵つき」で中身に入れない
    m = await ask({"type": "fs_list", "id": 5, "path": "repo"})
    items = {i["name"]: i for i in m["items"]}
    assert items[".env"]["locked"] and items["deploy.pem"]["locked"] and items[".git"]["locked"], items
    assert not items["README.md"]["locked"] and items["src"]["dir"], items
    m = await ask({"type": "fs_read", "id": 6, "path": "repo/README.md"})
    assert m["ok"] and m["text"] == "# hello\n" and not m["binary"], m
    m = await ask({"type": "fs_read", "id": 7, "path": "repo/bin.dat"})
    assert m["binary"] and m["text"] == "", m
    for bad in ("repo/.env", "repo/deploy.pem", "repo/.git/config", "../.claude/projects/p/s.jsonl", "/etc/passwd", "repo/etc-link/passwd"):
        m = await ask({"type": "fs_read", "id": 8, "path": bad})
        assert not m["ok"], (bad, m)
    m = await ask({"type": "fs_list", "id": 9, "path": ""})
    assert m["ok"] and [i["name"] for i in m["items"]] == ["repo"], m
    w.close(); srv.close()
    print("bridge app-system OK")

asyncio.run(main())
