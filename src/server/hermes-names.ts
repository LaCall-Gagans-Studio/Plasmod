// Plasmod で付けたエージェントの名前を、Hermes のプロファイルの表示名（profile.yaml の display_name）にも写す（#36 の第一段）。
// 一方向（Plasmod → Hermes）。kind=name は表示名、kind=description は役割（プロファイルの説明）だけ。内部の id・SOUL・モデル・認証・権限は触らない。
// 書く前に Hermes 側の今の値を確かめ、最後に Plasmod が書いた値と違えば（Hermes 側で別に直されていれば）上書きせず競合として残す。
import type { Database } from "bun:sqlite";
import type { NameSync } from "../shared/types";

export type { NameSync, NameSyncState } from "../shared/types";

type Call = (...args: string[]) => Promise<string>;

/** name: 表示名（display_name）/ description: プロファイルの説明（役割。カンバンの担当選択に使われる）。#36 */
export type SyncKind = "name" | "description";

export class HermesNameSync {
  private table: string;
  private op: string;
  constructor(
    private db: Database,
    private call: Call | null,
    private kind: SyncKind = "name",
  ) {
    this.table = kind === "name" ? "hermes_name_sync" : "hermes_description_sync";
    this.op = kind === "name" ? "set-display-name" : "set-description";
    db.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (id TEXT PRIMARY KEY, json TEXT NOT NULL)`);
  }

  get(id: string): NameSync | undefined {
    const r = this.db.query(`SELECT json FROM ${this.table} WHERE id = ?`).get(id) as { json: string } | null;
    return r ? (JSON.parse(r.json) as NameSync) : undefined;
  }

  private put(id: string, v: NameSync) {
    this.db.query(`INSERT INTO ${this.table} (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`).run(id, JSON.stringify(v));
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
    const arg: { name?: string; description?: string; expect?: string } = force ? {} : { expect: prev?.synced ?? "" };
    if (this.kind === "name") arg.name = name;
    else arg.description = name;
    try {
      const out = JSON.parse(await this.call(this.op, id, JSON.stringify(arg))) as { ok?: boolean; conflict?: boolean; current?: string; unsupported?: boolean };
      if (out.unsupported) return this.put(id, { state: "failed", synced: prev?.synced, error: "この Hermes には説明を書く機能が見つからない（何も書いていない）", at });
      if (out.ok) return this.put(id, { state: "synced", synced: out.current ?? name, at });
      if (out.conflict) return this.put(id, { state: "conflict", synced: prev?.synced, current: out.current ?? "", at });
      return this.put(id, { state: "failed", synced: prev?.synced, error: "Hermes の返事が読めない", at });
    } catch (e) {
      return this.put(id, { state: "failed", synced: prev?.synced, error: (e instanceof Error ? e.message : String(e)).slice(0, 300), at });
    }
  }
}
