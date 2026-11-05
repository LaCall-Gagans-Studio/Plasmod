#!/usr/bin/python3
"""開発エージェント用チャンネル MCP サーバー（1スレッド = 1セッション）。

plasmod-bridge が起動した Claude Code セッションだけが BRIDGE_THREAD を持つ。
それ以外のセッション（vps-dev, カンバン）でも user scope で読み込まれるが、そのときは何もしない。

bridge とは unix socket で JSON 行をやり取りする:
  → bridge: hello / reply / permission_request
  ← bridge: message / verdict / ack
"""
import json
import os
import socket
import sys
import threading
import time

THREAD = os.environ.get("BRIDGE_THREAD")
SOCK = os.environ.get("BRIDGE_BRIDGE_SOCK", os.path.expanduser("~/.plasmod-bridge/bridge.sock"))

INSTRUCTIONS = (
    "This session is bound to one Plasmod app session. Messages from the owner arrive as "
    "<channel source=\"thread\" chat_id=\"...\" ...>. Answer ONLY by calling the `reply` tool "
    "(mcp__thread__reply) with that chat_id — plain assistant text is not delivered to the app. "
    "For long tasks, send a short reply when you start and when you finish. "
    "To attach files, pass absolute paths in `files`. "
    "Messages typed directly in this session (from the Claude app) need no reply tool."
)

out_lock = threading.Lock()
bridge = None
bridge_lock = threading.Lock()
pending = {}          # id -> [Event, result]
next_id = [1]


def send_cc(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def send_bridge(obj):
    with bridge_lock:
        if bridge is None:
            return False
        try:
            bridge.sendall((json.dumps(obj, ensure_ascii=False) + "\n").encode())
            return True
        except OSError:
            return False


def bridge_loop():
    global bridge
    while True:
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.connect(SOCK)
            with bridge_lock:
                bridge = s
            send_bridge({"type": "hello", "thread": THREAD, "pid": os.getppid()})
            buf = b""
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line.strip():
                        handle_bridge(json.loads(line))
        except OSError:
            pass
        with bridge_lock:
            bridge = None
        time.sleep(3)


def handle_bridge(m):
    t = m.get("type")
    if t == "message":
        send_cc({"jsonrpc": "2.0", "method": "notifications/claude/channel",
                 "params": {"content": m["content"], "meta": m.get("meta", {})}})
    elif t == "verdict":
        send_cc({"jsonrpc": "2.0", "method": "notifications/claude/channel/permission",
                 "params": {"request_id": m["request_id"], "behavior": m["behavior"]}})
    elif t == "ack":
        p = pending.get(m.get("id"))
        if p:
            p[1] = m
            p[0].set()


REPLY_TOOL = {
    "name": "reply",
    "description": "Send a message to the app session this session is bound to. "
                   "Pass chat_id from the <channel> tag. Optional files: absolute paths to attach.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "chat_id": {"type": "string"},
            "text": {"type": "string"},
            "files": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["chat_id", "text"],
    },
}


def call_reply(args):
    rid = next_id[0]; next_id[0] += 1
    ev = threading.Event()
    pending[rid] = [ev, None]
    ok = send_bridge({"type": "reply", "id": rid, "thread": THREAD, "chat_id": args.get("chat_id"),
                      "text": args.get("text", ""), "files": args.get("files") or []})
    if not ok:
        pending.pop(rid, None)
        return "error: bridge is not connected"
    ev.wait(60)
    res = pending.pop(rid, [None, None])[1]
    if not res:
        return "error: no ack from bridge (timeout)"
    return "sent" if res.get("ok") else f"error: {res.get('error')}"


def main():
    for line in sys.stdin:
        try:
            m = json.loads(line)
        except ValueError:
            continue
        mid, meth = m.get("id"), m.get("method")
        if meth == "initialize":
            caps = {}
            if THREAD:
                caps = {"experimental": {"claude/channel": {}, "claude/channel/permission": {}}, "tools": {}}
            send_cc({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": m["params"]["protocolVersion"], "capabilities": caps,
                "serverInfo": {"name": "thread", "version": "1.0"},
                **({"instructions": INSTRUCTIONS} if THREAD else {})}})
        elif meth == "notifications/initialized":
            if THREAD:
                threading.Thread(target=bridge_loop, daemon=True).start()
        elif meth == "tools/list":
            send_cc({"jsonrpc": "2.0", "id": mid, "result": {"tools": [REPLY_TOOL] if THREAD else []}})
        elif meth == "tools/call":
            name = m["params"].get("name")
            if THREAD and name == "reply":
                def run(mid=mid, args=m["params"].get("arguments") or {}):
                    text = call_reply(args)
                    send_cc({"jsonrpc": "2.0", "id": mid, "result": {
                        "content": [{"type": "text", "text": text}], "isError": text.startswith("error")}})
                threading.Thread(target=run, daemon=True).start()
            else:
                send_cc({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"unknown tool {name}"}})
        elif meth == "notifications/claude/channel/permission_request":
            send_bridge({"type": "permission_request", "thread": THREAD, **m.get("params", {})})
        elif mid is not None:
            send_cc({"jsonrpc": "2.0", "id": mid, "result": {}})


if __name__ == "__main__":
    main()
