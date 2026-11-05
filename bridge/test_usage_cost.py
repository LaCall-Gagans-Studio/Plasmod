# app-usage-cost.patch を当てた plasmod_bridge.py の、使用量の API 換算の金額の動作確認。
# 使い方: ~/.plasmod-bridge/venv/bin/python test_app_usage_cost.py [plasmod_bridge.py のパス]
import json, os, sys, tempfile, time, importlib.util
spec = importlib.util.spec_from_file_location("b", sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "plasmod_bridge.py")); b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
d = tempfile.mkdtemp()
b.HOME = d
proj = os.path.join(d, ".claude", "projects", "p"); os.makedirs(proj)
now = time.time()
iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))
rec = lambda t, mid, model, u: json.dumps({"timestamp": iso(t), "message": {"id": mid, "model": model, "usage": u, "content": "秘密"}}) + "\n"
with open(os.path.join(proj, "s.jsonl"), "w") as f:
    big = {"input_tokens": 1_000_000, "output_tokens": 1_000_000, "cache_creation_input_tokens": 1_000_000, "cache_read_input_tokens": 1_000_000}
    # 同じ返事が途中経過ごとに2行入る → 1回だけ数える
    f.write(rec(now - 3600, "m1", "claude-opus-5-5", big))
    f.write(rec(now - 3500, "m1", "claude-opus-5-5", big))
    # 7日の中・5時間の外の Sonnet 5.5
    f.write(rec(now - 3 * 86400, "m2", "claude-sonnet-5-5", {"input_tokens": 1_000_000, "output_tokens": 0}))
    # 単価の分からないモデルは金額に入れず、名前を返す。<synthetic> は数えない
    f.write(rec(now - 600, "m3", "claude-unknown-9", {"input_tokens": 10, "output_tokens": 5}))
    f.write(rec(now - 500, "m4", "<synthetic>", {"input_tokens": 0, "output_tokens": 0}))
    # id の無い古い記録は今までどおり1行ずつ
    f.write(json.dumps({"timestamp": iso(now - 400), "message": {"model": "claude-haiku-5-5", "usage": {"input_tokens": 1_000_000, "output_tokens": 0}}}) + "\n")
u = b.claude_usage(now)
assert u["messages_h5"] == 4 and u["messages_d7"] == 5, u
assert u["h5"]["claude-opus-5-5"] == 3_000_000, u
# Opus 5.5: 入力 4 + 出力 20 + 書き込み 5 + 読み込み 0.2 = 29.2、Haiku 5.5: 入力 0.1
assert abs(u["cost_h5"] - 29.3) < 1e-6, u
# 7日: さらに Sonnet 5.5 の入力 2
assert abs(u["cost_d7"] - 31.3) < 1e-6, u
assert u["unpriced"] == ["claude-unknown-9"], u
assert "秘密" not in json.dumps(u), u
assert b.claude_price("claude-opus-4-8") == (5, 25, 6.25, 0.5) and b.claude_price("claude-sonnet-4-6")[0] == 3
print("bridge app-usage-cost OK")
