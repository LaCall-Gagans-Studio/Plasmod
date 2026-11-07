import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { config } from "../src/server/config";
import { Hub } from "../src/server/hub";
import { FixtureSource } from "../src/server/kanban";
import { triageOptions } from "../src/server/model";
import { Notifier } from "../src/server/notify";
import { ProfileRegistry } from "../src/server/profiles";
import { Store } from "../src/server/store";
import { TeamError, TeamStore } from "../src/server/teams";
import { DEFAULT_TEAMS, type AgentProfile, type KanbanTask, type Team, teamOfProfile } from "../src/shared/types";

const store = () => {
  const target: Team[] = [];
  return { target, s: new TeamStore(new Database(":memory:"), target) };
};

describe("チーム", () => {
  test("最初は実働と監察が入っていて、変えた内容は残る", () => {
    const db = new Database(":memory:");
    const target: Team[] = [];
    const s = new TeamStore(db, target);
    expect(target.map((t) => t.id)).toEqual(["work", "watch"]);
    s.update("watch", { name: "見張り" });
    const again: Team[] = [];
    new TeamStore(db, again);
    expect(again.find((t) => t.id === "watch")?.name).toBe("見張り");
  });

  test("足す・変える・消す。最初のチームは消せない。変な値は断る", () => {
    const { s, target } = store();
    const t = s.create({ name: " 営業 " });
    expect(t).toMatchObject({ name: "営業", delegable: true });
    expect(target.at(-1)?.id).toBe(t.id);
    expect(() => s.create({ name: "" })).toThrow(TeamError);
    expect(() => s.update(t.id, { color: "red" })).toThrow(TeamError);
    expect(() => s.remove("work")).toThrow(TeamError);
    expect(() => s.remove("nothing")).toThrow(TeamError);
    s.remove(t.id);
    expect(target.map((x) => x.id)).toEqual(["work", "watch"]);
  });

  test("無くなったチームのエージェントは、最初のチームとして扱う", () => {
    expect(teamOfProfile({ team: "gone" }, DEFAULT_TEAMS).id).toBe("work");
    expect(teamOfProfile(undefined, DEFAULT_TEAMS).id).toBe("work");
    expect(teamOfProfile({ team: "watch" }, DEFAULT_TEAMS).id).toBe("watch");
  });

  test("任せ先は delegable のチームだけ", () => {
    const ps: AgentProfile[] = [
      { id: "a", name: "A", initial: "A", color: "#000000" },
      { id: "b", name: "B", initial: "B", color: "#000000", team: "watch" },
    ];
    const ids = triageOptions({ id: "t", title: "x", status: "triage" } as KanbanTask, ps).map((o) => o.id);
    expect(ids).toContain("to-a");
    expect(ids).not.toContain("to-b");
  });

  test("3つ目のチームを API で作って割り当てられる。消せる", async () => {
    const st = new Store(":memory:");
    const teams: Team[] = [];
    const profiles: AgentProfile[] = [{ id: "sales", name: "営業くん", initial: "営", color: "#000000" }];
    const cfg = { ...config, devNoAuth: true, teams, profiles };
    const hub = new Hub(cfg, new FixtureSource(config.fixturePath), st, null, new Notifier(cfg, st));
    await hub.refresh();
    const registry = new ProfileRegistry(st.db, profiles, () => false);
    const app = createApp(cfg, hub, st, ".", { teams: new TeamStore(st.db, teams), registry });
    const json = (body: unknown) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const made = (await (await app.request("/api/teams", { method: "POST", ...json({ name: "営業" }) })).json()) as { teams: Team[] };
    const id = made.teams.at(-1)!.id;
    registry.setOverride("sales", { team: id });
    expect((await app.request(`/api/teams/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(teams.some((t) => t.id === id)).toBe(false);
  });
});
