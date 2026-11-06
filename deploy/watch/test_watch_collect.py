"""plasmod-watch-collect のテスト。python3 -m unittest deploy/watch/test_watch_collect.py"""
import importlib.machinery
import importlib.util
import json
import os
import sqlite3
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
NOW = 1792500000


def load(env):
    os.environ.update(env)
    loader = importlib.machinery.SourceFileLoader("wc", os.path.join(HERE, "plasmod-watch-collect"))
    spec = importlib.util.spec_from_loader("wc", loader)
    m = importlib.util.module_from_spec(spec)
    loader.exec_module(m)
    return m


class WatchCollectTest(unittest.TestCase):
    def setUp(self):
        d = self.dir = tempfile.mkdtemp()
        hh = os.path.join(d, "hermes")
        os.makedirs(os.path.join(hh, "profiles", "auditor", "cron"))
        os.makedirs(os.path.join(d, "history"))
        os.makedirs(os.path.join(d, "deploy"))
        app = os.path.join(d, "app.db")
        c = sqlite3.connect(app)
        c.executescript("""
          CREATE TABLE decisions (id INTEGER PRIMARY KEY, key TEXT, choice TEXT, text TEXT, card_created_at INTEGER, decided_at INTEGER, via TEXT, ok INTEGER, error TEXT);
          CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, body TEXT, source TEXT, created_at INTEGER, done_at INTEGER);
          CREATE TABLE notifications (key TEXT PRIMARY KEY, token TEXT, first_sent INTEGER, last_sent INTEGER, attempts INTEGER, escalated INTEGER, seen_at INTEGER);
        """)
        ms = NOW * 1000
        c.execute("INSERT INTO decisions VALUES (1,'task:t1','approve','急いで',?,?, 'app',1,NULL)", (ms - 7200_000, ms - 3600_000))
        c.execute("INSERT INTO decisions VALUES (2,'inbox:t2','later','',?,?, 'apk',1,NULL)", (ms - 600_000, ms - 300_000))
        c.execute("INSERT INTO decisions VALUES (3,'task:t3','complete','',?,?, 'app',0,'token=abcdefghijklmnop 失敗')", (ms - 600_000, ms - 200_000))
        c.execute("INSERT INTO decisions VALUES (4,'task:old','approve','昔',?,?, 'app',1,NULL)", (ms - 30 * 86400_000, ms - 20 * 86400_000))
        c.execute("INSERT INTO notes VALUES (1,'旅の準備','パスポートを更新する sk_live_abcdefghijklmnopqrstu','report',?,NULL)", (ms - 1000,))
        c.execute("INSERT INTO notifications VALUES ('task:t1','x',?,?,3,1,?)", (ms - 7000_000, ms - 6000_000, ms - 3600_000))
        c.commit()
        k = sqlite3.connect(os.path.join(hh, "kanban.db"))
        k.executescript("""
          CREATE TABLE tasks (id TEXT, title TEXT, assignee TEXT, status TEXT, created_by TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER);
          CREATE TABLE task_events (id INTEGER PRIMARY KEY, task_id TEXT, kind TEXT, created_at INTEGER);
          CREATE TABLE task_runs (id INTEGER PRIMARY KEY, task_id TEXT, profile TEXT, status TEXT, started_at INTEGER, ended_at INTEGER);
        """)
        k.execute("INSERT INTO tasks VALUES ('t1','PR を作る','dev','done','owner',?,?,?)", (NOW - 9000, NOW - 8000, NOW - 4400))
        k.execute("INSERT INTO tasks VALUES ('t9','止まったまま','acct','blocked','default',?,NULL,NULL)", (NOW - 5 * 86400,))
        k.execute("INSERT INTO task_events (task_id, kind, created_at) VALUES ('t1','requeue',?)", (NOW - 100,))
        k.execute("INSERT INTO task_runs (task_id, profile, status, started_at, ended_at) VALUES ('t1','dev','failed',?,?)", (NOW - 8000, NOW - 7000))
        k.commit()
        s = sqlite3.connect(os.path.join(hh, "state.db"))
        s.executescript("CREATE TABLE sessions (id TEXT, title TEXT, source TEXT, model TEXT, started_at REAL, input_tokens INTEGER, output_tokens INTEGER, actual_cost_usd REAL, estimated_cost_usd REAL);")
        s.execute("INSERT INTO sessions VALUES ('s1','旅程の相談','api','gpt',?,100,50,0.5,NULL)", (NOW - 3600,))
        s.execute("INSERT INTO sessions VALUES ('s2','見回り','cron','gpt',?,10,5,NULL,0.1)", (NOW - 3600,))
        s.commit()
        json.dump({"jobs": [{"id": "a", "name": "週次監査（監察）", "schedule_display": "0 9 * * 1", "enabled": True, "last_status": "error",
                             "last_error": "insufficient credits", "failure_streak": 3}]},
                  open(os.path.join(hh, "profiles", "auditor", "cron", "jobs.json"), "w"))
        with open(os.path.join(d, "history", "123.jsonl"), "w") as f:
            f.write(json.dumps({"author": "owner", "content": "Cron を見たい", "at": NOW - 7200}) + "\n")
            f.write(json.dumps({"author": "dev", "content": "了解", "at": NOW - 7100}) + "\n")
            f.write(json.dumps({"author": "owner", "content": "お願い", "at": NOW - 7000}) + "\n")
        open(os.path.join(d, "deploy", "build.log"), "w").write("✓ built in 2.75s\n✓ built in 3.10s\n")
        self.m = load({"WATCH_NOW": str(NOW), "WATCH_OUT": os.path.join(d, "out"), "WATCH_APP_DB": app, "WATCH_APP_ENV": os.path.join(d, "env"),
                       "WATCH_HERMES_HOME": hh, "WATCH_BRIDGE_HISTORY": os.path.join(d, "history"), "WATCH_DEPLOY_DIR": os.path.join(d, "deploy")})
        os.utime(os.path.join(d, "history", "123.jsonl"), (NOW, NOW))

    def test_its(self):
        t = self.m.build_its()
        self.assertIn("判断: 3 件（失敗 1 件）", t)
        self.assertIn("task: カードができてから判断まで 1件・中央 60分", t)
        self.assertIn("「あとで」: 1 回", t)
        self.assertIn("再送あり 1", t)
        self.assertIn("dev: 着手から完了まで 1件・中央 60分", t)
        self.assertIn("3日以上: t9 blocked", t)
        self.assertIn("requeue 1", t)
        self.assertIn("うまくいかなかった 1", t)
        self.assertIn("default: セッション 2", t)
        self.assertIn("$0.60", t)
        self.assertIn("連続失敗 3", t)
        self.assertIn("2.75, 3.10", t)
        self.assertNotIn("abcdefghijklmnop", t)

    def test_strategy(self):
        t = self.m.build_strategy()
        self.assertIn("旅の準備", t)
        self.assertNotIn("sk_live_abcdefghijklmnopqrstu", t)
        self.assertIn("approve: 急いで", t)
        self.assertNotIn("昔", t)
        self.assertIn("発言 2: Cron を見たい", t)
        self.assertNotIn("了解", t)
        self.assertIn("default: 旅程の相談", t)
        self.assertNotIn("見回り", t)
        self.assertIn("→ dev（done）: PR を作る", t)

    def test_one_section_failing_does_not_stop_others(self):
        self.m.APP_DB = os.path.join(self.dir, "broken.db")
        open(self.m.APP_DB, "w").write("これは DB ではない")
        t = self.m.build_its()
        self.assertIn("読めなかった", t)
        self.assertIn("## カンバン", t)

    def test_write(self):
        self.m.main()
        out = os.path.join(self.dir, "out")
        self.assertEqual(sorted(os.listdir(out)), ["its.md", "strategy.md"])
        self.assertEqual(os.stat(os.path.join(out, "its.md")).st_mode & 0o777, 0o640)

    def test_mask(self):
        self.assertEqual(self.m.mask("Authorization: Bearer abc"), "[伏せ字] abc")
        self.assertIn("[伏せ字]", self.m.mask("ghp_abcdefghijklmnop1234"))
        self.assertEqual(self.m.mask("あ" * 300, 10), "あ" * 10 + "…")


if __name__ == "__main__":
    unittest.main()
