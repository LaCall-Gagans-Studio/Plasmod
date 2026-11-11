"""broker の読み取り（board / latest-event）と引数の検査。python3 -m unittest tests/test_broker.py"""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import sqlite3
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("broker", os.path.join(HERE, "..", "broker", "plasmod-broker"))
spec = importlib.util.spec_from_loader("broker", loader)
broker = importlib.util.module_from_spec(spec)
loader.exec_module(broker)
broker.CONF_FILE = "/nonexistent"  # この機械の設定を読まない

SCHEMA = """
CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT, status TEXT NOT NULL,
  priority INTEGER DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
  last_heartbeat_at INTEGER, block_kind TEXT, result TEXT);
CREATE TABLE task_links (parent_id TEXT NOT NULL, child_id TEXT NOT NULL);
CREATE TABLE task_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER, kind TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL);
CREATE TABLE task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, profile TEXT, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, last_heartbeat_at INTEGER);
"""


def run(*argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        broker.main(list(argv))
    return out.getvalue()


class BrokerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        broker.KANBAN_DB = os.path.join(self.dir, "kanban.db")
        now = int(time.time())
        c = sqlite3.connect(broker.KANBAN_DB)
        c.executescript(SCHEMA)
        rows = [
            ("t1", "止まっている", "blocked", None),
            ("t2", "最近終わった", "done", now - 3600),
            ("t3", "昔に終わった", "done", now - 10 * 86400),
            ("t4", "アーカイブ", "archived", None),
            ("t5", "実行中", "running", None),
        ]
        for tid, title, status, done_at in rows:
            c.execute("INSERT INTO tasks (id, title, status, assignee, created_at, completed_at) VALUES (?, ?, ?, 'dev', ?, ?)",
                      (tid, title, status, now - 7200, done_at))
        c.execute("INSERT INTO task_comments (task_id, author, body, created_at) VALUES ('t1', 'dev', '古い', ?)", (now - 100,))
        c.execute("INSERT INTO task_comments (task_id, author, body, created_at) VALUES ('t1', 'dev', '承認がほしい', ?)", (now,))
        c.execute("INSERT INTO task_links VALUES ('t2', 't1')")
        c.execute("INSERT INTO task_links VALUES ('t3', 't4')")
        c.execute("INSERT INTO task_runs (task_id, profile, status, started_at) VALUES ('t5', 'dev', 'running', ?)", (now,))
        c.execute("INSERT INTO task_runs (task_id, profile, status, started_at, ended_at) VALUES ('t2', 'dev', 'done', ?, ?)", (now, now))
        for _ in range(7):
            c.execute("INSERT INTO task_events (task_id, kind, created_at) VALUES ('t1', 'x', ?)", (now,))
        c.commit()
        c.close()

    def test_board(self):
        b = json.loads(run("board"))
        self.assertEqual(sorted(t["id"] for t in b["tasks"]), ["t1", "t2", "t5"])
        t1 = next(t for t in b["tasks"] if t["id"] == "t1")
        self.assertEqual(t1["latest_comment"]["body"], "承認がほしい")
        self.assertEqual(b["links"], [{"parent_id": "t2", "child_id": "t1"}])
        self.assertEqual([r["task_id"] for r in b["active_runs"]], ["t5"])
        self.assertEqual(b["latest_event_id"], 7)

    def test_latest_event(self):
        self.assertEqual(run("latest-event").strip(), "7")

    def test_rejects_bad_ids_and_ops(self):
        for argv in (["unblock", "t1; rm -rf /"], ["comment", "../x", "hi"], ["delete", "t1"], ["board", "extra"]):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                run(*argv)

    def test_writes_go_through_hermes_cli(self):
        calls = []
        broker.kanban = lambda *a: calls.append(a)
        run("comment", "t1", "進めて")
        run("unblock", "t1")
        run("complete", "t1", "OK")
        self.assertEqual(calls, [("comment", "--author", "owner", "t1", "進めて"), ("unblock", "t1"),
                                 ("complete", "--result", "OK", "--force", "t1")])


class BrokerEndpointsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.old = broker.HERMES_HOME
        broker.HERMES_HOME = self.dir
        os.makedirs(os.path.join(self.dir, "profiles", "acct"))
        os.makedirs(os.path.join(self.dir, "profiles", "nokey"))
        open(os.path.join(self.dir, ".env"), "w").write("API_SERVER_KEY=k-default\nOTHER_TOKEN=secret\n")
        open(os.path.join(self.dir, "profiles", "acct", ".env"), "w").write("API_SERVER_KEY='k-acct'\n")
        open(os.path.join(self.dir, "profiles", "nokey", ".env"), "w").write("OTHER=x\n")

    def tearDown(self):
        broker.HERMES_HOME = self.old

    def run_it(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            broker.endpoints()
        return json.loads(out.getvalue())

    def test_multiplex(self):
        open(os.path.join(self.dir, "config.yaml"), "w").write("gateway:\n  multiplex_profiles: true\n")
        self.assertEqual(self.run_it(), {
            "default": {"url": "http://127.0.0.1:8642", "key": "k-default"},
            "acct": {"url": "http://127.0.0.1:8642/p/acct", "key": "k-acct"},
        })

    def test_separate_ports_and_only_api_key_is_read(self):
        open(os.path.join(self.dir, "profiles", "acct", ".env"), "w").write("API_SERVER_KEY=k\nAPI_SERVER_PORT=8700\n")
        got = self.run_it()
        self.assertEqual(got["acct"]["url"], "http://127.0.0.1:8700")
        self.assertNotIn("secret", json.dumps(got))
        self.assertNotIn("nokey", got)


class BrokerWriteTest(unittest.TestCase):
    def setUp(self):
        # 本物の ~/.hermes には書かない
        self._work_tmp = broker.WORK_TMP
        broker.WORK_TMP = os.path.join(tempfile.mkdtemp(), "plasmod-tmp")

    def tearDown(self):
        broker.WORK_TMP = self._work_tmp

    def test_attach_writes_temp_file_inside_hermes_not_tmp(self):
        """アプリのサービスは /tmp が読み取り専用（ProtectSystem=strict）。一時ファイルは WORK_TMP に置く"""
        work = os.path.join(tempfile.mkdtemp(), "plasmod-tmp")
        seen = []
        orig = broker.WORK_TMP, broker.kanban, broker.sys.stdin
        broker.WORK_TMP = work
        broker.kanban = lambda *a: seen.append((a, open(a[-1], "rb").read()))
        broker.sys.stdin = type("S", (), {"buffer": io.BytesIO(b"PK\x03\x04xlsx")})()
        try:
            run("attach", "t1", "分析.xlsx")
        finally:
            broker.WORK_TMP, broker.kanban, broker.sys.stdin = orig
        (args, data), = seen
        self.assertEqual(args[:5], ("attach", "--author", "owner", "--name", "分析.xlsx"))
        self.assertTrue(args[-1].startswith(work + "/gh-attach-"))
        self.assertEqual(data, b"PK\x03\x04xlsx")
        self.assertEqual(os.listdir(work), [])  # 終わったら消す
        self.assertEqual(broker.ENV["TMPDIR"], self._work_tmp)

    def test_create_parses_id_and_checks_assignee(self):
        calls = []
        class R:
            returncode = 0
            stdout = "Created t_9f3a (ready)\n"
            stderr = ""
        orig = broker.subprocess.run
        broker.subprocess.run = lambda args, **kw: (calls.append(args), R())[1]
        try:
            self.assertEqual(run("create", "宿を比較", "本文", "acct1").strip(), "t_9f3a")
            self.assertIn("--assignee", calls[0])
            self.assertEqual(calls[0][calls[0].index("--created-by") + 1], "owner")
            for bad in ("Acct1", "../x", "a b", ""):
                with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                    run("create", "t", "b", bad)
        finally:
            broker.subprocess.run = orig

    def test_attach_reads_stdin_and_cleans_up(self):
        seen = {}
        def fake(*a):
            path = a[-1]
            seen["args"] = a
            with open(path, "rb") as f:
                seen["data"] = f.read()
            seen["path"] = path
        broker.kanban = fake
        import sys as _sys
        orig = _sys.stdin
        _sys.stdin = type("S", (), {"buffer": io.BytesIO(b"PNGDATA")})()
        try:
            run("attach", "t_1", "スクショ.png")
        finally:
            _sys.stdin = orig
        self.assertEqual(seen["data"], b"PNGDATA")
        self.assertEqual(seen["args"][:6], ("attach", "--author", "owner", "--name", "スクショ.png", "t_1"))
        self.assertFalse(os.path.exists(seen["path"]))
        for bad in ("../etc/passwd", ".env", "a/b"):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                run("attach", "t_1", bad)

    def test_attach_rejects_too_large(self):
        broker.kanban = lambda *a: None
        broker.MAX_ATTACH = 4
        import sys as _sys
        orig = _sys.stdin
        _sys.stdin = type("S", (), {"buffer": io.BytesIO(b"12345")})()
        try:
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                run("attach", "t_1", "a.txt")
        finally:
            _sys.stdin = orig
            broker.MAX_ATTACH = 25 * 1024 * 1024


class BrokerPutFileTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        broker.HERMES_HOME = self.home
        broker.INBOX_DIR = os.path.join(self.home, "plasmod-inbox")

    def put(self, name, data):
        import sys as _sys
        orig = _sys.stdin
        _sys.stdin = type("S", (), {"buffer": io.BytesIO(data)})()
        try:
            return run("put-file", name).strip()
        finally:
            _sys.stdin = orig

    def test_puts_file_and_returns_path(self):
        path = self.put("予約.pdf", b"%PDF")
        self.assertTrue(path.startswith(broker.INBOX_DIR + "/") and path.endswith("-予約.pdf"))
        self.assertEqual(open(path, "rb").read(), b"%PDF")

    def test_rejects_bad_names(self):
        for bad in ("../x", ".env", "a/b", ""):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                self.put(bad, b"x")

    def test_sweeps_old_files(self):
        os.makedirs(broker.INBOX_DIR)
        old = os.path.join(broker.INBOX_DIR, "old.txt")
        open(old, "w").write("x")
        t = time.time() - 31 * 86400
        os.utime(old, (t, t))
        self.put("new.txt", b"y")
        self.assertFalse(os.path.exists(old))


class BrokerMediaTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        broker.HERMES_HOME = os.path.realpath(self.home)
        self.home = broker.HERMES_HOME
        broker.MEDIA_ROOTS_FILE = os.path.join(self.home, "no-such-roots")
        os.makedirs(os.path.join(self.home, "cache"))
        open(os.path.join(self.home, "cache", "chart.png"), "wb").write(b"\x89PNG")
        open(os.path.join(self.home, ".env"), "w").write("KEY=x\n")
        open(os.path.join(self.home, "state.db"), "wb").write(b"SQLite")
        os.symlink("/etc/hostname", os.path.join(self.home, "cache", "link.png"))

    def read(self, path):
        class Out:
            def __init__(self):
                self.buffer = io.BytesIO()
        import sys as _sys
        orig = _sys.stdout
        _sys.stdout = Out()
        try:
            broker.main(["media-read", path])
            return _sys.stdout.buffer.getvalue()
        finally:
            _sys.stdout = orig

    def test_reads_inside_hermes_home(self):
        self.assertEqual(self.read(os.path.join(self.home, "cache", "chart.png")), b"\x89PNG")

    def test_rejects_outside_secrets_symlinks_and_relative(self):
        for bad in ("/etc/passwd", os.path.join(self.home, ".env"), os.path.join(self.home, "state.db"),
                    os.path.join(self.home, "cache", "link.png"), os.path.join(self.home, "..", "x"), "cache/chart.png",
                    self.home, os.path.join(self.home, "nope.png")):
            with self.assertRaises(SystemExit, msg=bad), contextlib.redirect_stderr(io.StringIO()):
                self.read(bad)

    def test_too_large(self):
        broker.MEDIA_MAX = 2
        try:
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                self.read(os.path.join(self.home, "cache", "chart.png"))
        finally:
            broker.MEDIA_MAX = 15 * 1024 * 1024

    def test_extra_roots_only_under_home_or_tmp(self):
        extra = tempfile.mkdtemp(dir="/tmp")
        open(os.path.join(extra, "a.png"), "wb").write(b"A")
        roots = os.path.join(self.home, "roots")
        open(roots, "w").write(extra + "\n/etc\n/\n")
        broker.MEDIA_ROOTS_FILE = roots
        self.assertEqual(self.read(os.path.join(os.path.realpath(extra), "a.png")), b"A")
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            self.read("/etc/hostname")


class BrokerSystemTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        broker.HERMES_HOME = self.home
        os.makedirs(os.path.join(self.home, "profiles", "acct1"))
        os.makedirs(os.path.join(self.home, "skills", "mail"))
        open(os.path.join(self.home, "config.yaml"), "w").write("model:\n  default: hermes\n")
        open(os.path.join(self.home, ".env"), "w").write("API_SERVER_KEY=x\n")
        open(os.path.join(self.home, "auth.json"), "w").write("{}")
        now = time.time()
        for home, rows in ((self.home, [(now - 3600, 100, 10, 0.5, "nous/hermes"), (now - 6 * 86400, 1000, 0, 1.0, "nous/hermes")]),
                           (os.path.join(self.home, "profiles", "acct1"), [(now - 40 * 86400, 5, 5, 0, "x")])):
            c = sqlite3.connect(os.path.join(home, "state.db"))
            c.execute("CREATE TABLE sessions (id TEXT, started_at REAL, input_tokens INT, output_tokens INT, cache_write_tokens INT, "
                      "estimated_cost_usd REAL, actual_cost_usd REAL, model TEXT)")
            for i, (t, inp, out, cost, model) in enumerate(rows):
                c.execute("INSERT INTO sessions VALUES (?, ?, ?, ?, 0, ?, NULL, ?)", (str(i), t, inp, out, cost, model))
            c.commit()
            c.close()
        broker.MODELS_FILE = os.path.join(self.home, "models.json")
        json.dump({"acct1": [{"provider": "nous", "model": "hermes-4"}, {"provider": "openai-codex", "model": "gpt-5"}]},
                  open(broker.MODELS_FILE, "w"))

    def test_usage_windows(self):
        u = json.loads(run("usage"))
        self.assertEqual(u["default"]["h5"]["tokens"], 110)
        self.assertEqual(u["default"]["d7"]["tokens"], 1110)
        self.assertAlmostEqual(u["default"]["d30"]["cost"], 1.5)
        self.assertEqual(u["acct1"]["d30"]["sessions"], 0)

    def test_set_model_only_from_allow_list(self):
        calls = []
        broker.hermes_cfg = lambda profile, *a: calls.append((profile, a)) or ""
        out = json.loads(run("set-model", "acct1", "1"))
        self.assertEqual(out, {"profile": "acct1", "provider": "openai-codex", "model": "gpt-5"})
        self.assertEqual(calls, [("acct1", ("set", "model.provider", "openai-codex")), ("acct1", ("set", "model.default", "gpt-5"))])
        for bad in (("acct1", "2"), ("acct1", "-1"), ("default", "0"), ("nobody", "0"), ("acct1", "x")):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                run("set-model", *bad)

    def test_fs_hides_secrets_and_stays_inside(self):
        items = {i["name"]: i for i in json.loads(run("fs-list", ""))["items"]}
        self.assertTrue(items[".env"]["locked"] and items["auth.json"]["locked"] and items["state.db"]["locked"])
        self.assertFalse(items["config.yaml"]["locked"])
        self.assertIn("default: hermes", json.loads(run("fs-read", "config.yaml"))["text"])
        os.symlink("/etc", os.path.join(self.home, "etc-link"))
        for bad in (".env", "auth.json", "state.db", "profiles/acct1/state.db", "../../etc/passwd", "/etc/passwd", "etc-link/passwd"):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                run("fs-read", bad)


class BrokerDetailTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        broker.KANBAN_DB = os.path.join(self.dir, "kanban.db")
        c = sqlite3.connect(broker.KANBAN_DB)
        c.executescript(SCHEMA)
        c.execute("INSERT INTO tasks (id, title, status, assignee, created_at) VALUES ('t_child', '子', 'ready', 'acct', 1)")
        c.commit()
        c.close()
        broker.ATTACH_ROOT = os.path.join(self.dir, "attachments")
        os.makedirs(os.path.join(broker.ATTACH_ROOT, "t_1"))
        open(os.path.join(broker.ATTACH_ROOT, "t_1", "見積.md"), "w").write("# x")
        open(os.path.join(broker.ATTACH_ROOT, "t_1", ".env"), "w").write("K=1")
        os.symlink("/etc/passwd", os.path.join(broker.ATTACH_ROOT, "t_1", "link"))

    def test_task_detail(self):
        show = {"task": {"id": "t_1", "title": "題", "body": "本文" * 20000, "status": "done", "workspace_path": "/x"},
                "latest_summary": "まとめ", "parents": [], "children": ["t_child", "t_gone"],
                "comments": [{"author": "default", "body": "見た", "created_at": 5}],
                "events": [{"kind": "created", "payload": {"assignee": "dev"}, "created_at": 1, "run_id": None}],
                "runs": [{"id": 9, "profile": "dev", "status": "done", "outcome": "completed", "summary": "済", "error": None,
                          "metadata": {"x": 1}, "started_at": 2, "ended_at": 3}]}
        class R:
            returncode = 0
            stdout = json.dumps(show)
            stderr = ""
        calls = []
        orig = broker.subprocess.run
        broker.subprocess.run = lambda args, **kw: (calls.append(args), R())[1]
        try:
            d = json.loads(run("task", "t_1"))
        finally:
            broker.subprocess.run = orig
        self.assertEqual(calls[0][1:], ["kanban", "show", "--json", "t_1"])
        self.assertNotIn("workspace_path", d["task"])
        self.assertEqual(len(d["task"]["body"]), 20000)
        self.assertEqual(d["children"][0], {"id": "t_child", "title": "子", "status": "ready", "assignee": "acct"})
        self.assertEqual(d["children"][1]["title"], "t_gone")
        self.assertEqual([a["name"] for a in d["attachments"]], ["見積.md"])
        self.assertNotIn("metadata", d["runs"][0])
        self.assertIn("dev", d["events"][0]["detail"])
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            run("task", "../t_1")

    def test_agents(self):
        home = os.path.join(self.dir, "hermes")
        broker.HERMES_HOME = home
        os.makedirs(os.path.join(home, "skills", "mail", "inbox-card"))
        os.makedirs(os.path.join(home, "skills", ".hidden", "x"))
        os.makedirs(os.path.join(home, "profiles", "acct", "skills", "books"))
        open(os.path.join(home, "SOUL.md"), "w").write("私はハブ")
        open(os.path.join(home, "config.yaml"), "w").write("model:\n  default: openai/gpt-6.1-sol\n  provider: nous\n")
        open(os.path.join(home, "skills", "mail", "inbox-card", "SKILL.md"), "w").write(
            "---\nname: inbox-card\ndescription: \"判断が要るものをカードにする\"\n---\n本文")
        open(os.path.join(home, "skills", ".hidden", "x", "SKILL.md"), "w").write("x")
        open(os.path.join(home, "profiles", "acct", "skills", "books", "SKILL.md"), "w").write("見出しだけ")
        asked = []
        broker.hermes_cfg = lambda profile, *a: asked.append(profile) or ("nous" if a[-1] == "model.provider" else "hermes-4")
        out = {a["id"]: a for a in json.loads(run("agents"))}
        # config.yaml に書いてあれば hermes を起動しない（書いていない acct だけ聞く）
        self.assertEqual(out["default"]["model"], {"provider": "nous", "model": "openai/gpt-6.1-sol"})
        self.assertEqual(sorted(set(asked)), ["acct"])
        self.assertEqual(out["default"]["soul"], "私はハブ")
        self.assertEqual(out["default"]["files"], {"soul": "SOUL.md", "config": "config.yaml"})
        self.assertEqual(out["default"]["skills"], [{"name": "inbox-card", "description": "判断が要るものをカードにする",
                                                      "category": "mail", "path": "skills/mail/inbox-card/SKILL.md"}])
        self.assertEqual(out["acct"]["skills"][0]["name"], "books")
        self.assertEqual(out["acct"]["skills"][0]["path"], "profiles/acct/skills/books/SKILL.md")
        self.assertEqual(out["acct"]["model"], {"provider": "nous", "model": "hermes-4"})


FAKE_ACCOUNT = '''
from types import SimpleNamespace as N
def get_nous_portal_account_info(force_fresh=False):
    assert force_fresh
    return N(logged_in=True, paid_service_access=False, error=None, email="secret@example.com",
             paid_service_access_info=N(reason="out_of_credits", subscription_credits_remaining=19.32,
                                        purchased_credits_remaining=0.0, total_usable_credits=19.32),
             subscription=N(plan="Plus", monthly_credits=110.0, current_period_end="2026-11-01T00:00:00Z"))
'''


class BrokerCreditsTest(unittest.TestCase):
    """Hermes の起動コマンドの最後だけ差し替えて、Hermes の中でアカウントの情報を読む"""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.dir, "hermes_cli"))
        open(os.path.join(self.dir, "hermes_cli", "__init__.py"), "w").close()
        open(os.path.join(self.dir, "hermes_cli", "nous_account.py"), "w").write(FAKE_ACCOUNT)
        open(os.path.join(self.dir, "hermes_cli", "main.py"), "w").write("raise SystemExit('main は動かさない')\n")
        self.cmd = ["python3", "-I", "-c", f"import sys, runpy; sys.path.insert(0, {self.dir!r}); "
                    "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)"]
        self.hermes = os.path.join(self.dir, "hermes")
        self.orig = broker.HERMES, broker.ENV
        broker.ENV = {**broker.ENV, "HOME": self.dir}

    def tearDown(self):
        broker.HERMES, broker.ENV = self.orig

    def fake_hermes(self, printed):
        open(self.hermes, "w").write("#!/bin/sh\n[ \"$1\" = --print-runtime-command ] || exit 9\ncat <<'EOF'\n%s\nEOF\n" % printed)
        os.chmod(self.hermes, 0o755)
        broker.HERMES = self.hermes

    def test_credits_reads_account_inside_hermes(self):
        self.fake_hermes(json.dumps(self.cmd))
        out = json.loads(run("credits"))
        self.assertEqual(out["monthly"], 110.0)
        self.assertEqual(out["subscription_remaining"], 19.32)
        self.assertIs(out["paid_access"], False)
        self.assertEqual(out["reason"], "out_of_credits")
        self.assertNotIn("secret@example.com", json.dumps(out))

    def test_credits_refuses_unknown_launcher_shape(self):
        for printed in ("not json", json.dumps(["python3", "-c", "print(1)"])):
            self.fake_hermes(printed)
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                run("credits")


FAKE_PROFILES = '''
import json, os
from pathlib import Path
def read_profile_meta(d):
    f = Path(d) / "meta.json"
    return {"display_name": json.loads(f.read_text())["display_name"] if f.exists() else ""}
def set_profile_display_name(name, display):
    home = Path(os.environ["PLASMOD_PROFILE_HOME"])
    (home / "meta.json").write_text(json.dumps({"display_name": display}))
    with open(os.environ["FAKE_LOG"], "a") as f:
        f.write(json.dumps([name, display]) + "\\n")
'''


class DisplayNameTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.dir, "hermes_cli"))
        open(os.path.join(self.dir, "hermes_cli", "__init__.py"), "w").close()
        open(os.path.join(self.dir, "hermes_cli", "profiles.py"), "w").write(FAKE_PROFILES)
        open(os.path.join(self.dir, "hermes_cli", "main.py"), "w").write("raise SystemExit('main は動かさない')\n")
        self.home = os.path.join(self.dir, ".hermes")
        for n in ("a", "b"):
            os.makedirs(os.path.join(self.home, "profiles", n))
        self.log = os.path.join(self.dir, "log")
        cmd = ["python3", "-I", "-c", f"import sys, runpy; sys.path.insert(0, {self.dir!r}); "
               "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)"]
        self.hermes = os.path.join(self.dir, "hermes")
        open(self.hermes, "w").write("#!/bin/sh\n[ \"$1\" = --print-runtime-command ] || exit 9\ncat <<'EOF'\n%s\nEOF\n" % json.dumps(cmd))
        os.chmod(self.hermes, 0o755)
        self.orig = broker.HERMES, broker.ENV, broker.HERMES_HOME, broker.WORK_TMP
        broker.HERMES, broker.HERMES_HOME, broker.WORK_TMP = self.hermes, self.home, os.path.join(self.dir, "tmp")
        broker.ENV = {**broker.ENV, "HOME": self.dir, "FAKE_LOG": self.log}

    def tearDown(self):
        broker.HERMES, broker.ENV, broker.HERMES_HOME, broker.WORK_TMP = self.orig

    def written(self):
        return [json.loads(l) for l in open(self.log)] if os.path.exists(self.log) else []

    def test_reads_all_profiles(self):
        self.assertEqual(json.loads(run("display-names")), {"default": "", "a": "", "b": ""})

    def test_writes_only_the_display_name(self):
        out = json.loads(run("set-display-name", "a", json.dumps({"name": " 経理 ", "expect": ""})))
        self.assertEqual(out, {"ok": True, "current": "経理"})
        self.assertEqual(self.written(), [["a", "経理"]])
        self.assertEqual(json.loads(run("display-names"))["a"], "経理")

    def test_conflict_when_hermes_changed_it(self):
        run("set-display-name", "a", json.dumps({"name": "Hermes で変えた"}))
        out = json.loads(run("set-display-name", "a", json.dumps({"name": "新しい", "expect": "前に書いた"})))
        self.assertEqual(out, {"ok": False, "conflict": True, "current": "Hermes で変えた"})
        self.assertEqual(self.written(), [["a", "Hermes で変えた"]])
        # 確認なし（上書き）なら書ける
        self.assertTrue(json.loads(run("set-display-name", "a", json.dumps({"name": "新しい"})))["ok"])

    def test_same_value_is_not_rewritten(self):
        run("set-display-name", "a", json.dumps({"name": "x"}))
        out = json.loads(run("set-display-name", "a", json.dumps({"name": "x", "expect": "古い"})))
        self.assertTrue(out["ok"])
        self.assertEqual(len(self.written()), 1)

    def test_rejects_bad_input(self):
        for prof, arg in (("zzz", {"name": "x"}), ("../a", {"name": "x"}), ("a", {"name": ""}), ("a", {"name": "x" * 65}),
                          ("a", {"name": "a\nb"}), ("a", {"name": 1}), ("a", {"name": "x", "expect": 1})):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                run("set-display-name", prof, json.dumps(arg))
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            run("set-display-name", "a", "not json")
        self.assertEqual(self.written(), [])


FAKE_KANBAN_DB = '''
import json, os
def specify_triage_task(conn, task_id, *, title=None, body=None, assignee=None, author=None):
    with open(os.environ["FAKE_LOG"], "a") as f:
        f.write(json.dumps([task_id, assignee, author, title, body]) + "\\n")
    return task_id == "t_triage"
'''
FAKE_KANBAN_CONNECT = '''
import contextlib
@contextlib.contextmanager
def connect_closing():
    yield object()
'''


class BrokerTriageTest(BrokerCreditsTest):
    """仕分け待ちのカード: specify は Hermes の中で specify_triage_task を呼ぶ／archive は CLI"""

    def setUp(self):
        super().setUp()
        open(os.path.join(self.dir, "hermes_cli", "kanban_db.py"), "w").write(FAKE_KANBAN_DB)
        open(os.path.join(self.dir, "hermes_cli", "kanban_db_connect.py"), "w").write(FAKE_KANBAN_CONNECT)
        self.log = os.path.join(self.dir, "log")
        broker.ENV = {**broker.ENV, "FAKE_LOG": self.log}
        self.orig_home = broker.HERMES_HOME
        broker.HERMES_HOME = os.path.join(self.dir, ".hermes")
        os.makedirs(os.path.join(broker.HERMES_HOME, "profiles", "design"))

    def tearDown(self):
        broker.HERMES_HOME = self.orig_home
        super().tearDown()

    def calls(self):
        return [json.loads(l) for l in open(self.log)] if os.path.exists(self.log) else []

    def test_specify_moves_triage_with_assignee(self):
        self.fake_hermes(json.dumps(self.cmd))
        run("specify", "t_triage", "design")
        run("specify", "t_triage", "dev")
        # 題名・本文は変えない。author はオーナーさん
        self.assertEqual(self.calls(), [["t_triage", "design", "owner", None, None], ["t_triage", "dev", "owner", None, None]])

    def test_specify_fails_when_not_triage(self):
        self.fake_hermes(json.dumps(self.cmd))
        err = io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(err):
            run("specify", "t_other", "default")
        self.assertIn("仕分けられなかった", err.getvalue())

    def test_specify_rejects_unknown_assignee(self):
        self.fake_hermes(json.dumps(self.cmd))
        for who in ("nobody", "../x", "owner"):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                run("specify", "t_triage", who)
        self.assertEqual(self.calls(), [])

    def test_archive_calls_cli(self):
        calls = []
        orig = broker.kanban
        broker.kanban = lambda *a: calls.append(a)
        try:
            run("archive", "t_triage")
        finally:
            broker.kanban = orig
        self.assertEqual(calls, [("archive", "t_triage")])
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            run("archive", "t1; rm -rf /")


SECRET = "s3cr3t-VALUE-0123456789"


class ConnectionsTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.keep = (broker.HERMES_HOME,)
        broker.HERMES_HOME = self.home
        self.addCleanup(lambda: setattr(broker, "HERMES_HOME", self.keep[0]))
        os.makedirs(os.path.join(self.home, "mcp-tokens"))
        os.makedirs(os.path.join(self.home, "logs"))
        self.write("config.yaml", "model:\n  provider: nous\nmcp_servers:\n  vercel:\n    oauth: {}\n  cf:\n    oauth: true\n    enabled: false\n  ga:\n    command: x\n")

    def write(self, rel, text):
        with open(os.path.join(self.home, rel), "w", encoding="utf-8") as f:
            f.write(text)

    def auth(self, nous):
        self.write("auth.json", json.dumps({"providers": {"nous": nous}}))

    def result(self):
        out = run("connections")
        self.assertNotIn(SECRET, out)
        return json.loads(out)

    def test_values_never_leave(self):
        self.auth({"access_token": SECRET, "refresh_token": SECRET, "obtained_at": "2026-11-06T05:17:11+00:00"})
        self.write("mcp-tokens/vercel.json", json.dumps({"access_token": SECRET, "refresh_token": SECRET, "expires_at": 4000000000}))
        self.write("logs/gateway.log", f"2026-11-06 10:00:00,000 WARNING mcp: vercel refresh failed token={SECRET}\n")
        r = self.result()
        self.assertEqual(r["nous"], {"logged_in": True, "obtained_at": "2026-11-06T05:17:11+00:00"})
        v = r["mcp"]["default"]["vercel"]
        self.assertTrue(v["oauth"])
        self.assertEqual((v["token"]["refresh"], v["token"]["expires_at"]), (True, 4000000000))
        self.assertEqual(v["log_error"]["reason"], "refresh failed")
        self.assertFalse(r["mcp"]["default"]["ga"]["oauth"])
        self.assertFalse(r["mcp"]["default"]["cf"]["enabled"])

    def test_quarantined_nous(self):
        self.auth({"last_auth_error": {"code": "invalid_grant", "relogin_required": True}})
        self.write("logs/agent.log", f"2026-11-06 11:00:53,006 WARNING hermes_cli.auth: Nous OAuth state quarantined (terminal auth death): {{\"refresh_token_fp\": \"{SECRET}\"}}\n")
        r = self.result()["nous"]
        self.assertFalse(r["logged_in"])
        self.assertEqual(r["error"], "invalid_grant")
        self.assertIsInstance(r["error_at"], int)

    def test_no_nous_login(self):
        self.assertEqual(self.result()["nous"], {"logged_in": False, "error": "ログインしていない"})
        self.write("config.yaml", "model:\n  provider: other\n")
        self.assertIsNone(self.result()["nous"])

    def test_does_not_follow_links_or_match_other_servers(self):
        target = os.path.join(self.home, "secret.json")
        self.write("secret.json", json.dumps({"access_token": SECRET}))
        os.symlink(target, os.path.join(self.home, "mcp-tokens", "vercel.json"))
        self.write("logs/gateway.log", "2026-11-06 10:00:00,000 WARNING mcp: vercel-old refresh failed\n2026-11-06 10:00:00,000 INFO mcp: vercel refresh failed\n")
        v = self.result()["mcp"]["default"]["vercel"]
        self.assertTrue(v["token"]["exists"])
        self.assertNotIn("access", v["token"])
        self.assertIsNone(v["log_error"])


if __name__ == "__main__":
    unittest.main()


class BrokerCronTest(unittest.TestCase):
    """定期実行の一覧。送り先の ID は出さず、プロファイルごとに jobs.json を読む"""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.orig = broker.HERMES_HOME
        broker.HERMES_HOME = self.dir
        os.makedirs(os.path.join(self.dir, "cron"))
        os.makedirs(os.path.join(self.dir, "profiles", "ops", "cron"))
        os.makedirs(os.path.join(self.dir, "profiles", "acct"))
        os.makedirs(os.path.join(self.dir, "profiles", "design", "cron"))
        jobs = {"jobs": [
            {"id": "f430d6d69d61", "name": "見回り", "prompt": "受信箱を見る", "skills": ["inbox-card"],
             "schedule": {"kind": "cron", "expr": "0 8,12,17,21 * * *", "display": "0 8,12,17,21 * * *"},
             "repeat": {"times": None, "completed": 4}, "enabled": True, "state": "scheduled",
             "next_run_at": "2026-10-20T21:00:00+09:00", "last_run_at": "2026-10-20T17:00:03+09:00",
             "last_status": "ok", "last_error": None, "deliver": "telegram:1234567890", "origin": {"chat_id": "999"}},
            {"id": "aaa", "name": "止めたもの", "prompt": "x", "schedule": {"kind": "interval", "minutes": 30, "display": "every 30m"},
             "enabled": False, "state": "scheduled", "deliver": ["origin", "telegram:-100"]},
            "壊れた行",
        ]}
        json.dump(jobs, open(os.path.join(self.dir, "cron", "jobs.json"), "w"))
        json.dump({"jobs": [{"id": "b", "name": "週次", "schedule_display": "0 9 * * 1", "last_status": "error",
                             "last_error": "E" * 900, "failure_streak": 2}]},
                  open(os.path.join(self.dir, "profiles", "ops", "cron", "jobs.json"), "w"))
        open(os.path.join(self.dir, "profiles", "design", "cron", "jobs.json"), "w").write("{壊れ")

    def tearDown(self):
        broker.HERMES_HOME = self.orig

    def test_cron(self):
        out = json.loads(run("cron"))
        self.assertEqual(sorted(out), ["acct", "default", "design", "ops"])
        self.assertEqual(out["acct"], [])
        self.assertIn("error", out["design"])
        a, b = out["default"]
        self.assertEqual(a["schedule"], "0 8,12,17,21 * * *")
        self.assertEqual(a["skills"], ["inbox-card"])
        self.assertEqual(a["deliver"], ["telegram"])
        self.assertEqual(a["state"], "scheduled")
        self.assertNotIn("origin", a)
        self.assertNotIn("1234567890", json.dumps(out))
        self.assertEqual(b["state"], "paused")
        self.assertFalse(b["enabled"])
        self.assertEqual(b["schedule"], "every 30m")
        self.assertEqual(b["deliver"], ["origin", "telegram"])
        c = out["ops"][0]
        self.assertEqual(c["schedule"], "0 9 * * 1")
        self.assertEqual(len(c["last_error"]), 500)
        self.assertEqual(c["failure_streak"], 2)

    def test_cron_output(self):
        out_dir = os.path.join(self.dir, "profiles", "ops", "cron", "output")
        os.makedirs(os.path.join(out_dir, "b"))
        os.makedirs(os.path.join(out_dir, "gone"))
        os.makedirs(os.path.join(out_dir, "..x"))
        for i, (job, name, text) in enumerate([
            ("b", "2026-10-13_09-00-00.md", "# Cron Job: 週次\n\n## Prompt\n\n監査して\n\n## Response\n\n先週の報告"),
            ("b", "2026-10-20_09-00-00.md", "# Cron Job: 週次\n\n## Prompt\n\n監査して\n\n## Response\n\n## 今週\n問題なし"),
            ("gone", "2026-10-19_09-00-00.md", "# Cron Job: gone (FAILED)\n\nError: x\n"),
        ]):
            p = os.path.join(out_dir, job, name)
            open(p, "w").write(text)
            os.utime(p, (1000 + i, 1000 + i))
        open(os.path.join(out_dir, "b", ".output_tmp.md"), "w").write("書きかけ")
        out = json.loads(run("cron-output", "ops"))
        self.assertEqual([(o["job"], o["at"]) for o in out], [("gone", 1002), ("b", 1001), ("b", 1000)])
        self.assertEqual(out[1]["text"], "## 今週\n問題なし")
        self.assertEqual(out[1]["name"], "週次")
        self.assertFalse(out[0]["ok"])
        self.assertEqual(out[0]["name"], "gone")
        self.assertEqual(json.loads(run("cron-output", "acct")), [])
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            run("cron-output", "../x")
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            run("cron-output", "nobody")
