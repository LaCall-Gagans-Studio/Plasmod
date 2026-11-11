// Plasmod で付けたエージェントの名前を、Hermes のプロファイルの表示名（profile.yaml の display_name）にも写す（#36 の第一段）。
// 一方向（Plasmod → Hermes）で、名前だけ。内部の id・SOUL・モデル・認証・権限・説明（役割）は触らない。
// 書く前に Hermes 側の今の値を確かめ、最後に Plasmod が書いた値と違えば（Hermes 側で別に直されていれば）上書きせず競合として残す。
import type { Database } from "bun:sqlite";
import type { NameSync } from "../shared/types";

export type { NameSync, NameSyncState } from "../shared/types";

type Call = (...args: string[]) => Promise<string>;

export class HermesNameSync {
  constructor(
    private db: Database,
    private call: Call | null,
  ) {
    db.exec("CREATE TABLE IF NOT EXISTS hermes_name_sync (id TEXT PRIMARY KEY, json TEXT NOT NULL)");
  }

  get(id: string): NameSync | undefined {
    const r = this.db.query("SELECT json FROM hermes_name_sync WHERE id = ?").get(id) as { json: string } | null;
    return r ? (JSON.parse(r.json) as NameSync) : undefined;
  }

  private put(id: string, v: NameSync) {
    this.db.query("INSERT INTO hermes_name_sync (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(id, JSON.stringify(v));
    return v;
  }

  /** 同じ id の書き込みを並べる（同時に2回走ると、確認と書き込みの間で食い違う） */
  private chain = new Map<string, Promise<unknown>>();

  /**
   * Hermes に名前を写す。失敗しても例外にはせず、結果を保存して返す（Plasmod 側の保存は済んでいる）。
   * force なら Hermes 側の今の値を確かめずに上書きする（競合の表示から本人が選んだときだけ）
   */
  sync(id: string, name: string, force = false): Promise<NameSync> {
    const run = (this.chain.get(id) ?? Promise.resolve()).then(() => this.doSync(id, name, force));
    const tail = run.catch(() => {});
    this.chain.set(id, tail);
    void tail.then(() => this.chain.get(id) === tail && this.chain.delete(id));
    return run;
  }

  private async doSync(id: string, name: string, force: boolean): Promise<NameSync> {
    const prev = this.get(id);
    const at = Date.now();
    if (!this.call) return this.put(id, { state: "failed", synced: prev?.synced, error: "Hermes の仲介につながっていない", at });
    // 初めて書くときは Hermes 側が空のはず。最後に書いた値があれば、それがまだ残っているはず
    const arg: { name: string; expect?: string } = force ? { name } : { name, expect: prev?.synced ?? "" };
    try {
      const out = JSON.parse(await this.call("set-display-name", id, JSON.stringify(arg))) as { ok?: boolean; conflict?: boolean; current?: string };
      if (out.ok) return this.put(id, { state: "synced", synced: out.current ?? name, at });
      if (out.conflict) return this.put(id, { state: "conflict", synced: prev?.synced, current: out.current ?? "", at });
      return this.put(id, { state: "failed", synced: prev?.synced, error: "Hermes の返事が読めない", at });
    } catch (e) {
      return this.put(id, { state: "failed", synced: prev?.synced, error: (e instanceof Error ? e.message : String(e)).slice(0, 300), at });
    }
  }
}
