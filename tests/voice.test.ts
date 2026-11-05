import { describe, expect, test } from "bun:test";
import { webDictation } from "../src/web/dictation";
import { type DraftStorage, type VoiceApi, VoiceDraft } from "../src/web/voice-draft";

function storage(): DraftStorage & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

describe("音声メモの本文を失わない", () => {
  test("話した分は先に端末へ。送れたら 2 回目からは更新", async () => {
    const calls: string[] = [];
    const api: VoiceApi = {
      create: async (t, b) => (calls.push(`create ${t} ${b}`), { id: 1, updatedAt: 10 }),
      update: async (id, b, base) => (calls.push(`update ${id} ${b} ${base}`), { id, updatedAt: 20 }),
    };
    const s = storage();
    const d = new VoiceDraft(api, s, "題");
    d.append("  ");
    expect(d.dirty).toBe(false);
    d.append("一文目");
    expect(s.m.get("gh-voice-draft")).toContain("一文目");
    expect(await d.save()).toBe(true);
    d.append("二文目");
    expect(await d.save()).toBe(true);
    expect(calls).toEqual(["create 題 一文目", "update 1 一文目\n二文目 10"]);
    expect(d.finish()).toBe(true);
    expect(s.m.size).toBe(0);
  });

  test("通信が切れても残り、開き直すと続きになり、つながれば送る", async () => {
    let online = false;
    const sent: string[] = [];
    const api: VoiceApi = {
      create: async (_t, b) => {
        if (!online) throw new Error("offline");
        sent.push(b);
        return { id: 1, updatedAt: 1 };
      },
      update: async () => ({ id: 1, updatedAt: 2 }),
    };
    const s = storage();
    const d = new VoiceDraft(api, s, "題");
    d.append("圏外で話した");
    expect(await d.save()).toBe(false);
    expect(d.finish()).toBe(false); // 届いていないので消さない
    const again = new VoiceDraft(api, s, "別の題");
    expect(again.state.body).toBe("圏外で話した");
    expect(again.state.title).toBe("題");
    online = true;
    again.append("戻ってから");
    expect(await again.save()).toBe(true);
    expect(sent).toEqual(["圏外で話した\n戻ってから"]);
  });

  test("ほかで書き換えられていたら上書きせず、続きを別のメモに残す", async () => {
    const made: string[] = [];
    const api: VoiceApi = {
      create: async (t) => (made.push(t), { id: made.length, updatedAt: 1 }),
      update: async () => {
        throw Object.assign(new Error("conflict"), { status: 409 });
      },
    };
    const d = new VoiceDraft(api, storage(), "題");
    d.append("a");
    await d.save();
    d.append("b");
    expect(await d.save()).toBe(true);
    expect(made).toEqual(["題", "題（続き）"]);
    expect(d.state.memoId).toBe(2);
  });
});

describe("聞き続ける", () => {
  class FakeRec {
    static all: FakeRec[] = [];
    lang = "";
    interimResults = false;
    continuous = false;
    started = 0;
    onresult: ((e: never) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    constructor() {
      FakeRec.all.push(this);
    }
    start() {
      this.started++;
    }
    stop() {
      this.onend?.();
    }
    say(text: string, isFinal: boolean) {
      const r = Object.assign([{ transcript: text }], { isFinal });
      this.onresult?.({ resultIndex: 0, results: [r] } as never);
    }
  }

  test("切れてもつなぎ直し、確定した文は1回だけ。止めたら掛け直さない。許可が無ければ止まる", () => {
    FakeRec.all = [];
    const finals: string[] = [];
    const partials: string[] = [];
    const states: string[] = [];
    const errors: string[] = [];
    const waits: number[] = [];
    const d = webDictation(FakeRec as never, { onFinal: (t) => finals.push(t), onPartial: (t) => partials.push(t), onState: (s) => states.push(s), onError: (m) => errors.push(m) }, (fn, ms) => {
      waits.push(ms);
      fn();
    });
    d.start();
    expect(FakeRec.all[0]).toMatchObject({ lang: "ja-JP", interimResults: true, continuous: true, started: 1 });
    FakeRec.all[0].say("途中", false);
    FakeRec.all[0].say("確定", true);
    expect(partials).toContain("途中");
    expect(finals).toEqual(["確定"]);

    // 認識が切れた → 掛け直す
    FakeRec.all[0].onend!();
    expect(FakeRec.all.length).toBe(2);
    expect(waits).toEqual([100]);

    // 通信のエラー → 間を空ける
    FakeRec.all[1].onerror!({ error: "network" });
    expect(states.at(-1)).toBe("retrying");
    FakeRec.all[1].onend!();
    expect(waits.at(-1)).toBe(500);
    expect(FakeRec.all.length).toBe(3);

    // 止める → 掛け直さない
    d.stop();
    expect(FakeRec.all.length).toBe(3);
    expect(states.at(-1)).toBe("off");

    // 許可なし → エラーで止まる
    d.start();
    const last = FakeRec.all.at(-1)!;
    last.onerror!({ error: "not-allowed" });
    last.onend!();
    expect(errors).toEqual(["マイクが許可されていない"]);
    expect(FakeRec.all.at(-1)).toBe(last);
  });
});
