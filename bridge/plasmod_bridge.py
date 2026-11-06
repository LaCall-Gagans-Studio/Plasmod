#!/usr/bin/env python3
"""plasmod-bridge: アプリのセッション 1本 = Claude Code セッション 1本 にする中継役（ユーザー cc で動く）

- アプリからの発言 → そのセッションへ（止まっていれば --resume で再開）。番号が無ければ新しく起動する
- セッションは tmux（-L tsg、ホスト名 myhost の名前空間で systemd が起動済み）の中で動く。
  --remote-control で Claude アプリにもセッション名で表示される
- 返信・承認依頼はセッション内の thread_channel.py から unix socket で受け取り、記録に残してアプリに流す
- 15分何もなければセッションを止める。同時に起動しておくのは MAX_ALIVE まで
"""
import asyncio
import json
import os
import pwd
import re
import shlex
import socket
import struct
import subprocess
import time
import uuid

HOME = os.path.expanduser("~")
AGENT_NAME = os.environ.get("BRIDGE_AGENT_NAME", "開発エージェント")
OWNER_NAME = os.environ.get("BRIDGE_OWNER_NAME", "オーナー")
STATE_DIR = os.path.join(HOME, ".plasmod-bridge")
STATE = os.path.join(STATE_DIR, "state.json")
SOCK = os.path.join(STATE_DIR, "bridge.sock")
APP_SOCK = os.environ.get("BRIDGE_APP_SOCK", "/run/plasmod-dev/app.sock")
HISTORY_DIR = os.path.join(STATE_DIR, "history")   # セッションごとの会話の記録（正本）   # アプリ用の窓口
APP_USER = "plasmod"                           # app.sock につなげるのはこのユーザーだけ（SO_PEERCRED で確かめる）
INBOX = os.path.join(HOME, "work", ".inbox")
WORK = os.path.join(HOME, "work")

TMUX = ["tmux", "-L", "tsg"]
CLAUDE = os.path.join(HOME, ".local", "bin", "claude")
MAX_ALIVE = 4
IDLE_SEC = 15 * 60
READY_TIMEOUT = 120


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def load_state():
    try:
        return json.load(open(STATE))
    except (OSError, ValueError):
        return {"threads": {}}


def save_state(st):
    tmp = STATE + ".tmp"
    json.dump(st, open(tmp, "w"), ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


def tmux(*args, check=False):
    return subprocess.run(TMUX + list(args), capture_output=True, text=True, check=check)


def tmux_name(tid):
    return f"th{tid}"


def pane_text(tid, history=False):
    r = tmux("capture-pane", "-p", "-J", "-t", tmux_name(tid), *(["-S", "-"] if history else []))
    return r.stdout if r.returncode == 0 else ""


def tmux_alive(tid):
    return tmux("has-session", "-t", tmux_name(tid)).returncode == 0


class Session:
    def __init__(self, tid):
        self.tid = tid
        self.writer = None          # asyncio StreamWriter to thread_channel
        self.ready = asyncio.Event()      # 受け口がつながり、チャンネルが有効になった
        self.connected = False
        self.connected_at = None
        self.queue = []             # messages waiting for readiness
        self.last = time.time()
        self.starting = False


class LocalThread:
    """1セッションの送り先。知らせは会話の記録に残す。"""

    def __init__(self, bridge, tid, name):
        self.bridge, self.id, self.name = bridge, int(tid), name
        self.parent = None

    async def send(self, content=None, **_):
        await self.bridge.log_chat(str(self.id), {"author": "system", "content": str(content or "")})


class Bridge:
    def __init__(self):
        self.loop = None
        self.st = load_state()
        self.sessions = {}          # tid(str) -> Session
        self.apps = set()           # アプリの接続（asyncio StreamWriter）
        self.pending_perms = {}     # (tid, request_id) -> アプリに送った承認依頼

    async def start(self):
        self.loop = asyncio.get_running_loop()
        os.makedirs(STATE_DIR, exist_ok=True)
        if os.path.exists(SOCK):
            os.unlink(SOCK)
        self.server = await asyncio.start_unix_server(self.on_channel_conn, path=SOCK, limit=8 * 1024 * 1024)
        os.chmod(SOCK, 0o600)
        if os.path.exists(APP_SOCK):
            os.unlink(APP_SOCK)
        self.app_server = await asyncio.start_unix_server(self.on_app_conn, path=APP_SOCK, limit=96 * 1024 * 1024)   # 添付（base64）は1行で届く
        os.chmod(APP_SOCK, 0o666)   # 入れるかどうかは置き場所のディレクトリ（cc:plasmod 0750）と on_app_conn の uid 確認で決める
        self.loop.create_task(self.reaper())

    def thread_rec(self, tid):
        return self.st["threads"].get(str(tid))

    # ---------- sessions ----------
    async def deliver(self, thread, content, meta):
        tid = str(thread.id)
        s = self.sessions.get(tid)
        if not s or not tmux_alive(tid):
            s = await self.start_session(thread)
            if s is None:
                return
        s.last = time.time()
        payload = {"type": "message", "content": content, "meta": meta}
        if s.ready.is_set() and s.writer:
            await self.write(s, payload)
        else:
            s.queue.append(payload)

    async def start_session(self, thread):
        tid = str(thread.id)
        alive = [t for t in self.sessions if tmux_alive(t)]
        if len(alive) >= MAX_ALIVE:
            victim = min((self.sessions[t] for t in alive if not self.working(t)),
                         key=lambda x: x.last, default=None)
            if victim is None:
                await thread.send(f"⏳ いま {len(alive)} 件が作業中なので、空くまで待ってください（同時に動かせるのは {MAX_ALIVE} 件まで）。")
                return None
            await self.stop_session(victim.tid, reason="同時起動数の上限")
        rec = self.thread_rec(tid)
        new = rec is None
        if new:
            rec = {"session_id": str(uuid.uuid4()), "title": thread.name, "created": int(time.time())}
            self.st["threads"][tid] = rec
            save_state(self.st)
        s = Session(tid)
        s.starting = True
        self.sessions[tid] = s
        title = f"{AGENT_NAME}: {rec['title']}"[:60]
        flag = ["--session-id", rec["session_id"]] if new else ["--resume", rec["session_id"]]
        model = read_model("chat")
        if model:
            flag += ["--model", model]
        cmd = " ".join(shlex.quote(x) for x in (
            ["env", f"BRIDGE_THREAD={tid}", f"BRIDGE_BRIDGE_SOCK={SOCK}", CLAUDE] + flag +
            ["--remote-control", title, "--dangerously-load-development-channels", "server:thread"]))
        tmux("kill-session", "-t", tmux_name(tid))
        r = tmux("new-session", "-d", "-s", tmux_name(tid), "-x", "200", "-y", "50", "-c", WORK, cmd)
        if r.returncode != 0:
            await thread.send(f"⚠️ {AGENT_NAME}を起動できませんでした: {r.stderr.strip()[:300]}")
            self.sessions.pop(tid, None)
            return None
        log("started", tid, "new" if new else "resume", rec["session_id"])
        if not new:
            await thread.send("🔁 前の会話を再開しています…")
        self.loop.create_task(self.babysit_start(thread, s))
        return s

    async def babysit_start(self, thread, s):
        """起動時の確認画面（開発用チャンネルの警告など）を自動で進め、受け口がつながるのを待つ。"""
        s.starting = True
        deadline = time.time() + READY_TIMEOUT
        while time.time() < deadline and not s.ready.is_set():
            await asyncio.sleep(2)
            if not tmux_alive(s.tid):
                break
            txt = pane_text(s.tid)
            if "Enter to confirm" in txt or "Do you trust" in txt or "Press Enter to continue" in txt:
                tmux("send-keys", "-t", tmux_name(s.tid), "Enter")
                continue
            # 警告画面が消え、受け口もつながったら渡してよい。
            # 再開時は過去の会話で「チャンネル有効」の表示が画面外に流れるので履歴ごと探し、
            # 見つからなくても接続から 15 秒たって確認画面が無ければ渡す
            if s.connected and "❯" in txt:
                if s.connected_at is None:
                    s.connected_at = time.time()
                if "inject directly in this session" in pane_text(s.tid, history=True) \
                        or time.time() - s.connected_at > 15:
                    await asyncio.sleep(2)
                    await self.mark_ready(s)
        s.starting = False
        if not s.ready.is_set():
            tail = "\n".join(l for l in pane_text(s.tid).splitlines() if l.strip())[-800:]
            lost = len(s.queue)
            await thread.send(f"⚠️ {AGENT_NAME}の起動が {READY_TIMEOUT} 秒以内に終わりませんでした。"
                              + (f"届けられなかったメッセージが {lost} 件あります。もう一度送ってください。" if lost else "")
                              + f"\n```\n{tail}\n```")
            await self.stop_session(s.tid, reason="起動失敗")

    async def mark_ready(self, s):
        if s.ready.is_set() or not s.writer:
            return
        s.ready.set()
        log("ready", s.tid, f"flush {len(s.queue)}")
        for p in s.queue:
            await self.write(s, p)
        s.queue.clear()

    def working(self, tid):
        return "esc to interrupt" in pane_text(tid)

    async def stop_session(self, tid, reason=""):
        s = self.sessions.pop(tid, None)
        tmux("kill-session", "-t", tmux_name(tid))
        if s and s.writer:
            s.writer.close()
        log("stopped", tid, reason)

    async def reaper(self):
        while True:
            await asyncio.sleep(60)
            now = time.time()
            for tid, s in list(self.sessions.items()):
                if not tmux_alive(tid):
                    self.sessions.pop(tid, None)
                    log("gone", tid)
                elif now - s.last > IDLE_SEC and not self.working(tid):
                    await self.stop_session(tid, reason="15分無操作")

    # ---------- channel socket ----------
    async def write(self, s, obj):
        s.writer.write((json.dumps(obj, ensure_ascii=False) + "\n").encode())
        await s.writer.drain()

    async def on_channel_conn(self, reader, writer):
        s = None
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                m = json.loads(line)
                t = m.get("type")
                if t == "hello":
                    tid = str(m.get("thread"))
                    s = self.sessions.get(tid)
                    survivor = s is None or not s.starting   # bridge 再起動後・再接続など、起動処理中でないもの
                    if s is None:
                        s = Session(tid); self.sessions[tid] = s
                    s.writer = writer
                    s.connected = True
                    log("connected", tid)
                    if survivor:
                        await self.mark_ready(s)
                elif t == "reply":
                    ok, err = await self.post_reply(m)
                    if s:
                        s.last = time.time()
                    writer.write((json.dumps({"type": "ack", "id": m.get("id"), "ok": ok, "error": err}) + "\n").encode())
                    await writer.drain()
                elif t == "permission_request":
                    await self.post_permission(m)
        except (ConnectionError, ValueError) as e:
            log("channel conn error", e)
        finally:
            if s and s.writer is writer:
                s.writer = None
                s.connected = False
                s.ready.clear()

    async def get_thread(self, tid):
        rec = self.thread_rec(tid)
        return LocalThread(self, tid, (rec or {}).get("title") or "")

    async def post_reply(self, m):
        tid = str(m.get("thread"))
        if str(m.get("chat_id")) != tid:
            return False, f"chat_id はこのスレッド（{tid}）だけ指定できる"
        media = []
        for p in m.get("files") or []:
            rp = os.path.realpath(p)
            if not (rp.startswith(WORK + "/") or rp.startswith("/tmp/")) or not os.path.isfile(rp):
                return False, f"添付できないパス: {p}（~/work か /tmp の下のファイルだけ）"
            if os.path.getsize(rp) > 25 * 1024 * 1024:
                return False, f"25MB を超えている: {p}"
            media.append({"name": os.path.basename(p), "path": rp})
        await self.log_chat(tid, {"author": "dev", "content": m.get("text", ""),
                                  "attachments": [os.path.basename(p) for p in (m.get("files") or [])], "media": media})
        return True, None

    async def post_permission(self, m):
        tid, rid = str(m.get("thread")), m.get("request_id", "")
        rec = self.thread_rec(tid) or {}
        app_msg = {"type": "permission_request", "thread": tid, "request_id": rid,
                   "tool_name": m.get("tool_name"), "description": m.get("description", ""),
                   "input_preview": (m.get("input_preview") or "")[:1200], "thread_title": rec.get("title"),
                   "created_at": int(time.time())}
        self.pending_perms[(tid, rid)] = app_msg
        await self.broadcast_apps(app_msg)
        await self.log_chat(tid, {"author": "system", "content": f"🔐 承認待ち: {m.get('tool_name')} — {m.get('description', '')}"})

    async def send_verdict(self, tid, rid, behavior):
        s = self.sessions.get(tid)
        if s and s.writer:
            await self.write(s, {"type": "verdict", "request_id": rid, "behavior": behavior})
            s.last = time.time()
        was_pending = self.pending_perms.pop((tid, rid), None) is not None
        await self.broadcast_apps({"type": "permission_resolved", "thread": tid, "request_id": rid, "behavior": behavior})
        if was_pending:
            await self.log_chat(tid, {"author": "system", "content": "✅ 許可した" if behavior == "allow" else "❌ 拒否した"})

    # ---------- Plasmod（アプリ）----------
    async def broadcast_apps(self, obj):
        data = (json.dumps(obj, ensure_ascii=False) + "\n").encode()
        for w in list(self.apps):
            try:
                w.write(data)
                await w.drain()
            except (ConnectionError, RuntimeError):
                self.apps.discard(w)

    def app_peer_ok(self, writer):
        """接続相手の uid が APP_USER かどうか。確かめられなければ拒否。"""
        try:
            sock = writer.get_extra_info("socket")
            _pid, uid, _gid = struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
            return uid == pwd.getpwnam(APP_USER).pw_uid
        except (KeyError, OSError, AttributeError, struct.error):
            return False

    def app_thread(self, m):
        tid = str(m.get("thread") or "")
        if not tid.isdigit() or self.thread_rec(tid) is None:
            raise ValueError(f"知らないセッション: {tid!r}")
        return tid

    def save_app_files(self, tid, files):
        """アプリから届いた添付（base64）を、~/work/.inbox/<thread>/に置く。"""
        import base64
        if len(files) > 10:
            raise ValueError("添付は10個まで")
        d = os.path.join(INBOX, tid)
        out = []
        for i, f in enumerate(files):
            name = os.path.basename(str(f.get("name") or "")).lstrip(".").strip()[:100] or f"file-{i + 1}"
            data = base64.b64decode(str(f.get("data") or ""), validate=True)
            if len(data) > 25 * 1024 * 1024:
                raise ValueError(f"{name} が 25MB を超えている")
            os.makedirs(d, exist_ok=True)
            p = os.path.join(d, f"app-{int(time.time() * 1000)}-{i}-{name}")
            with open(p, "wb") as fh:
                fh.write(data)
            out.append(p)
        return out

    async def app_request(self, m):
        t = m.get("type")
        if t == "list_sessions":
            items = []
            for tid, rec in self.st["threads"].items():
                alive = tmux_alive(tid)
                s = self.sessions.get(tid)
                items.append({"thread": tid, "title": rec.get("title", ""), "created": rec.get("created"),
                              "alive": alive, "working": alive and self.working(tid),
                              "last": int(s.last) if s else rec.get("created")})
            items.sort(key=lambda x: x["last"] or 0, reverse=True)
            return {"sessions": items[:50]}
        if t == "pane":
            tid = self.app_thread(m)
            if not tmux_alive(tid):
                return {"text": "", "alive": False}
            r = tmux("capture-pane", "-p", "-J", "-t", tmux_name(tid), "-S", "-300")
            return {"text": r.stdout if r.returncode == 0 else "", "alive": True, "working": self.working(tid)}
        if t == "stop":
            tid = self.app_thread(m)
            await self.stop_session(tid, reason="アプリから")
            return {}
        if t == "send":
            text = str(m.get("text") or "").strip()[:8000]
            if not text:
                raise ValueError("本文が空")
            if m.get("thread"):
                thread = await self.get_thread(self.app_thread(m))
            else:
                # 番号は数字だけ（記録のファイル名になる）
                name = " ".join(text.split())[:80] or "アプリから"
                thread = LocalThread(self, str(time.time_ns() // 1000), name)
            paths = self.save_app_files(str(thread.id), m.get("files") or [])
            await self.log_chat(str(thread.id), {"author": "owner", "via": "app", "content": text,
                                                 "attachments": [os.path.basename(p) for p in paths],
                                                 "media": [{"name": os.path.basename(p), "path": p} for p in paths]})
            if paths:
                text += "\n\n[添付ファイル]\n" + "\n".join(paths)
            await self.deliver(thread, text, {"chat_id": str(thread.id), "message_id": f"app-{int(time.time() * 1000)}",
                                              "user": f"{OWNER_NAME}（アプリ）"})
            return {"thread": str(thread.id)}
        if t == "usage":
            return {"usage": claude_usage()}
        if t == "auth_status":
            return {"claude": await asyncio.to_thread(claude_auth_status)}
        if t == "get_models":
            return {"models": {k: read_model(k) for k in MODEL_FILES}, "choices": MODEL_CHOICES}
        if t == "set_model":
            target, model = str(m.get("target")), str(m.get("model"))
            if target not in MODEL_FILES or model not in MODEL_CHOICES:
                raise ValueError(f"選べないモデル: {target} {model}")
            with open(MODEL_FILES[target], "w") as f:
                f.write(model + "\n")
            log("model", target, model)
            return {"models": {k: read_model(k) for k in MODEL_FILES}}
        if t == "history":
            tid = self.app_thread(m)
            limit = max(1, min(int(m.get("limit") or 60), 500))
            return {"messages": [public_entry(x) for x in read_history(tid, limit)]}
        if t == "file":
            return media_file(self.app_thread(m), str(m.get("msg") or ""), int(m.get("i") or 0))
        if t == "fs_list":
            return fs_list(str(m.get("path") or ""))
        if t == "fs_read":
            return fs_read(str(m.get("path") or ""))
        raise ValueError(f"知らない操作: {t}")

    async def log_chat(self, tid, entry):
        """会話の記録に1件足して、アプリにも流す。記録が正本。"""
        entry = {"id": entry.get("id") or f"l-{uuid.uuid4().hex[:16]}", "author": entry.get("author", "other"),
                 "via": entry.get("via"), "content": entry.get("content", ""), "attachments": entry.get("attachments") or [],
                 "media": entry.get("media") or [], "at": entry.get("at") or int(time.time())}
        try:
            append_history(tid, entry)
        except OSError as e:
            log("history write failed", tid, e)
        await self.broadcast_apps({"type": "chat", "thread": tid, "message": public_entry(entry)})

    async def on_app_conn(self, reader, writer):
        """アプリには承認依頼を流し、アプリからは verdict と、セッションの操作（一覧・画面・送信・停止）を受け付ける。"""
        if not self.app_peer_ok(writer):
            log("app connection rejected (uid)")
            writer.close()
            return
        self.apps.add(writer)
        log("app connected")
        try:
            writer.write((json.dumps({"type": "hello"}) + "\n").encode())
            for p in self.pending_perms.values():
                writer.write((json.dumps(p, ensure_ascii=False) + "\n").encode())
            await writer.drain()
            while True:
                line = await reader.readline()
                if not line:
                    break
                m = json.loads(line)
                if m.get("type") == "verdict" and m.get("behavior") in ("allow", "deny"):
                    tid, rid = str(m.get("thread")), str(m.get("request_id"))
                    if (tid, rid) in self.pending_perms:
                        await self.send_verdict(tid, rid, m["behavior"])
                elif m.get("type") in ("list_sessions", "pane", "send", "stop", "usage", "auth_status", "get_models", "set_model", "fs_list", "fs_read", "history", "file"):
                    try:
                        res = await self.app_request(m)
                        res.update({"type": "result", "id": m.get("id"), "ok": True})
                    except Exception as e:  # アプリには理由を返す。bridge は止めない
                        res = {"type": "result", "id": m.get("id"), "ok": False, "error": str(e)[:500]}
                    writer.write((json.dumps(res, ensure_ascii=False) + "\n").encode())
                    await writer.drain()
        except (ConnectionError, ValueError) as e:
            log("app conn error", e)
        finally:
            self.apps.discard(writer)
            log("app disconnected")


# ---------- Plasmod: 会話の記録 ----------
def history_path(tid):
    if not str(tid).isdigit():
        raise ValueError("不正なセッション")
    return os.path.join(HISTORY_DIR, f"{tid}.jsonl")


def append_history(tid, entry):
    os.makedirs(HISTORY_DIR, exist_ok=True)
    with open(history_path(tid), "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def read_history(tid, limit):
    try:
        with open(history_path(tid), encoding="utf-8") as f:
            lines = f.readlines()[-limit:]
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def file_size(path):
    try:
        return os.path.getsize(path)
    except (OSError, TypeError):
        return 0


def public_entry(e):
    """アプリに渡す形。ファイルのパスは bridge の中だけに置き、名前と大きさだけ渡す。"""
    out = dict(e)
    out["media"] = [{"name": str(f.get("name") or ""), "size": file_size(f.get("path"))} for f in (e.get("media") or [])]
    return out


MEDIA_MAX = 15 * 1024 * 1024
MEDIA_DENY = re.compile(r"(^|/)(\.env[^/]*|\.git|\.ssh|node_modules|[^/]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)[^/]*|[^/]*(credential|secret|token)[^/]*)(/|$)", re.I)


def media_file(tid, msg_id, i):
    """会話の記録に載っているファイルだけ返す。記録に無いパスは、~/work の中でも返さない。
    シンボリックリンクは実体に直してから ~/work か /tmp の中かを確かめ、鍵・.env などは拒否する。"""
    for e in reversed(read_history(tid, 10 ** 6)):
        if str(e.get("id")) == msg_id:
            break
    else:
        raise ValueError("そのメッセージは記録に無い")
    media = e.get("media") or []
    if not 0 <= i < len(media):
        raise ValueError("そのファイルは記録に無い")
    rp = os.path.realpath(str(media[i].get("path") or ""))
    if rp.startswith(WORK + "/"):
        inner = os.path.relpath(rp, WORK)
        if not inner.startswith(".inbox/" + tid + "/") and MEDIA_DENY.search(inner):
            raise PermissionError(f"見せない場所: {inner}")
    elif rp.startswith("/tmp/"):
        if MEDIA_DENY.search(rp):
            raise PermissionError(f"見せない場所: {rp}")
    else:
        raise PermissionError("~/work と /tmp の外は見せない")
    if not os.path.isfile(rp):
        raise ValueError("ファイルではない")
    if os.path.getsize(rp) > MEDIA_MAX:
        raise ValueError("大きすぎて開けない")
    import base64
    with open(rp, "rb") as f:
        return {"name": os.path.basename(str(media[i].get("name") or rp)), "size": os.path.getsize(rp),
                "data": base64.b64encode(f.read()).decode()}


# ---------- Plasmod: モデル・使用量・ファイル ----------
MODEL_FILES = {"chat": os.path.join(STATE_DIR, "model-chat"), "worker": os.path.join(STATE_DIR, "model-worker")}
MODEL_CHOICES = ["opus", "sonnet"]          # Claude のサブスクで使うもの。これ以外は選ばせない


def read_model(target):
    try:
        v = open(MODEL_FILES[target]).read().strip()
        return v if v in MODEL_CHOICES else None
    except OSError:
        return None


# API で使ったときの単価（ドル / 100万トークン）: 入力・出力・キャッシュの書き込み（5分・入力の1.25倍）・読み込み。
# サブスクなので請求はされない。「API に換えるといくらか」の目安。前から順に、モデル名に含まれるもので決める
CLAUDE_PRICES = [
    ("opus-5-5", (4, 20, 5, 0.2)),
    ("fable", (10, 50, 12.5, 0.25)),
    ("mythos", (10, 50, 12.5, 0.25)),
    ("opus", (5, 25, 6.25, 0.5)),
    ("sonnet-5", (2, 10, 2.5, 0.2)),
    ("sonnet", (3, 15, 3.75, 0.3)),
    ("haiku-5", (0.1, 0.5, 0.125, 0.01)),
    ("haiku", (1, 5, 1.25, 0.1)),
]


def claude_price(model):
    m = model.lower()
    return next((p for k, p in CLAUDE_PRICES if k in m), None)


def claude_auth_status():
    """ログインの有無と期限だけをアプリに返す。メールアドレスや組織は渡さない"""
    import shutil
    path = shutil.which("claude")
    if not path:
        return {"available": False}
    r = subprocess.run([path, "auth", "status"], capture_output=True, text=True, timeout=30)
    # ログインしていないときは終了コードが 0 でないが、JSON は出る
    st = json.loads(r.stdout)
    return {"available": True, "loggedIn": bool(st.get("loggedIn")), "authMethod": st.get("authMethod"),
            "loginExpiresAt": st.get("loginExpiresAt")}


def claude_usage(now=None):
    """~/.claude/projects の会話ログ（jsonl）から、直近5時間と7日のトークン数をモデルごとに数え、API 換算の金額も出す。
    数えるのは usage の数字だけ。中身はアプリに返さない。
    ログには同じ返事（message.id）が何行も入る（途中経過ごとに同じ usage）ので、1つの返事は1回だけ数える。"""
    import glob
    from datetime import datetime
    now = now or time.time()
    since7, since5h = now - 7 * 86400, now - 5 * 3600
    out = {"h5": {}, "d7": {}, "messages_h5": 0, "messages_d7": 0, "oldest_h5": None, "cost_h5": 0.0, "cost_d7": 0.0, "unpriced": []}
    seen = set()
    for p in glob.glob(os.path.join(HOME, ".claude", "projects", "*", "*.jsonl")):
        try:
            if os.path.getmtime(p) < since7:
                continue
            with open(p, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if '"usage"' not in line:
                        continue
                    try:
                        e = json.loads(line)
                    except ValueError:
                        continue
                    msg = e.get("message") or {}
                    u = msg.get("usage") if isinstance(msg, dict) else None
                    ts = e.get("timestamp")
                    if not u or not ts:
                        continue
                    mid = msg.get("id")
                    if mid:
                        if mid in seen:
                            continue
                        seen.add(mid)
                    try:
                        t = datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
                    except ValueError:
                        continue
                    if t < since7:
                        continue
                    model = str(msg.get("model") or "?")
                    n = {k: int(u.get(k) or 0) for k in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")}
                    tok = n["input_tokens"] + n["output_tokens"] + n["cache_creation_input_tokens"]
                    price = claude_price(model)
                    cost = 0.0
                    if price:
                        cost = (n["input_tokens"] * price[0] + n["output_tokens"] * price[1] + n["cache_creation_input_tokens"] * price[2] + n["cache_read_input_tokens"] * price[3]) / 1e6
                    elif tok and model not in out["unpriced"] and model != "<synthetic>":
                        out["unpriced"].append(model)
                    out["d7"][model] = out["d7"].get(model, 0) + tok
                    out["messages_d7"] += 1
                    out["cost_d7"] += cost
                    if t >= since5h:
                        out["h5"][model] = out["h5"].get(model, 0) + tok
                        out["messages_h5"] += 1
                        out["cost_h5"] += cost
                        out["oldest_h5"] = t if out["oldest_h5"] is None else min(out["oldest_h5"], t)
        except OSError:
            continue
    out["cost_h5"], out["cost_d7"] = round(out["cost_h5"], 4), round(out["cost_d7"], 4)
    return out


FS_ROOT = WORK
FS_DENY = re.compile(r"(^|/)(\.env[^/]*|\.git|node_modules|\.inbox|[^/]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)[^/]*|[^/]*(credential|secret|token)[^/]*)(/|$)", re.I)
FS_MAX = 256 * 1024


def fs_path(rel):
    rel = rel.strip().lstrip("/")
    if "\0" in rel or len(rel) > 1000:
        raise ValueError("不正なパス")
    p = os.path.realpath(os.path.join(FS_ROOT, rel))
    if p != FS_ROOT and not p.startswith(FS_ROOT + "/"):
        raise ValueError("~/work の外は見られない")
    inner = os.path.relpath(p, FS_ROOT)
    if inner != "." and FS_DENY.search(inner):
        raise PermissionError(f"見せない場所: {inner}")
    return p, ("" if inner == "." else inner)


def fs_list(rel):
    p, inner = fs_path(rel)
    if not os.path.isdir(p):
        raise ValueError("フォルダではない")
    items = []
    for name in sorted(os.listdir(p))[:500]:
        q = os.path.join(p, name)
        sub = os.path.join(inner, name) if inner else name
        try:
            st = os.lstat(q)
        except OSError:
            continue
        hidden = bool(FS_DENY.search(sub))
        items.append({"name": name, "dir": os.path.isdir(q) and not os.path.islink(q), "size": st.st_size,
                      "mtime": int(st.st_mtime), "locked": hidden})
    items.sort(key=lambda x: (not x["dir"], x["name"].lower()))
    return {"path": inner, "items": items}


def fs_read(rel):
    p, inner = fs_path(rel)
    if not os.path.isfile(p):
        raise ValueError("ファイルではない")
    size = os.path.getsize(p)
    with open(p, "rb") as f:
        data = f.read(FS_MAX)
    if b"\0" in data[:8192]:
        return {"path": inner, "size": size, "binary": True, "text": ""}
    return {"path": inner, "size": size, "binary": False, "truncated": size > FS_MAX,
            "text": data.decode("utf-8", errors="replace")}


if __name__ == "__main__":
    async def main():
        await Bridge().start()
        await asyncio.Event().wait()

    log("ready")
    asyncio.run(main())
