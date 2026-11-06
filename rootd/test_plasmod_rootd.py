"""plasmod-rootd のテスト。root は要らない（実行も自分の uid）。  python3 -m unittest rootd/test_plasmod_rootd.py

承認する側と依頼する側が同じ uid になってしまうので、uid の判定は Handlers に注入して確かめる。
"""
import base64
import importlib.machinery
import importlib.util
import json
import os
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("ghrootd", os.path.join(HERE, "plasmod-rootd"))
spec = importlib.util.spec_from_loader("ghrootd", loader)
g = importlib.util.module_from_spec(spec)
loader.exec_module(g)

ME = os.getuid()
PW = "correct horse battery"


class FakeNotifier:
    def __init__(self):
        self.sent = []

    def send(self, title, message, priority=4, tags=(), click_path="/#/root"):
        self.sent.append((title, message))


def b64(s):
    return base64.b64encode(s if isinstance(s, bytes) else s.encode()).decode()


def call(path, req):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(20)
    s.connect(path)
    s.sendall(json.dumps(req).encode() + b"\n")
    buf = b""
    while not buf.endswith(b"\n"):
        c = s.recv(65536)
        if not c:
            break
        buf += c
    s.close()
    return json.loads(buf)


class Base(unittest.TestCase):
    requesters = {ME}
    approvers = {ME}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.tmp.name
        self.cfg = g.Config(state_dir=f"{t}/state", log_dir=f"{t}/log", run_dir=f"{t}/run", passwd_file=f"{t}/etc/passwd", app_env=f"{t}/none")
        os.makedirs(self.cfg.state_dir)
        os.makedirs(self.cfg.run_dir)
        g.write_password_file(self.cfg.passwd_file, PW, n=16)
        self.now = [1_000_000.0]
        self.notes = FakeNotifier()
        self.engine = g.Engine(self.cfg, notifier=self.notes, clock=lambda: self.now[0])
        self.h = g.Handlers(self.engine, lambda: set(self.requesters), lambda: set(self.approvers))
        self.req = g.make_server(f"{self.cfg.run_dir}/req.sock", "req", self.h)
        self.app = g.make_server(f"{self.cfg.run_dir}/app.sock", "app", self.h, None, 0o600)
        for s in (self.req, self.app):
            threading.Thread(target=s.serve_forever, args=(0.05,), daemon=True).start()
        self.rs, self.as_ = f"{self.cfg.run_dir}/req.sock", f"{self.cfg.run_dir}/app.sock"

    def tearDown(self):
        for s in (self.req, self.app):
            s.shutdown()
            s.server_close()
        self.tmp.cleanup()

    def submit(self, script="echo hi", **kw):
        r = call(self.rs, {"op": "submit", "title": kw.pop("title", "テスト"), "reason": "r", "script_b64": b64(script), **kw})
        self.assertTrue(r["ok"], r)
        return r

    def approve(self, r, password=PW, digest=None):
        return call(self.as_, {"op": "approve", "id": r["id"], "digest": digest or r["digest"], "password": password, "by": "owner"})

    def finish(self, rid):
        self.engine.wait_idle()
        return call(self.rs, {"op": "status", "id": rid})

    def test_owner_command_runs_with_password_only_from_app_socket(self):
        r = call(self.as_, {"op": "run", "command": "echo はい\nid -u", "password": PW, "by": "owner"})
        self.assertTrue(r["ok"], r)
        self.engine.wait_idle()
        got = call(self.as_, {"op": "get", "id": r["id"]})
        self.assertEqual(got["status"], "done", got)
        self.assertIn("はい", got["stdout"])
        self.assertIn("オーナーのコマンド", got["title"])
        # パスワードが違えば実行せず、依頼も残さない
        bad = call(self.as_, {"op": "run", "command": "touch /tmp/never", "password": "wrong", "by": "owner"})
        self.assertFalse(bad["ok"])
        self.assertEqual([x for x in call(self.as_, {"op": "list"})["requests"] if x["status"] == "pending"], [])
        # 空・長すぎるものは断る。エージェントの受け口からは使えない
        self.assertEqual(call(self.as_, {"op": "run", "command": "  ", "password": PW})["code"], "bad_arg")
        self.assertEqual(call(self.as_, {"op": "run", "command": "x" * 8001, "password": PW})["code"], "bad_arg")
        self.assertEqual(call(self.rs, {"op": "run", "command": "id", "password": PW})["code"], "bad_op")


class Access(Base):
    def test_fake_uid_cannot_use_either_socket(self):
        self.requesters = {ME + 1}
        self.approvers = {ME + 2}
        self.assertEqual(call(self.rs, {"op": "submit", "title": "x", "script_b64": b64("id")})["code"], "forbidden")
        self.assertEqual(call(self.as_, {"op": "list"})["code"], "forbidden")
        self.assertEqual(call(self.as_, {"op": "approve", "id": "x", "digest": "x", "password": PW})["code"], "forbidden")
        self.assertEqual(self.engine.all_ids(), [])

    def test_requester_cannot_use_app_socket_and_approver_cannot_submit(self):
        self.approvers = {ME + 2}
        self.assertEqual(call(self.as_, {"op": "list"})["code"], "forbidden")
        self.requesters = {ME + 1}
        self.approvers = {ME}
        self.assertEqual(call(self.rs, {"op": "submit", "title": "x", "script_b64": b64("id")})["code"], "forbidden")

    def test_ops_do_not_cross_sockets(self):
        r = self.submit()
        self.assertEqual(call(self.rs, {"op": "approve", "id": r["id"], "digest": r["digest"], "password": PW})["code"], "bad_op")
        self.assertEqual(call(self.as_, {"op": "submit", "title": "x", "script_b64": b64("id")})["code"], "bad_op")

    def test_requester_sees_only_own_requests(self):
        r = self.submit()
        m = self.engine._load(r["id"])
        m["requester_uid"] = ME + 5
        self.engine._save(m)
        self.assertEqual(call(self.rs, {"op": "status", "id": r["id"]})["code"], "not_found")

    def test_overlapping_roles_refuse_to_start(self):
        c = g.Config(requesters=["root"], approver="root")
        with self.assertRaises(SystemExit):
            c.validate()

    def test_bad_id_is_not_a_path(self):
        for bad in ("../../etc", "x", "20250101000000-zzzzzz", None, 5):
            self.assertFalse(call(self.as_, {"op": "get", "id": bad})["ok"])


class Flow(Base):
    def test_submit_approve_run_result_and_log(self):
        r = self.submit("echo out; echo err >&2; exit 3", files=[{"name": "a.txt", "data_b64": b64("hello")}])
        d = call(self.as_, {"op": "get", "id": r["id"]})
        self.assertEqual(d["script"], "echo out; echo err >&2; exit 3")
        self.assertEqual(d["files"][0]["preview"], "hello")
        self.assertEqual(d["status"], "pending")
        self.assertEqual(self.approve(r)["status"], "approved")
        s = self.finish(r["id"])
        self.assertEqual((s["status"], s["exit_code"], s["stdout"], s["stderr"]), ("failed", 3, "out\n", "err\n"))
        log = open(f"{self.cfg.log_dir}/{r['id']}.log").read()
        self.assertIn("exit_code: 3", log)
        self.assertEqual(stat.S_IMODE(os.stat(f"{self.cfg.log_dir}/{r['id']}.log").st_mode), 0o600)
        self.assertTrue(any("root 作業" in t for t, _ in self.notes.sent))

    def test_script_sees_attachment_dir_and_id(self):
        r = self.submit('cat "$PLASMOD_ROOTD_FILES/a.txt"; echo "$PLASMOD_ROOTD_REQUEST_ID"; pwd', files=[{"name": "a.txt", "data_b64": b64("hello\n")}])
        self.approve(r)
        s = self.finish(r["id"])
        self.assertEqual(s["status"], "done")
        self.assertTrue(s["stdout"].startswith("hello\n" + r["id"]))

    def test_reject(self):
        r = self.submit()
        self.assertTrue(call(self.as_, {"op": "reject", "id": r["id"], "by": "owner"})["ok"])
        self.assertEqual(call(self.rs, {"op": "status", "id": r["id"]})["status"], "rejected")
        self.assertEqual(self.approve(r)["code"], "not_pending")

    def test_notification_on_submit_has_no_content_and_no_buttons(self):
        self.submit(title="秘密のタイトル rm -rf")
        title, msg = self.notes.sent[0]
        self.assertEqual(title, "承認待ち")
        self.assertNotIn("rm -rf", msg + title)

    def test_validation(self):
        bad = [
            {"title": "", "script_b64": b64("id")},
            {"title": "a\nb", "script_b64": b64("id")},
            {"title": "t", "script_b64": b64("")},
            {"title": "t", "script_b64": b64("a\x00b")},
            {"title": "t", "script_b64": "!!!"},
            {"title": "t", "script_b64": b64("id"), "timeout": 99999},
            {"title": "t", "script_b64": b64("id"), "files": [{"name": "../x", "data_b64": ""}]},
            {"title": "t", "script_b64": b64("id"), "files": [{"name": "a/b", "data_b64": ""}]},
            {"title": "t", "script_b64": b64("id"), "files": [{"name": "a", "data_b64": ""}, {"name": "a", "data_b64": ""}]},
        ]
        for b in bad:
            self.assertFalse(call(self.rs, {"op": "submit", **b})["ok"], b)
        self.assertEqual(self.engine.all_ids(), [])

    def test_pending_cap_per_uid(self):
        for _ in range(g.MAX_PENDING_PER_UID):
            self.submit()
        r = call(self.rs, {"op": "submit", "title": "x", "script_b64": b64("id")})
        self.assertEqual(r["code"], "too_many")


class Integrity(Base):
    def test_rewriting_source_file_after_submit_has_no_effect(self):
        src = f"{self.tmp.name}/s.sh"
        open(src, "w").write("echo original")
        r = self.submit(open(src).read())
        open(src, "w").write("echo EVIL")
        self.approve(r)
        self.assertEqual(self.finish(r["id"])["stdout"], "original\n")

    def test_digest_mismatch_refused_and_not_counted_as_failure(self):
        r = self.submit()
        a = self.approve(r, digest="0" * 64)
        self.assertEqual(a["code"], "digest_mismatch")
        self.assertEqual(call(self.as_, {"op": "list"})["lock"]["failures"], 0)
        self.assertEqual(self.engine._load(r["id"])["status"], "pending")
        self.assertEqual(self.approve(r, digest="zz")["code"], "digest_mismatch")

    def test_digest_covers_title_reason_timeout_and_files(self):
        a = g.manifest_digest("t", "r", 10, "s" * 64, [{"name": "a", "sha256": "1", "size": 1}])
        for other in (
            g.manifest_digest("T", "r", 10, "s" * 64, [{"name": "a", "sha256": "1", "size": 1}]),
            g.manifest_digest("t", "R", 10, "s" * 64, [{"name": "a", "sha256": "1", "size": 1}]),
            g.manifest_digest("t", "r", 11, "s" * 64, [{"name": "a", "sha256": "1", "size": 1}]),
            g.manifest_digest("t", "r", 10, "x" * 64, [{"name": "a", "sha256": "1", "size": 1}]),
            g.manifest_digest("t", "r", 10, "s" * 64, [{"name": "a", "sha256": "2", "size": 1}]),
            g.manifest_digest("t", "r", 10, "s" * 64, []),
        ):
            self.assertNotEqual(a, other)

    def test_tampered_stored_script_is_not_executed(self):
        r = self.submit("echo ok")
        p = f"{self.engine._dir(r['id'])}/script.sh"
        os.chmod(p, 0o600)
        open(p, "w").write("touch " + self.tmp.name + "/pwned")
        a = self.approve(r)
        self.assertEqual(a["code"], "tampered")
        self.assertFalse(os.path.exists(self.tmp.name + "/pwned"))
        self.assertEqual(self.engine._load(r["id"])["status"], "failed")

    def test_tampered_attachment_is_not_executed(self):
        r = self.submit("echo ok", files=[{"name": "a", "data_b64": b64("x")}])
        p = f"{self.engine._dir(r['id'])}/files/a"
        os.chmod(p, 0o600)
        open(p, "w").write("y")
        self.assertEqual(self.approve(r)["code"], "tampered")

    def test_tamper_between_approve_and_start_is_caught(self):
        r = self.submit("echo ok")
        # approved になった直後、実行の前に書き換えられた想定
        m = self.engine._load(r["id"])
        m["status"] = "approved"
        self.engine._save(m)
        p = f"{self.engine._dir(r['id'])}/script.sh"
        os.chmod(p, 0o600)
        open(p, "w").write("touch " + self.tmp.name + "/pwned")
        self.engine._execute(r["id"])
        self.assertFalse(os.path.exists(self.tmp.name + "/pwned"))
        self.assertEqual(self.engine._load(r["id"])["status"], "failed")


class Password(Base):
    def test_wrong_password_then_lock_then_expiry_of_lock(self):
        r = self.submit()
        for i in range(1, 5):
            a = self.approve(r, "wrong")
            self.assertEqual((a["code"], a["remaining"]), ("bad_password", 5 - i))
        a = self.approve(r, "wrong")
        self.assertEqual(a["code"], "locked")
        self.assertEqual(call(self.as_, {"op": "list"})["lock"]["locked_until"], self.now[0] + g.LOCK_SECONDS)
        # ロック中は正しいパスワードでも通らない
        self.assertEqual(self.approve(r, PW)["code"], "locked")
        self.assertEqual(self.engine._load(r["id"])["status"], "pending")
        titles = [t for t, _ in self.notes.sent]
        self.assertEqual(sum("パスワード" in t for t in titles), 5)  # 失敗 4 回 + ロック 1 回
        self.assertTrue(any("5回" in t for t in titles))
        self.now[0] += g.LOCK_SECONDS + 1
        self.assertTrue(self.approve(r, PW)["ok"])

    def test_success_resets_failures(self):
        r1, r2 = self.submit(), self.submit()
        self.approve(r1, "wrong")
        self.approve(r1, "wrong")
        self.assertTrue(self.approve(r1)["ok"])
        self.assertEqual(call(self.as_, {"op": "list"})["lock"]["failures"], 0)
        self.assertEqual(self.approve(r2, "wrong")["remaining"], 4)

    def test_lock_survives_restart(self):
        r = self.submit()
        for _ in range(5):
            self.approve(r, "wrong")
        e2 = g.Engine(self.cfg, notifier=self.notes, clock=lambda: self.now[0])
        self.assertTrue(e2.lock_info()["locked_until"])

    def test_missing_or_garbage_password_file_refuses(self):
        r = self.submit()
        os.unlink(self.cfg.passwd_file)
        self.assertEqual(self.approve(r)["code"], "no_password")
        open(self.cfg.passwd_file, "w").write("plaintext-secret\n")
        self.assertEqual(self.approve(r, "plaintext-secret")["code"], "bad_password")

    def test_empty_and_oversized_password(self):
        r = self.submit()
        self.assertEqual(self.approve(r, "")["code"], "bad_password_input")
        self.assertEqual(self.approve(r, "x" * 5000)["code"], "bad_password_input")

    def test_password_file_is_hashed_and_private(self):
        data = open(self.cfg.passwd_file).read()
        self.assertTrue(data.startswith("scrypt$"))
        self.assertNotIn(PW, data)
        self.assertEqual(stat.S_IMODE(os.stat(self.cfg.passwd_file).st_mode), 0o600)

    def test_password_never_in_logs_or_records(self):
        r = self.submit()
        self.approve(r, "super-secret-wrong-pw")
        self.approve(r)
        self.finish(r["id"])
        for root, _, names in os.walk(self.tmp.name):
            for n in names:
                if n == "passwd":
                    continue
                if n.endswith(".sock"):
                    continue
                data = open(os.path.join(root, n), "rb").read()
                self.assertNotIn(b"super-secret-wrong-pw", data, n)
                self.assertNotIn(PW.encode(), data, n)


class Lifecycle(Base):
    def test_expires_after_24h(self):
        r = self.submit()
        self.now[0] += g.TTL_SECONDS + 1
        self.assertEqual(self.approve(r)["code"], "not_pending")
        self.assertEqual(call(self.rs, {"op": "status", "id": r["id"]})["status"], "expired")

    def test_not_expired_just_before(self):
        r = self.submit()
        self.now[0] += g.TTL_SECONDS - 5
        self.assertTrue(self.approve(r)["ok"])
        self.finish(r["id"])

    def test_runs_only_once(self):
        counter = f"{self.tmp.name}/count"
        r = self.submit(f"echo x >> {counter}; sleep 0.3")
        results = []
        ts = [threading.Thread(target=lambda: results.append(self.approve(r))) for _ in range(6)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(sum(1 for x in results if x["ok"]), 1)
        self.finish(r["id"])
        self.assertEqual(open(counter).read(), "x\n")
        self.assertEqual(self.approve(r)["code"], "not_pending")
        self.engine._execute(r["id"])  # 直接呼んでも二度は走らない
        self.assertEqual(open(counter).read(), "x\n")

    def test_restart_marks_running_as_interrupted_and_never_reruns(self):
        r = self.submit(f"touch {self.tmp.name}/ran")
        m = self.engine._load(r["id"])
        m["status"] = "running"
        self.engine._save(m)
        e2 = g.Engine(self.cfg, notifier=self.notes, clock=lambda: self.now[0])
        self.assertEqual(e2._load(r["id"])["status"], "interrupted")
        e2._execute(r["id"])
        self.assertFalse(os.path.exists(f"{self.tmp.name}/ran"))

    def test_timeout_kills_process_group(self):
        r = self.submit(f"sleep 30 & echo $! > {self.tmp.name}/pid; sleep 30", timeout=1)
        self.approve(r)
        s = self.finish(r["id"])
        self.assertEqual(s["status"], "timeout")
        pid = int(open(f"{self.tmp.name}/pid").read())
        time.sleep(0.3)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_output_is_capped(self):
        r = self.submit("head -c 2000000 /dev/zero | tr '\\0' a; echo done >&2")
        self.approve(r)
        s = self.finish(r["id"])
        self.assertEqual(len(s["stdout"]), g.OUTPUT_CAP)
        self.assertTrue(s["stdout_truncated"])
        self.assertEqual(s["stderr"], "done\n")

    def test_script_env_is_clean(self):
        os.environ["PLASMOD_TEST_SECRET"] = "leak"
        r = self.submit("env")
        self.approve(r)
        out = self.finish(r["id"])["stdout"]
        del os.environ["PLASMOD_TEST_SECRET"]
        self.assertNotIn("PLASMOD_TEST_SECRET", out)
        self.assertIn("PLASMOD_ROOTD_REQUEST_ID=" + r["id"], out)

    def test_runs_one_at_a_time(self):
        a = self.submit(f"echo a-start >> {self.tmp.name}/order; sleep 0.4; echo a-end >> {self.tmp.name}/order")
        b = self.submit(f"echo b-start >> {self.tmp.name}/order; echo b-end >> {self.tmp.name}/order")
        self.approve(a)
        self.approve(b)
        self.engine.wait_idle()
        self.assertEqual(open(f"{self.tmp.name}/order").read().split(), ["a-start", "a-end", "b-start", "b-end"])


class RootreqCli(Base):
    def run_cli(self, *args, stdin=None):
        import subprocess
        env = {**os.environ, "PLASMOD_ROOTD_REQ_SOCK": self.rs}
        return subprocess.run([os.path.join(HERE, "rootreq"), *args], capture_output=True, text=True, env=env, input=stdin, timeout=60)

    def test_submit_then_wait_returns_script_exit_code_and_output(self):
        script = f"{self.tmp.name}/s.sh"
        open(script, "w").write("echo hello-from-root; exit 7")
        p = self.run_cli("submit", "--title", "cli", "--reason", "テスト", "--script", script)
        self.assertEqual(p.returncode, 0, p.stderr)
        rid = p.stdout.strip()
        self.assertRegex(rid, g.ID_RE)
        self.assertIn("digest", p.stderr)
        open(script, "w").write("echo EVIL")  # 依頼後に書き換えても効かない

        def approve_later():
            time.sleep(1)
            m = self.engine._load(rid)
            self.approve({"id": rid, "digest": m["digest"]})

        threading.Thread(target=approve_later).start()
        w = self.run_cli("wait", rid)
        self.assertEqual(w.returncode, 7, w.stderr)
        self.assertIn("hello-from-root", w.stdout)
        self.assertNotIn("EVIL", w.stdout)

    def test_wait_reports_rejected_and_unreachable(self):
        p = self.run_cli("submit", "--title", "cli", "--script", "-", stdin="id")
        rid = p.stdout.strip()
        call(self.as_, {"op": "reject", "id": rid, "by": "t"})
        self.assertEqual(self.run_cli("wait", rid).returncode, 10)
        self.assertEqual(self.run_cli("wait", "20260101000000-aaaaaa").returncode, 1)
        import subprocess
        q = subprocess.run([os.path.join(HERE, "rootreq"), "status", rid], capture_output=True, text=True, env={**os.environ, "PLASMOD_ROOTD_REQ_SOCK": "/nonexistent"})
        self.assertNotEqual(q.returncode, 0)


FAKE_SECRET = "s3cr3t-VALUE-0123456789abcdefghijklmnopqrstuvwxyz"


class HermesFixture(Base):
    """偽の HERMES_HOME（default と ops）。hermes の権限で動く部分は、テストでは自分の uid で動かす（as_hermes を空にする）"""

    def setUp(self):
        super().setUp()
        t = self.tmp.name
        h = f"{t}/hermes/.hermes"
        self.home = h
        for d in (f"{h}/mcp-tokens", f"{h}/cron", f"{h}/logs", f"{h}/profiles/ops/cron", f"{h}/profiles/ops/mcp-tokens"):
            os.makedirs(d)
        open(f"{h}/config.yaml", "w").write(
            "model:\n  default: openai/gpt-6.1-sol\n  provider: nous\n"
            "mcp_servers:\n"
            "  vercel:\n    url: https://mcp.vercel.com/?token=" + FAKE_SECRET + "\n    oauth: {}\n    tools:\n      include: [list_projects, get_project]\n"
            "  ga:\n    command: /opt/gcp-ro/bin/ga-mcp\n    env:\n      GOOGLE_APPLICATION_CREDENTIALS: /x/adc.json\n"
            "  plain:\n    url: https://mcp.example.com/mcp\n    enabled: false\n    headers:\n      Authorization: Bearer " + FAKE_SECRET + "\n"
        )
        open(f"{h}/profiles/ops/config.yaml", "w").write("mcp_servers:\n  neon:\n    url: https://mcp.neon.tech/mcp\n    oauth: {}\n")
        jobs = {"jobs": [{"id": "c4b0040f440c", "name": "朝の運用レポート", "schedule": {"expr": "0 8 * * *"}, "enabled": True,
                          "deliver": "telegram:123456789012345678", "model": "deepseek-v4.1-flash", "next_run_at": "2026-10-26T08:00:00+09:00"}]}
        json.dump(jobs, open(f"{h}/cron/jobs.json", "w"), indent=1)
        json.dump({"jobs": [{"id": "31a1671d0030", "name": "朝の運用レポート", "enabled": False}]}, open(f"{h}/profiles/ops/cron/jobs.json", "w"))
        json.dump({"access_token": FAKE_SECRET, "refresh_token": FAKE_SECRET, "expires_at": self.now[0] - 10}, open(f"{h}/mcp-tokens/vercel.json", "w"))
        open(f"{h}/mcp-tokens/vercel.client.json", "w").write("{}")
        json.dump({"access_token": FAKE_SECRET, "expires_at": 4_000_000_000}, open(f"{h}/profiles/ops/mcp-tokens/neon.json", "w"))
        # hermes が置いたリンクは辿らない（中身は読まない）
        open(f"{t}/root-only.json", "w").write(json.dumps({"access_token": "ROOT-ONLY"}))
        os.symlink(f"{t}/root-only.json", f"{h}/mcp-tokens/evil.json")
        open(f"{h}/logs/gateway.log", "w").write(
            "2026-10-26 01:00:00,000 WARNING gateway.run: MCP shutdown did not finish within 5.0s\n"
            "2026-10-26 01:01:00,000 INFO mcp: connected vercel\n"
            "2026-10-26 01:02:00,000 WARNING mcp.oauth: vercel refresh failed (invalid_grant); parked. Authorization: Bearer " + FAKE_SECRET + "\n"
        )
        open(f"{h}/.env", "w").write(f"# c\nOPENAI_API_KEY={FAKE_SECRET}\nexport NOUS_TOKEN='{FAKE_SECRET}'\nbad line\n")
        open(self.cfg.app_env, "w").write(f"PLASMOD_NOTIFY_TOKEN={FAKE_SECRET}\nPLASMOD_PUBLIC_URL=https://x\n")
        bin_ = f"{t}/bin"
        os.makedirs(bin_)
        open(f"{bin_}/systemctl", "w").write(
            "#!/bin/sh\n"
            'case "$1" in\n'
            '  list-units) case "$*" in *timer*) echo "plasmod-deploy.timer loaded active waiting x";; '
            '*) echo "plasmod.service loaded active running x"; echo "sshd.service loaded active running x";; esac;;\n'
            '  show) echo "ActiveState=active"; echo "SubState=running"; echo "Result=success"; echo "LastTriggerUSec=";;\n'
            "esac\n"
        )
        open(f"{bin_}/journalctl", "w").write(f"#!/bin/sh\necho \"line token={FAKE_SECRET}\"\necho ok\n")
        for f in ("systemctl", "journalctl"):
            os.chmod(f"{bin_}/{f}", 0o755)
        # 偽の hermes: cron pause/resume/list と config set/get だけ
        open(f"{bin_}/hermes", "w").write(
            f"#!{sys.executable}\n"
            "import json, os, sys, yaml\n"
            "h, a = os.environ['HERMES_HOME'], sys.argv[1:]\n"
            "if a[0] == 'cron':\n"
            "    p = h + '/cron/jobs.json'; d = json.load(open(p))\n"
            "    if a[1] in ('pause', 'resume'):\n"
            "        for j in d['jobs']:\n"
            "            if j['id'] == a[2]: j['enabled'] = a[1] == 'resume'; j['state'] = 'paused' if a[1] == 'pause' else 'scheduled'\n"
            "        json.dump(d, open(p, 'w'), indent=1); print(a[1], a[2])\n"
            "    else: print('LIST', json.dumps(d))\n"
            "elif a[:2] == ['config', 'set']:\n"
            "    p = h + '/config.yaml'; c = yaml.safe_load(open(p)); cur = c; ks = a[2].split('.')\n"
            "    for k in ks[:-1]: cur = cur[k]\n"
            "    cur[ks[-1]] = {'true': True, 'false': False}.get(a[3], a[3]); yaml.safe_dump(c, open(p, 'w'))\n"
            "elif a[:2] == ['config', 'get']:\n"
            "    cur = yaml.safe_load(open(h + '/config.yaml'))\n"
            "    for k in a[2].split('.'): cur = cur.get(k, {}) if isinstance(cur, dict) else None\n"
            "    print(cur)\n"
        )
        for f in ("systemctl", "journalctl", "hermes"):
            os.chmod(f"{bin_}/{f}", 0o755)
        self.cfg.__dict__.update(as_hermes=[], hermes_home=h, hermes_python=sys.executable, hermes_bin=f"{bin_}/hermes",
                                 systemctl=f"{bin_}/systemctl", journalctl=f"{bin_}/journalctl")


class Action(HermesFixture):
    """部品: スクリプトは plasmod-rootd が組み立てる。下見は digest に入る。控え・差分・元に戻す"""

    def action(self, name, *args, sock=None, reason=""):
        return call(sock or self.rs, {"op": "action", "name": name, "args": list(args), "reason": reason})

    def run_action(self, name, *args):
        r = self.action(name, *args)
        self.assertTrue(r["ok"], r)
        self.assertTrue(self.approve(r)["ok"])
        return r, self.finish(r["id"])

    def jobs(self, prof="default"):
        p = f"{self.home}/cron/jobs.json" if prof == "default" else f"{self.home}/profiles/{prof}/cron/jobs.json"
        return open(p).read()

    def test_cron_pause_with_preview_backup_and_diff(self):
        before = self.jobs()
        r = self.action("cron.pause", "default", "c4b0040f440c", reason="二重のレポートを止める")
        self.assertTrue(r["ok"], r)
        self.assertIn("「朝の運用レポート」", r["preview"])
        self.assertIn("状態: scheduled → paused", r["preview"])
        got = call(self.as_, {"op": "get", "id": r["id"]})
        self.assertEqual(sorted(f["name"] for f in got["files"]), ["action.json", "preview.txt"])
        self.assertEqual(next(f for f in got["files"] if f["name"] == "preview.txt")["preview"], r["preview"])  # 下見は添付＝digest に入る
        self.assertIn("plasmod-rootd が組み立てた", got["script"])
        self.assertIn("二重のレポートを止める", got["reason"])
        self.assertEqual(self.jobs(), before)  # 承認まで何も変わらない
        self.assertTrue(self.approve(r)["ok"])
        st = self.finish(r["id"])
        self.assertEqual(st["status"], "done", st)
        self.assertIn('"state": "paused"', self.jobs())
        self.assertIn("控え: ", st["stdout"])
        self.assertIn("--- 差分: ", st["stdout"])
        self.assertRegex(st["stdout"], r'\n\+\s+"state": "paused"')
        self.assertIn("--- 確かめ", st["stdout"])
        b = f"{self.cfg.state_dir}/backups/{r['id']}"
        self.assertEqual(open(f"{b}/1").read(), before)
        self.assertEqual(stat.S_IMODE(os.stat(b).st_mode), 0o700)

    def test_mcp_disable(self):
        r, st = self.run_action("mcp.disable", "default", "vercel")
        self.assertEqual(st["status"], "done", st)
        self.assertIn("有効: はい → いいえ", r["preview"])
        self.assertIn("enabled: false", open(f"{self.home}/config.yaml").read())
        self.assertIn("False", st["stdout"].split("--- 確かめ")[1])
        self.assertEqual(self.action("mcp.disable", "default", "vercel")["code"], "no_change")
        self.assertEqual(self.action("mcp.enable", "default", "nope")["code"], "bad_arg")

    def test_refuses_bad_input_and_no_change(self):
        self.assertEqual(self.action("rm", "-rf", "/")["code"], "bad_action")
        self.assertEqual(self.action("cron.pause", "default")["code"], "bad_arg")
        self.assertEqual(self.action("cron.pause", "default", "x'; id; '")["code"], "bad_arg")
        self.assertEqual(self.action("cron.pause", "../x", "c4b0040f440c")["code"], "bad_arg")
        self.assertEqual(self.action("cron.pause", "default", "nojob1")["code"], "bad_arg")
        self.assertEqual(self.action("cron.resume", "default", "c4b0040f440c")["code"], "no_change")
        self.assertEqual(self.action("cron.pause", "ops", "31a1671d0030")["code"], "no_change")
        self.assertEqual(self.action("cron.pause", "default", "c4b0040f440c", sock=self.as_)["code"], "bad_op")  # 承認の受け口からは依頼できない
        self.assertEqual(self.engine.all_ids(), [])

    def test_undo_by_requester(self):
        before = self.jobs()
        r, st = self.run_action("cron.pause", "default", "c4b0040f440c")
        self.assertEqual(st["status"], "done", st)
        u = self.action("undo", r["id"])
        self.assertTrue(u["ok"], u)
        self.assertRegex(u["preview"], r'\n-\s+"state": "paused"')
        self.assertTrue(self.approve(u)["ok"])
        self.assertEqual(self.finish(u["id"])["status"], "done")
        self.assertEqual(self.jobs(), before)
        self.assertEqual(self.action("undo", r["id"])["code"], "no_change")  # もう同じ
        # 戻したのをさらに戻せる（undo の前にも控えを取っている）
        uu, st2 = self.run_action("undo", u["id"])
        self.assertEqual(st2["status"], "done", st2)
        self.assertIn('"state": "paused"', self.jobs())

    def test_service_restart_only_allowed_units(self):
        self.assertEqual(self.action("service.restart", "sshd.service")["code"], "bad_arg")
        self.assertEqual(self.action("service.restart", "plasmod-rootd.service")["code"], "bad_arg")
        self.assertEqual(self.action("service.restart", "plasmod-deploy.timer")["code"], "bad_arg")
        self.assertEqual(self.action("service.restart", "plasmod.service; id")["code"], "bad_arg")
        r = self.action("service.restart", "plasmod.service")
        self.assertTrue(r["ok"], r)
        self.assertIn("再起動", r["preview"])

    def test_config_set_only_allowed_values(self):
        self.assertEqual(self.action("config.set", "default", "approvals.mode", "off")["code"], "bad_arg")  # 承認を緩める値は入れない
        self.assertEqual(self.action("config.set", "default", "model.default", "x")["code"], "bad_arg")
        self.assertEqual(self.action("config.set", "default", "approvals.timeout", "5")["code"], "bad_arg")
        r = self.action("config.set", "default", "approvals.mode", "manual")
        self.assertTrue(r["ok"], r)
        self.assertIn("変更後: manual", r["preview"])

    def test_skill_sync_updates_only_from_repo(self):
        t = self.tmp.name
        os.makedirs(f"{t}/repo/deploy/hermes-skills/report")
        open(f"{t}/repo/deploy/hermes-skills/report/SKILL.md", "w").write("# 新しい版\n")
        self.cfg.__dict__.update(repo_dir=f"{t}/repo")
        self.assertEqual(self.action("skill.sync", "default", "report")["code"], "bad_arg")  # 入っていない
        os.makedirs(f"{self.home}/skills/productivity/report")
        path = f"{self.home}/skills/productivity/report/SKILL.md"
        open(path, "w").write("# 古い版\n")
        self.assertEqual(self.action("skill.sync", "default", "nothing")["code"], "bad_arg")  # リポジトリに無い
        self.assertEqual(self.action("skill.sync", "default", "../x")["code"], "bad_arg")
        r, st = self.run_action("skill.sync", "default", "report")
        self.assertEqual(st["status"], "done", st)
        self.assertEqual(open(path).read(), "# 新しい版\n")
        self.assertEqual(self.action("skill.sync", "default", "report")["code"], "no_change")
        u, st2 = self.run_action("undo", r["id"])
        self.assertEqual(st2["status"], "done", st2)
        self.assertEqual(open(path).read(), "# 古い版\n")

    def test_undo_only_for_finished_actions(self):
        s = self.submit("echo hi")
        self.approve(s)
        self.finish(s["id"])
        self.assertEqual(self.action("undo", s["id"])["code"], "not_undoable")  # 自由なスクリプト
        p = self.action("cron.pause", "default", "c4b0040f440c")
        self.assertEqual(self.action("undo", p["id"])["code"], "not_undoable")  # まだ承認待ち
        self.assertEqual(self.action("undo", "20260101000000-aaaaaa")["code"], "not_found")

    def test_undo_from_app_in_one_step(self):
        before = self.jobs()
        r, _ = self.run_action("cron.pause", "default", "c4b0040f440c")
        bad = call(self.as_, {"op": "undo", "id": r["id"], "password": "wrong", "by": "owner"})
        self.assertEqual(bad["code"], "bad_password")
        self.assertIn('"state": "paused"', self.jobs())
        ok = call(self.as_, {"op": "undo", "id": r["id"], "password": PW, "by": "owner"})
        self.assertTrue(ok["ok"], ok)
        self.assertEqual(ok["status"], "approved")
        self.engine.wait_idle()
        self.assertEqual(self.jobs(), before)
        self.assertEqual(call(self.rs, {"op": "undo", "id": r["id"], "password": PW})["code"], "bad_op")  # 依頼の受け口からは使えない

    def test_rootreq_cli(self):
        import subprocess
        env = {**os.environ, "PLASMOD_ROOTD_REQ_SOCK": self.rs}
        p = subprocess.run([os.path.join(HERE, "rootreq"), "action", "cron.pause", "default", "c4b0040f440c", "--reason", "テスト"],
                           capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertRegex(p.stdout.strip(), g.ID_RE)
        self.assertIn("scheduled → paused", p.stderr)
        q = subprocess.run([os.path.join(HERE, "rootreq"), "action", "cron.resume", "default", "c4b0040f440c"], capture_output=True, text=True, env=env, timeout=60)
        self.assertNotEqual(q.returncode, 0)
        self.assertIn("もう", q.stderr)



class Inspect(HermesFixture):
    """inspect: 読むだけ・承認なし"""

    def inspect(self, item, arg=None, sock=None):
        return call(sock or self.rs, {"op": "inspect", "item": item, "arg": arg})

    def assertNoSecret(self, r):
        s = json.dumps(r, ensure_ascii=False)
        self.assertNotIn(FAKE_SECRET, s)
        self.assertNotIn("ROOT-ONLY", s)

    def test_mask_text(self):
        for s in (f"Authorization: Bearer {FAKE_SECRET}", f"API_KEY={FAKE_SECRET}", '"client_secret": "abc12345xyz"',
                  "https://x.example/cb?code=abcdef123&state=zzz9", "postgres://user:pa55word@db.example/x", "ghp_" + "A" * 36,
                  "sk-proj-abcdefghijklmnop", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"):
            out = g.mask_text(s)
            self.assertIn(g.MASK, out, s)
            for secret in (FAKE_SECRET, "abc12345xyz", "abcdef123", "pa55word", "A" * 36, "abcdefghijklmnop", "dozjgNryP4J3"):
                self.assertNotIn(secret, out)
        self.assertEqual(g.mask_text("c4b0040f440c [active] 2026-10-26T08:00:00+09:00"), "c4b0040f440c [active] 2026-10-26T08:00:00+09:00")

    def test_hermes_config(self):
        r = self.inspect("hermes-config")
        self.assertTrue(r["ok"], r)
        d = r["data"]["default"]
        self.assertEqual(d["model"], {"default": "openai/gpt-6.1-sol", "provider": "nous"})
        v = d["mcp_servers"]["vercel"]
        self.assertEqual((v["host"], v["oauth"], v["include"], v["enabled"]), ("mcp.vercel.com", True, ["list_projects", "get_project"], True))
        self.assertEqual(d["mcp_servers"]["ga"]["command"], "ga-mcp")
        self.assertEqual(d["mcp_servers"]["ga"]["env_keys"], ["GOOGLE_APPLICATION_CREDENTIALS"])
        self.assertEqual((d["mcp_servers"]["plain"]["enabled"], d["mcp_servers"]["plain"]["header_keys"]), (False, ["Authorization"]))
        self.assertNoSecret(r)
        self.assertEqual(list(self.inspect("hermes-config", "ops")["data"]), ["ops"])

    def test_hermes_cron_all_profiles(self):
        r = self.inspect("hermes-cron")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["data"]["default"][0]["deliver"], ["telegram"])  # 送り先の ID は出さない
        self.assertEqual(r["data"]["default"][0]["state"], "scheduled")
        self.assertEqual(r["data"]["ops"][0]["state"], "paused")
        self.assertNotIn("123456789012345678", json.dumps(r))

    def test_hermes_mcp_tokens_and_log(self):
        r = self.inspect("hermes-mcp")
        self.assertTrue(r["ok"], r)
        v = r["data"]["default"]["servers"]["vercel"]
        self.assertEqual({k: v["token"][k] for k in ("exists", "access", "refresh", "expired")}, {"exists": True, "access": True, "refresh": True, "expired": True})
        self.assertTrue(v["client_registered"])
        self.assertEqual(r["data"]["default"]["servers"]["evil"]["token"], {"exists": True, "updated_at": r["data"]["default"]["servers"]["evil"]["token"]["updated_at"]})
        self.assertEqual(r["data"]["default"]["servers"]["plain"]["token"], {"exists": False})
        self.assertFalse(r["data"]["ops"]["servers"]["neon"]["token"]["expired"])
        log = r["data"]["default"]["log"]
        self.assertEqual(len(log), 1)
        self.assertIn("parked", log[0])
        self.assertNoSecret(r)

    def test_env_keys_only_names(self):
        r = self.inspect("env-keys")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["data"]["plasmod"], ["PLASMOD_NOTIFY_TOKEN", "PLASMOD_PUBLIC_URL"])
        self.assertEqual(r["data"]["hermes"]["default"], ["NOUS_TOKEN", "OPENAI_API_KEY"])
        self.assertEqual(r["data"]["hermes"]["ops"], [])
        self.assertNoSecret(r)

    def test_units(self):
        r = self.inspect("units")
        self.assertTrue(r["ok"], r)
        self.assertEqual(sorted(r["data"]["units"]), ["plasmod-deploy.timer", "plasmod.service"])  # sshd は対象外
        self.assertEqual(r["data"]["units"]["plasmod.service"], {"ActiveState": "active", "SubState": "running", "Result": "success"})
        self.assertNotIn("journal", r["data"])
        j = self.inspect("units", "plasmod.service")
        self.assertEqual(j["data"]["journal"][-1], "ok")
        self.assertNoSecret(j)
        self.assertEqual(self.inspect("units", "sshd.service")["code"], "bad_arg")
        self.assertEqual(self.inspect("units", "plasmod.service; id")["code"], "bad_arg")

    def more_files(self):
        a = f"{self.home}/hermes-agent"
        os.makedirs(f"{a}/gateway", exist_ok=True)
        open(f"{a}/gateway/run.py", "w").write("".join(f"line {i} needle\n" for i in range(1, 501)))
        open(f"{a}/.env", "w").write(f"API_KEY={FAKE_SECRET}\n")
        open(f"{a}/secrets.py", "w").write(f"X = 'needle {FAKE_SECRET}'\n")
        open(f"{a}/data.bin", "w").write("needle")
        os.symlink(f"{self.home}/.env", f"{a}/link.py")
        for prof in (self.home, f"{self.home}/profiles/ops"):
            os.makedirs(f"{prof}/skills/productivity/report", exist_ok=True)
            open(f"{prof}/skills/productivity/report/SKILL.md", "w").write(f"# 報告\ntoken: {FAKE_SECRET}\n")

    def test_system(self):
        r = self.inspect("system")
        self.assertTrue(r["ok"], r)
        self.assertIn("disk", r["data"])
        self.assertIn("memory", r["data"])

    def test_gateway_log_search_masks(self):
        with open(f"{self.home}/logs/gateway.log", "a") as f:
            f.write(f"2026 ERROR gateway token={FAKE_SECRET}\n")
        r = self.inspect("gateway-log", "GATEWAY T")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["data"]["total"], 1)
        self.assertNoSecret(r)
        self.assertGreater(self.inspect("gateway-log")["data"]["total"], 1)

    def test_code_read_limits_and_refuses_secrets(self):
        self.more_files()
        r = self.inspect("hermes-code", "gateway/run.py:10-12")
        self.assertEqual(r["data"]["lines"], ["line 10 needle", "line 11 needle", "line 12 needle"])
        self.assertEqual(len(self.inspect("hermes-code", "gateway/run.py")["data"]["lines"]), 400)
        for bad in (".env", "secrets.py", "link.py", "data.bin"):
            self.assertEqual(self.inspect("hermes-code", bad)["code"], "bad_arg", bad)
        for bad in ("../.env", "gateway/../../.env", "/etc/shadow:1", "a;id"):
            self.assertEqual(self.inspect("hermes-code", bad)["code"], "bad_arg", bad)
        self.assertEqual(self.inspect("hermes-code")["code"], "bad_arg")

    def test_code_grep_skips_secrets(self):
        self.more_files()
        r = self.inspect("hermes-grep", "needle")
        self.assertTrue(r["data"]["truncated"])
        self.assertEqual(len(r["data"]["matches"]), 80)
        self.assertFalse([m for m in r["data"]["matches"] if "secrets.py" in m or "data.bin" in m])
        # リンクの先（.env）は探さない
        os.symlink(f"{self.home}/.env", f"{self.home}/hermes-agent/gateway/a.py")
        self.assertEqual(self.inspect("hermes-grep", "OPENAI_API_KEY")["data"]["matches"], [])
        self.assertEqual(self.inspect("hermes-grep", "a;b")["code"], "bad_arg")

    def test_skills(self):
        self.more_files()
        self.assertEqual(self.inspect("skills", "ops")["data"]["ops"], ["productivity/report"])
        r = self.inspect("skill", "ops:productivity/report")
        self.assertIn("# 報告", r["data"]["text"])
        self.assertNoSecret(r)
        self.assertEqual(self.inspect("skill", "ops:../../.env")["code"], "bad_arg")
        self.assertEqual(self.inspect("skill", "nope:x")["code"], "bad_arg")

    def test_rate_limit(self):
        ins = g.Inspector(self.cfg)
        for _ in range(g.INSPECT_PER_MINUTE):
            ins.throttle(1000.0)
        with self.assertRaises(g.Refuse) as e:
            ins.throttle(1000.0)
        self.assertEqual(e.exception.code, "rate_limited")
        ins.throttle(1061.0)

    def test_refuses_unknown_and_bad_args(self):
        self.assertEqual(self.inspect("cat", "/etc/shadow")["code"], "bad_item")
        self.assertEqual(self.inspect("hermes-config", "../../root")["code"], "bad_arg")
        self.assertEqual(self.inspect("hermes-config", ["x"])["code"], "bad_arg")
        r = self.inspect("hermes-cron", "nope")
        self.assertEqual(r["code"], "bad_arg")
        self.assertIn("default ops", r["error"])

    def test_only_requesters_and_logged(self):
        self.assertEqual(self.inspect("hermes-cron", sock=self.as_)["code"], "bad_op")  # 承認の受け口からは使えない
        self.requesters = {ME + 1}
        self.assertEqual(self.inspect("hermes-cron")["code"], "forbidden")
        self.requesters = {ME}
        self.inspect("env-keys")
        log = open(f"{self.cfg.log_dir}/audit.log").read()
        self.assertIn('"event": "inspect"', log)
        self.assertIn('"item": "env-keys"', log)
        self.assertEqual(self.engine.all_ids(), [])  # 依頼は作らない

    def test_default_runuser_is_absolute(self):
        # hermes に渡す PATH（/usr/local/bin:/usr/bin:/bin）から探されるので、sbin のものは絶対パスで
        self.assertEqual(g.Config().as_hermes[0], "/usr/sbin/runuser")

    def test_rootreq_cli(self):
        import subprocess
        env = {**os.environ, "PLASMOD_ROOTD_REQ_SOCK": self.rs}
        p = subprocess.run([os.path.join(HERE, "rootreq"), "inspect", "hermes-cron", "ops"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(p.stdout)["ops"][0]["id"], "31a1671d0030")
        q = subprocess.run([os.path.join(HERE, "rootreq"), "inspect", "nope"], capture_output=True, text=True, env=env, timeout=60)
        self.assertNotEqual(q.returncode, 0)
        self.assertIn("知らない項目", q.stderr)


class Cli(unittest.TestCase):
    def test_set_password_requires_tty_and_root(self):
        with self.assertRaises(SystemExit):
            g.set_password(g.Config())

    def test_check_password_formats(self):
        h = g.hash_password("abc", n=16)
        self.assertTrue(g.check_password(h, "abc"))
        self.assertFalse(g.check_password(h, "abd"))
        self.assertFalse(g.check_password("md5$x", "abc"))
        self.assertFalse(g.check_password("", "abc"))


if __name__ == "__main__":
    unittest.main()
