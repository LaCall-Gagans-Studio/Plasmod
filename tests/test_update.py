"""plasmod-update の検証・入れ替え・巻き戻し。python3 -I -m unittest discover -s tests -p 'test_update.py'"""
import hashlib
import http.server
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import stat
import tarfile
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("upd", os.path.join(HERE, "..", "deploy", "update", "plasmod-update"))
spec = importlib.util.spec_from_loader("upd", loader)
upd = importlib.util.module_from_spec(spec)
loader.exec_module(upd)

PRIV = {"broker": "b" * 64}


def tar_bytes(entries, top="plasmod-3.1.0"):
    """entries: [(name, bytes | ('sym', target) | ('dev',) | ('hard', target))]"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, body in entries:
            ti = tarfile.TarInfo(name)
            if isinstance(body, tuple) and body[0] == "sym":
                ti.type, ti.linkname = tarfile.SYMTYPE, body[1]
                tf.addfile(ti)
            elif isinstance(body, tuple) and body[0] == "hard":
                ti.type, ti.linkname = tarfile.LNKTYPE, body[1]
                tf.addfile(ti)
            elif isinstance(body, tuple) and body[0] == "dev":
                ti.type = tarfile.CHRTYPE
                tf.addfile(ti)
            elif body is None:
                ti.type, ti.mode = tarfile.DIRTYPE, 0o755
                tf.addfile(ti)
            else:
                ti.size, ti.mode = len(body), 0o644
                tf.addfile(ti, io.BytesIO(body))
    return buf.getvalue()


GOOD = [("plasmod-3.1.0", None), ("plasmod-3.1.0/package.json", b'{"version":"3.1.0"}'), ("plasmod-3.1.0/dist", None),
        ("plasmod-3.1.0/dist/web", None), ("plasmod-3.1.0/dist/web/index.html", b"<html>new</html>")]


class Health(http.server.BaseHTTPRequestHandler):
    mode = "ok"

    def do_GET(self):
        code, body = 200, b"<html></html>"
        if Health.mode == "down":
            code = 503
        elif self.path == "/api/teams":
            code = 200 if Health.mode == "open" else 403
        self.send_response(code)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class UpdateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Health)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        Health.mode = "ok"
        self.d = tempfile.mkdtemp()
        j = lambda *p: os.path.join(self.d, *p)
        self.app, self.state, self.rel = j("opt-plasmod"), j("state"), j("rel")
        os.makedirs(os.path.join(self.app, "dist", "web"))
        os.makedirs(self.rel)
        open(os.path.join(self.app, "package.json"), "w").write('{"version":"3.0.0"}')
        open(os.path.join(self.app, "dist", "web", "index.html"), "w").write("old")
        os.makedirs(os.path.join(self.app, "broker"))
        open(os.path.join(self.app, "broker", "plasmod-broker"), "w").write("old broker")
        self.sysctl_log = j("sysctl.log")
        self.fake("systemctl", f'echo "$@" >> {self.sysctl_log}\n[ "$1" = is-active ] && echo "${{FAKE_ACTIVE:-inactive}}"\nexit 0')
        self.fake("gh", 'exit "${FAKE_GH:-0}"')
        self.saved = {k: getattr(upd, k) for k in ("APP", "STATE", "SYSTEMCTL", "GH", "BASE_URL", "STATUS")}
        upd.APP, upd.STATE, upd.STATUS = self.app, self.state, os.path.join(self.state, "update-status.json")
        upd.SYSTEMCTL, upd.GH = j("systemctl"), j("gh")
        upd.BASE_URL = "http://127.0.0.1:%d" % self.srv.server_address[1]
        self._sleep = upd.time.sleep
        upd.time.sleep = lambda s: None
        os.environ.pop("FAKE_ACTIVE", None)
        os.environ.pop("FAKE_GH", None)

    def tearDown(self):
        upd.time.sleep = self._sleep
        for k, v in self.saved.items():
            setattr(upd, k, v)
        shutil.rmtree(self.d, ignore_errors=True)

    def fake(self, name, body):
        p = os.path.join(self.d, name)
        open(p, "w").write("#!/bin/sh\n" + body + "\n")
        os.chmod(p, 0o755)

    def release(self, entries=GOOD, priv=None, version="3.1.0", tamper=False):
        data = tar_bytes(entries)
        name = "plasmod-%s.tar.gz" % version
        sha = hashlib.sha256(data).hexdigest()
        open(os.path.join(self.rel, name), "wb").write(data + (b"x" if tamper else b""))
        if priv is None:
            priv = {k: upd.tree_digest(self.app, k) for k in upd.PRIVILEGED if upd.tree_digest(self.app, k)}
        m = {"schema": 1, "version": version, "commit": "a" * 40, "commitTime": "x", "target": {"os": "linux", "arch": "any"},
             "runtime": {"bun": "1"}, "package": {"name": name, "sha256": sha, "size": len(data)}, "privileged": priv}
        json.dump(m, open(os.path.join(self.rel, "manifest.json"), "w"))
        return m

    def apply(self, *extra):
        a = upd.argparse.Namespace(version=None, dir=self.rel, bundle="b.json", accept_privileged="--accept-privileged" in extra, cmd="apply")
        return upd.cmd_apply(a)

    def status(self):
        return json.load(open(upd.STATUS))

    def app_html(self):
        return open(os.path.join(self.app, "dist", "web", "index.html")).read()

    # ---- 成功 ----
    def test_applies_new_release_and_keeps_previous(self):
        self.release()
        self.assertEqual(self.apply(), 0)
        self.assertEqual(self.app_html(), "<html>new</html>")
        self.assertEqual(self.status()["state"], "done")
        self.assertEqual(self.status()["to"], "3.1.0")
        rel = json.load(open(os.path.join(self.app, "RELEASE.json")))
        self.assertEqual((rel["version"], rel["managed"]), ("3.1.0", True))
        self.assertEqual(open(os.path.join(self.app + ".prev", "dist", "web", "index.html")).read(), "old")
        log = open(self.sysctl_log).read()
        self.assertIn("stop plasmod", log)
        self.assertIn("start plasmod", log)

    # ---- 入れない（本番はそのまま） ----
    def refused(self, why):
        self.assertEqual(self.apply(), 2)
        self.assertEqual(self.app_html(), "old")
        st = self.status()
        self.assertEqual(st["state"], "refused")
        self.assertIn(why, st["error"])
        self.assertFalse(os.path.exists(self.sysctl_log) and "stop" in open(self.sysctl_log).read())

    def test_refuses_tampered_package(self):
        self.release(tamper=True)
        self.refused("大きさ")

    def test_refuses_wrong_sha(self):
        m = self.release()
        m["package"]["sha256"] = "0" * 64
        json.dump(m, open(os.path.join(self.rel, "manifest.json"), "w"))
        self.refused("sha256")

    def test_refuses_when_attestation_fails(self):
        self.release()
        os.environ["FAKE_GH"] = "1"
        self.refused("出所の証明")

    def test_refuses_when_gh_missing(self):
        self.release()
        upd.GH = os.path.join(self.d, "no-such-gh")
        self.refused("確かめられない")

    def test_refuses_when_autodeploy_active(self):
        self.release()
        os.environ["FAKE_ACTIVE"] = "active"
        self.refused("自動デプロイ")

    def test_refuses_privileged_change_unless_accepted(self):
        self.release(priv={"broker": "f" * 64})
        self.refused("broker")
        self.assertEqual(self.apply("--accept-privileged"), 0)
        self.assertEqual(self.status()["privilegedChanged"], ["broker"])

    def test_refuses_same_version_when_managed(self):
        self.release()
        self.assertEqual(self.apply(), 0)
        self.release(priv=json.load(open(os.path.join(self.app, "RELEASE.json")))["privileged"])
        self.assertEqual(self.apply(), 2)
        self.assertIn("もう 3.1.0", self.status()["error"])

    def test_refuses_bad_manifest(self):
        for patch in ({"schema": 2}, {"version": "../1.0.0"}, {"target": {"os": "windows", "arch": "any"}}, {"commit": "zz"}):
            m = self.release()
            m.update(patch)
            json.dump(m, open(os.path.join(self.rel, "manifest.json"), "w"))
            self.assertEqual(self.apply(), 2, patch)
            self.assertEqual(self.app_html(), "old")

    def test_refuses_dangerous_archives(self):
        bad = {
            "絶対パス": [("/etc/passwd", b"x")],
            "..": [("plasmod-3.1.0/../evil", b"x")],
            "外のディレクトリ": [("other/x", b"x")],
            "外を指すリンク": GOOD + [("plasmod-3.1.0/l", ("sym", "../../etc/passwd"))],
            "絶対のリンク": GOOD + [("plasmod-3.1.0/l", ("sym", "/etc/passwd"))],
            "ハードリンク": GOOD + [("plasmod-3.1.0/h", ("hard", "plasmod-3.1.0/package.json"))],
            "デバイス": GOOD + [("plasmod-3.1.0/dev", ("dev",))],
            "中身が違う": [("plasmod-3.1.0", None), ("plasmod-3.1.0/x", b"x")],
        }
        for label, entries in bad.items():
            self.release(entries)
            self.assertEqual(self.apply(), 2, label)
            self.assertEqual(self.app_html(), "old", label)
        self.assertFalse(os.path.exists(os.path.join(self.d, "evil")))

    def test_allows_internal_symlink_and_strips_setuid(self):
        entries = GOOD + [("plasmod-3.1.0/dist/link", ("sym", "web/index.html"))]
        data = tar_bytes(entries)
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
            self.assertEqual(len(upd.safe_members(tf, "plasmod-3.1.0")), len(entries))

    # ---- 起動に失敗したら戻す ----
    def rolled_back(self, mode, why):
        Health.mode = mode
        self.release()
        self.assertEqual(self.apply(), 1)
        self.assertEqual(self.app_html(), "old")
        self.assertTrue(os.path.exists(os.path.join(self.app, "broker", "plasmod-broker")))
        st = self.status()
        self.assertEqual((st["state"], st["rolledBack"]), ("rolled_back", True))
        self.assertIn(why, st["error"])
        self.assertGreaterEqual(open(self.sysctl_log).read().count("start plasmod"), 2)

    def test_rolls_back_when_unhealthy(self):
        self.rolled_back("down", "health")

    def test_rolls_back_when_auth_is_open(self):
        self.rolled_back("open", "認証")

    def test_rolls_back_when_service_wont_start(self):
        self.fake("systemctl", f'echo "$@" >> {self.sysctl_log}\n[ "$1" = is-active ] && echo inactive\n[ "$1" = start ] && [ ! -e {self.d}/started-once ] && touch {self.d}/started-once && exit 1\nexit 0')
        self.release()
        self.assertEqual(self.apply(), 1)
        self.assertEqual(self.app_html(), "old")
        self.assertEqual(self.status()["state"], "rolled_back")

    def test_tree_digest_matches_build_release(self):
        root = tempfile.mkdtemp()
        os.makedirs(os.path.join(root, "broker", "sub"))
        for p, c in (("broker/x", "a"), ("broker/sub/y", "bb"), ("broker/sub/a", "c")):
            open(os.path.join(root, p), "w").write(c)
        self.assertEqual(upd.tree_digest(root, "broker"), "400556a80339bab1493adb51e4427e22a2fea4703f31cd0323fe4d93f2240e3c")
        shutil.rmtree(root)


if __name__ == "__main__":
    unittest.main()
