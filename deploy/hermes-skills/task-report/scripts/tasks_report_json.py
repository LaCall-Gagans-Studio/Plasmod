#!/usr/bin/env python3
"""Plasmod のタスク（plasmod-task）を、format_task_report.py が読む JSON（issue の一覧と同じ形）にする。

  python3 tasks_report_json.py [--as default] | python3 format_task_report.py --today YYYY-MM-DD --mode morning

- 開いているタスク（判断待ち・やる・任せた・返事待ち）と、直近24時間に済み・不要になったタスク
- 状態は一般的な名前に寄せる: 判断待ち・やる → Todo、任せた → In Progress、返事待ち → In Review、済み → Done、不要 → Canceled
- id は番号（TASK-123）、parentId は親の番号。本文に ID を出さないのは format_task_report.py の役目
"""
import argparse
import datetime
import json
import subprocess
import sys

STATUS = {"inbox": "Todo", "todo": "Todo", "doing": "In Progress", "waiting": "In Review", "done": "Done"}


def gh_task(as_, *args):
    cmd = ["plasmod-task", "--json"] + (["--as", as_] if as_ else []) + list(args)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(r.stderr.strip() or f"plasmod-task が失敗した（{r.returncode}）")
    return json.loads(r.stdout)


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--as", dest="as_", default="default")
    p.add_argument("--hours", type=int, default=24, help="済み・不要を何時間前まで入れるか")
    a = p.parse_args()
    now = datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000
    open_ = gh_task(a.as_, "list", "--status", "inbox,todo,doing,waiting", "-n", "500")
    closed = [t for t in gh_task(a.as_, "list", "--status", "done", "-n", "200") if now - (t.get("decidedAt") or t["updatedAt"]) <= a.hours * 3600_000]
    refs = {t["id"]: t.get("ref") or f"#{t['id']}" for t in open_ + closed}
    issues = [
        {
            "id": t.get("ref") or f"#{t['id']}",
            "title": t["title"],
            "status": "Canceled" if t.get("doneReason") == "unneeded" else STATUS.get(t["status"], "Todo"),
            "project": t.get("project"),
            "dueDate": t.get("due"),
            "updatedAt": iso(t["updatedAt"]),
            # 親子（サブタスクは本文に出さず、親に「（サブ：x）」と付ける。format_task_report.py の決まり）
            "parentId": refs.get(t.get("parentId")) if t.get("parentId") else None,
        }
        for t in open_ + closed
    ]
    json.dump({"issues": issues}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
