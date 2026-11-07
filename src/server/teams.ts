// チーム。エージェントをまとめる単位で、チャットの切り替え・レポートの出し方・任せ先を決める。
// 実働と監察は最初から入っている例で、名前も中身も変えられる。
import type { Database } from "bun:sqlite";
import { DEFAULT_TEAM, DEFAULT_TEAMS, type Team } from "../shared/types";

const COLOR = /^#[0-9a-fA-F]{6}$/;

export class TeamError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

export class TeamStore {
  /** target は config.teams。画面や判定が同じ配列を見ているので、中身を入れ替える */
  constructor(
    private db: Database,
    private target: Team[],
  ) {
    db.exec("CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, json TEXT NOT NULL, position INTEGER NOT NULL)");
    if (!(db.query("SELECT 1 FROM teams LIMIT 1").get() as unknown)) {
      DEFAULT_TEAMS.forEach((t, i) => this.write(t, i));
    }
    this.apply();
  }

  private write(t: Team, position: number) {
    this.db.query("INSERT INTO teams (id, json, position) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(t.id, JSON.stringify(t), position);
  }

  all(): Team[] {
    return (this.db.query("SELECT json FROM teams ORDER BY position, id").all() as { json: string }[]).map((r) => JSON.parse(r.json) as Team);
  }

  private apply() {
    this.target.splice(0, this.target.length, ...this.all());
  }

  private clean(cur: Team, patch: Record<string, unknown>): Team {
    const next = { ...cur };
    if (patch.name !== undefined) {
      const name = typeof patch.name === "string" ? patch.name.trim().slice(0, 30) : "";
      if (!name) throw new TeamError("名前を入れてください");
      next.name = name;
    }
    if (patch.color !== undefined) {
      if (typeof patch.color !== "string" || !COLOR.test(patch.color)) throw new TeamError("色が不正");
      next.color = patch.color;
    }
    if (patch.cadence !== undefined) {
      if (patch.cadence !== "daily" && patch.cadence !== "weekly") throw new TeamError("報告の間隔が不正");
      next.cadence = patch.cadence;
    }
    if (patch.delegable !== undefined) next.delegable = patch.delegable === true;
    if (patch.viaHub !== undefined) next.viaHub = patch.viaHub === true;
    return next;
  }

  create(input: Record<string, unknown>): Team {
    const ids = this.all().map((t) => t.id);
    let n = ids.length;
    while (ids.includes(`team${n}`)) n++;
    const t = this.clean({ id: `team${n}`, name: "", color: "#7FD8C6", cadence: "daily", delegable: true, viaHub: true }, { name: "", ...input });
    const last = this.db.query("SELECT MAX(position) AS p FROM teams").get() as { p: number | null };
    this.write(t, (last.p ?? 0) + 1);
    this.apply();
    return t;
  }

  update(id: string, patch: Record<string, unknown>): Team {
    const cur = this.all().find((t) => t.id === id);
    if (!cur) throw new TeamError("そのチームはありません", 404);
    const t = this.clean(cur, patch);
    this.db.query("UPDATE teams SET json = ? WHERE id = ?").run(JSON.stringify(t), id);
    this.apply();
    return t;
  }

  /** 消す。メンバーは呼ぶ側で既定のチームへ移す */
  remove(id: string) {
    if (id === DEFAULT_TEAM) throw new TeamError("最初のチームは消せません");
    if (!this.all().some((t) => t.id === id)) throw new TeamError("そのチームはありません", 404);
    this.db.query("DELETE FROM teams WHERE id = ?").run(id);
    this.apply();
  }
}
