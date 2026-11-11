// エージェントの一覧（v2.0 H3）。設定（PLASMOD_PROFILES）に無くても、Hermes のプロファイルから自動で見つける。
// 名前・色・顔・隠すは、アプリの設定画面で変えられる（データベースに保存）。
import type { Database } from "bun:sqlite";
import { type AgentProfile, CLAUDE_AGENT } from "../shared/types";

export interface ProfileOverride {
  id: string;
  name?: string;
  color?: string;
  avatar?: string | null;
  hidden?: boolean;
  /** チームの id */
  team?: string;
  /** 空にすると役割なし */
  role?: string;
}

export type ManagedProfile = AgentProfile & { hidden?: boolean };

const COLORS = ["#8FB8FF", "#E8A27C", "#7FD8C6", "#F2C98A", "#C7A6F2", "#F29CB7", "#9BD57F"];

/** 見つけたプロファイルの見た目。同じ id なら毎回同じ色 */
export function generatedProfile(id: string): AgentProfile {
  const n = [...id].reduce((a, c) => a + c.codePointAt(0)!, 0);
  const name = id === "default" ? "アシスタント" : id;
  return { id, name, initial: [...name][0]?.toUpperCase() ?? "?", color: COLORS[n % COLORS.length] };
}

export function mergeProfiles(base: AgentProfile[], discovered: string[], overrides: ProfileOverride[], hasDev: boolean): ManagedProfile[] {
  // bridge が無ければ Claude Code の dev は出さない。そのとき Hermes に dev があれば、Hermes のエージェントとして見つける（#28）
  const kept = base.filter((p) => p.id !== CLAUDE_AGENT || hasDev);
  const seen = new Set(kept.map((p) => p.id));
  const all: AgentProfile[] = [...kept, ...discovered.filter((id) => !seen.has(id)).map(generatedProfile)];
  const by = new Map(overrides.map((o) => [o.id, o]));
  return all
    .map((p) => {
      const o = by.get(p.id);
      if (!o) return p;
      const name = o.name?.trim() || p.name;
      const merged: ManagedProfile = { ...p, name, initial: o.name?.trim() ? ([...name][0] ?? "?") : p.initial, color: o.color ?? p.color, hidden: !!o.hidden };
      if (o.avatar !== undefined) merged.avatar = o.avatar ?? undefined;
      if (o.team !== undefined) merged.team = o.team;
      if (o.role !== undefined) merged.role = o.role || undefined;
      return merged;
    });
}

export interface RefreshResult {
  /** 今回あらたに見つかったエージェントの id */
  added: string[];
}

export class ProfileRegistry {
  private discovered: string[] = [];
  private base: AgentProfile[];

  /** target は config.profiles。画面や通知が同じ配列を見ているので、中身を入れ替える */
  constructor(
    private db: Database,
    private target: AgentProfile[],
    private hasDev: () => boolean,
  ) {
    this.base = [...target];
    db.exec("CREATE TABLE IF NOT EXISTS agent_overrides (id TEXT PRIMARY KEY, json TEXT NOT NULL)");
    this.apply();
  }

  private overrides(): ProfileOverride[] {
    const rows = this.db.query("SELECT id, json FROM agent_overrides").all() as { id: string; json: string }[];
    return rows.map((r) => ({ ...(JSON.parse(r.json) as object), id: r.id }));
  }

  /** 設定画面用: 隠したものも含む */
  all(): ManagedProfile[] {
    return mergeProfiles(this.base, this.discovered, this.overrides(), this.hasDev());
  }

  apply() {
    this.target.splice(0, this.target.length, ...this.all().filter((p) => !p.hidden));
  }

  private refresher: (() => Promise<void>) | null = null;
  private inflight: Promise<RefreshResult> | null = null;

  setRefresher(fn: () => Promise<void>) {
    this.refresher = fn;
  }

  /** Hermes のプロファイルを読み直す。同時に走るのは1回だけ（重なった呼び出しは同じ結果を待つ）。失敗したら例外で、一覧は変わらない */
  refresh(): Promise<RefreshResult> {
    if (!this.refresher) return Promise.reject(new Error("Hermes の仲介につながっていない"));
    const fn = this.refresher;
    this.inflight ??= (async () => {
      const before = new Set(this.all().map((p) => p.id));
      await fn();
      return { added: this.all().filter((p) => !before.has(p.id)).map((p) => p.id) };
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  setDiscovered(ids: string[]) {
    this.discovered = ids;
    this.apply();
  }

  setOverride(id: string, patch: Omit<ProfileOverride, "id">) {
    if (!this.all().some((p) => p.id === id)) throw new Error("このエージェントは無い");
    const cur = this.overrides().find((o) => o.id === id) ?? { id };
    const next = { ...cur, ...patch };
    this.db.query("INSERT INTO agent_overrides (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(id, JSON.stringify(next));
    this.apply();
  }
}

/** アプリの設定（持ち主の呼び名など）。無ければ env の値を使う */
export class AppSettings {
  constructor(private db: Database) {
    db.exec("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  get(key: string): string | null {
    return (this.db.query("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
  }

  set(key: string, value: string) {
    this.db.query("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
