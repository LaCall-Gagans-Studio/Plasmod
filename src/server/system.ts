// システム（TASK-165・166）: 使用量・モデルの切り替え・VPS のファイル閲覧。
// 開発エージェント側（cc）は plasmod-bridge、Hermes 側（hermes）は仲介を通す。どちらも鍵・.env などは向こう側で拒否する。
import type { AgentInfo, CronJob, FsList, FsRead, ModelEntry, NousCredits, Schedules, TimerInfo, UsageSnapshot, VpsStatus } from "../shared/types";
import { CLAUDE_AGENT } from "../shared/types";
import type { BridgeClient } from "./bridge";
import { type HostReader, readVps, realHost } from "./vps";
import { SERIES_EVERY_MS, VpsSeries } from "./vps-series";
import type { RawClaude, RawConnections, RawHermes } from "./connections";

export type BrokerCall = (...args: string[]) => Promise<string>;

/** systemctl を読み取りだけで呼ぶ（list-timers・show）。テストでは差し替える */
export type SystemctlCall = (...args: string[]) => Promise<string>;

const systemctl: SystemctlCall = async (...args) => {
  const p = Bun.spawn(["systemctl", "--no-pager", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(err.trim().slice(-300) || `systemctl ${args[0]} failed (${code})`);
  return out;
};

/** OS 標準のタイマー。画面では畳んでおく */
const OS_TIMER = /^(apt-|dpkg-|man-db|logrotate|e2scrub|fstrim|motd-news|update-notifier|ua-timer|systemd-|sysstat-|snapd|fwupd|phpsessionclean|certbot)/;

/** systemctl show の出力（空行区切りの Key=Value の塊）を読む */
function parseShow(text: string): Record<string, string>[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      // TimersMonotonic などは同じ名前の行が複数出るので、つないでおく
      const o: Record<string, string> = {};
      for (const l of block.split("\n")) {
        const i = l.indexOf("=");
        if (i <= 0) continue;
        const k = l.slice(0, i);
        o[k] = o[k] ? `${o[k]} ${l.slice(i + 1)}` : l.slice(i + 1);
      }
      return o;
    })
    .filter((o) => o.Id);
}

/** TimersCalendar={ OnCalendar=*-*-* 03:00:00 ; next_elapse=... } から OnCalendar=... の所だけ */
function timerSchedule(o: Record<string, string>): string {
  const parts = [o.TimersCalendar, o.TimersMonotonic]
    .flatMap((v) => (v ?? "").match(/\{\s*([^;}]+)/g) ?? [])
    .map((m) => m.replace(/^\{\s*/, "").replace(/USec=/, "Sec=").trim())
    .filter(Boolean);
  return parts.join(" / ");
}

const usec = (v: unknown) => (typeof v === "number" && v > 0 ? Math.round(v / 1000) : null);

export interface PlanCost {
  name: string;
  usd: number;
}

export class SystemService {
  private usageCache: { at: number; value: UsageSnapshot } | null = null;
  private creditsCache: { at: number; value: NousCredits } | null = null;

  constructor(
    private bridge: BridgeClient | null,
    private broker: BrokerCall | null,
    private plans: PlanCost[],
    private names: (id: string) => string,
    private systemctlCall: SystemctlCall | null = systemctl,
    private host: HostReader = realHost,
  ) {}

  private series: VpsSeries | null = null;
  /** Claude Code の bridge を入れているか。入れていなければ dev は Hermes のプロファイルとして扱う（#28） */
  claudeEnabled: () => boolean = () => true;

  /** グラフ用の記録を始める（本番の起動時に1回）。メモリに持つだけ */
  startSeries() {
    if (this.series) return;
    this.series = new VpsSeries(this.host);
    this.series.sample();
    setInterval(() => this.series?.sample(), SERIES_EVERY_MS).unref?.();
  }

  vpsSeries() {
    return this.series?.all() ?? [];
  }

  /** 設定の「VPS」。読むだけ */
  vps(): Promise<VpsStatus> {
    return readVps(this.host, this.systemctlCall);
  }

  async usage(force = false): Promise<UsageSnapshot> {
    if (!force && this.usageCache && Date.now() - this.usageCache.at < 60_000) return this.usageCache.value;
    const [claude, hermes] = await Promise.all([
      this.bridge
        ? this.bridge.request({ type: "usage" }).then((r) => r.usage as UsageSnapshot["claude"], (e) => ({ error: String(e.message ?? e) }))
        : Promise.resolve({ error: "plasmod-bridge が設定されていない" }),
      this.broker
        ? this.broker("usage").then((s) => JSON.parse(s) as UsageSnapshot["hermes"], (e) => ({ _error: { error: String(e.message ?? e) } }))
        : Promise.resolve({}),
    ]);
    const value: UsageSnapshot = { claude, hermes, plans: this.plans, monthlyUsd: this.plans.reduce((a, p) => a + p.usd, 0), at: Date.now() };
    this.usageCache = { at: Date.now(), value };
    return value;
  }

  /** Nous のクレジット。仲介が Hermes の中でアカウントの情報を読む（Nous に問い合わせるので5分はキャッシュ） */
  /** 接続の状況の元（読むだけ）。片方が取れなくても、もう片方は返す */
  async connectionsRaw(): Promise<RawConnections> {
    const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
    const [hermes, claude] = await Promise.all([
      this.broker
        ? this.broker("connections").then((s) => JSON.parse(s) as RawHermes, (e) => ({ error: msg(e) }))
        : Promise.resolve({ error: "仲介が設定されていない" }),
      this.bridge
        ? this.bridge.request({ type: "auth_status" }).then((r) => r.claude as RawClaude, (e) => ({ error: msg(e) }))
        : Promise.resolve({ available: false } as RawClaude),
    ]);
    return { hermes, claude };
  }

  async credits(force = false): Promise<NousCredits> {
    if (!force && this.creditsCache && Date.now() - this.creditsCache.at < 300_000) return this.creditsCache.value;
    const empty: NousCredits = { paidAccess: null, reason: null, plan: null, monthly: null, subscriptionRemaining: null, purchasedRemaining: null, totalRemaining: null, periodEnd: null, at: Date.now() };
    let value: NousCredits;
    if (!this.broker) value = { ...empty, error: "仲介が設定されていない" };
    else {
      try {
        const r = JSON.parse(await this.broker("credits")) as Record<string, unknown>;
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
        const str = (v: unknown) => (typeof v === "string" && v ? v : null);
        value = {
          ...empty,
          paidAccess: typeof r.paid_access === "boolean" ? r.paid_access : null,
          reason: str(r.reason),
          plan: str(r.plan),
          monthly: num(r.monthly),
          subscriptionRemaining: num(r.subscription_remaining),
          purchasedRemaining: num(r.purchased_remaining),
          totalRemaining: num(r.total_remaining),
          periodEnd: str(r.period_end),
          ...(r.logged_in === false ? { error: "Hermes が Nous にログインしていない" } : str(r.error) ? { error: String(r.error) } : {}),
        };
      } catch (e) {
        value = { ...empty, error: e instanceof Error ? e.message : String(e) };
      }
    }
    // 取れなかったときは長く覚えない（1分で取り直す）
    this.creditsCache = { at: value.error ? Date.now() - 240_000 : Date.now(), value };
    return value;
  }

  async models(): Promise<ModelEntry[]> {
    const out: ModelEntry[] = [];
    const claude = !!this.bridge && this.claudeEnabled();
    if (this.bridge && claude) {
      try {
        const r = await this.bridge.request({ type: "get_models" });
        const cur = r.models as Record<string, string | null>;
        const choices = (r.choices as string[]) ?? [];
        const label = (m: string) => `claude · ${m}`;
        out.push(
          { key: "dev:chat", name: `${this.names(CLAUDE_AGENT)}（会話）`, current: label(cur.chat ?? "既定"), choices: choices.map((c) => ({ id: c, label: label(c), note: "Claude サブスク", current: c === cur.chat })) },
          { key: "dev:worker", name: `${this.names(CLAUDE_AGENT)}（カンバン）`, current: label(cur.worker ?? "sonnet"), choices: choices.map((c) => ({ id: c, label: label(c), note: c === "opus" ? "枠を多く使う" : "Claude サブスク", current: c === (cur.worker ?? "sonnet") })) },
        );
      } catch (e) {
        out.push({ key: "dev:chat", name: this.names(CLAUDE_AGENT), current: "?", choices: [], error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (this.broker) {
      try {
        const r = JSON.parse(await this.broker("models")) as Record<string, { current: { provider: string | null; model: string | null }; choices: { provider: string; model: string; label?: string; note?: string }[] }>;
        for (const [profile, v] of Object.entries(r)) {
          if (claude && profile === CLAUDE_AGENT) continue;
          out.push({
            key: `hermes:${profile}`,
            name: this.names(profile),
            current: v.current.model ? `${v.current.provider ?? "?"} · ${v.current.model}` : "?",
            choices: v.choices.map((c, i) => ({ id: String(i), label: c.label ?? `${c.provider} · ${c.model}`, note: c.note ?? "", current: c.model === v.current.model && (c.provider ?? null) === v.current.provider })),
          });
        }
      } catch (e) {
        out.push({ key: "hermes:?", name: "Hermes", current: "?", choices: [], error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  }

  /** エージェントごとの人格・スキル・設定ファイル。読むだけ */
  async agents(): Promise<AgentInfo[]> {
    const out: AgentInfo[] = [];
    const claude = !!this.bridge && this.claudeEnabled();
    if (this.bridge && claude) {
      const base: AgentInfo = { id: CLAUDE_AGENT, kind: "claude-code", model: "?", soul: null, files: [{ label: "CLAUDE.md", root: "work", path: "CLAUDE.md" }], skills: [] };
      try {
        const [m, f] = await Promise.all([this.bridge.request({ type: "get_models" }), this.bridge.request({ type: "fs_read", path: "CLAUDE.md" })]);
        const cur = m.models as Record<string, string | null>;
        out.push({ ...base, model: `claude · 会話 ${cur.chat ?? "既定"} / カンバン ${cur.worker ?? "sonnet"}`, soul: String((f as unknown as FsRead).text ?? "").slice(0, 16384) });
      } catch (e) {
        out.push({ ...base, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (this.broker) {
      try {
        const r = JSON.parse(await this.broker("agents")) as {
          id: string;
          model: { provider: string | null; model: string | null };
          soul: string | null;
          files: Record<string, string>;
          skills: { name: string; description: string; category: string; path: string }[];
        }[];
        const LABEL: Record<string, string> = { soul: "SOUL.md（人格）", config: "config.yaml（設定）", memory: "MEMORY.md（記憶）", user: "USER.md（オーナーについて）" };
        for (const a of r) {
          // Claude Code と同じ id の Hermes プロファイルは、Claude Code を入れているときは出さない（id で結び付けるので取り違える）
          if (claude && a.id === CLAUDE_AGENT) continue;
          out.push({
            id: a.id,
            kind: "hermes",
            model: a.model.model ? `${a.model.provider ?? "?"} · ${a.model.model}` : "?",
            soul: a.soul,
            files: Object.entries(a.files).map(([k, path]) => ({ label: LABEL[k] ?? k, root: "hermes" as const, path })),
            skills: a.skills.map((x) => ({ ...x, root: "hermes" as const })),
          });
        }
      } catch (e) {
        out.push({ id: "hermes", kind: "hermes", model: "?", soul: null, files: [], skills: [], error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  }

  /** 定期実行: Hermes の cron（仲介）と VPS の systemd タイマー。どちらも読むだけ */
  async schedules(): Promise<Schedules> {
    const errors: Schedules["errors"] = [];
    const [hermes, timers] = await Promise.all([
      (async (): Promise<CronJob[]> => {
        if (!this.broker) return [];
        try {
          const r = JSON.parse(await this.broker("cron")) as Record<string, Omit<CronJob, "profile">[] | { error: string }>;
          const out: CronJob[] = [];
          for (const [profile, v] of Object.entries(r)) {
            if (Array.isArray(v)) out.push(...v.map((j) => ({ ...j, profile })));
            else errors.push({ source: this.names(profile), error: v.error });
          }
          return out;
        } catch (e) {
          errors.push({ source: "Hermes", error: e instanceof Error ? e.message : String(e) });
          return [];
        }
      })(),
      (async (): Promise<TimerInfo[]> => {
        if (!this.systemctlCall) return [];
        try {
          const list = JSON.parse(await this.systemctlCall("list-timers", "--all", "--output=json")) as { unit: string; activates: string | null; next: number | null; last: number | null }[];
          if (!list.length) return [];
          const units = list.map((t) => t.unit);
          const services = list.map((t) => t.activates).filter((u): u is string => !!u);
          const [tShow, sShow] = await Promise.all([
            this.systemctlCall("show", "-p", "Id,Description,TimersCalendar,TimersMonotonic", "--", ...units).then(parseShow),
            services.length ? this.systemctlCall("show", "-p", "Id,Description,Result", "--", ...services).then(parseShow) : Promise.resolve([]),
          ]);
          const byId = (rows: Record<string, string>[]) => new Map(rows.map((r) => [r.Id, r]));
          const ti = byId(tShow);
          const si = byId(sShow);
          return list.map((t) => {
            const tm = ti.get(t.unit) ?? {};
            const sv = (t.activates && si.get(t.activates)) || {};
            return {
              unit: t.unit,
              activates: t.activates ?? "",
              description: sv.Description || tm.Description || "",
              schedule: timerSchedule(tm),
              next: usec(t.next),
              last: usec(t.last),
              result: sv.Result || null,
              os: OS_TIMER.test(t.unit),
            };
          });
        } catch (e) {
          errors.push({ source: "systemd", error: e instanceof Error ? e.message : String(e) });
          return [];
        }
      })(),
    ]);
    return { hermes, timers, errors, at: Date.now() };
  }

  /** モデルの許可リスト（仲介の models の choices をそのまま）。プロファイルの一覧も返す */
  async modelAllowlist(): Promise<{ models: Record<string, { provider: string; model: string; label?: string; note?: string }[]>; current: Record<string, { provider: string | null; model: string | null }>; error?: string }> {
    if (!this.broker) return { models: {}, current: {}, error: "仲介が設定されていない" };
    try {
      const r = JSON.parse(await this.broker("models")) as Record<string, { current: { provider: string | null; model: string | null }; choices: { provider: string; model: string; label?: string; note?: string }[] }>;
      const models: Record<string, { provider: string; model: string; label?: string; note?: string }[]> = {};
      const current: Record<string, { provider: string | null; model: string | null }> = {};
      for (const [k, v] of Object.entries(r)) {
        models[k] = v.choices ?? [];
        current[k] = v.current;
      }
      return { models, current };
    } catch (e) {
      return { models: {}, current: {}, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** key は models() の key、choice は choices の id */
  async setModel(key: string, choice: string): Promise<void> {
    const [kind, target] = key.split(":");
    if (kind === "dev" && (target === "chat" || target === "worker")) {
      if (!this.bridge) throw new Error("plasmod-bridge が設定されていない");
      await this.bridge.request({ type: "set_model", target, model: choice });
      return;
    }
    if (kind === "hermes" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(target ?? "") && /^\d{1,3}$/.test(choice)) {
      if (!this.broker) throw new Error("仲介が設定されていない");
      await this.broker("set-model", target, choice);
      return;
    }
    throw new Error("切り替えられないモデル");
  }

  async fsList(root: string, path: string): Promise<FsList> {
    if (root === "work") {
      if (!this.bridge) throw new Error("plasmod-bridge が設定されていない");
      return (await this.bridge.request({ type: "fs_list", path })) as unknown as FsList;
    }
    if (root === "hermes") {
      if (!this.broker) throw new Error("仲介が設定されていない");
      return JSON.parse(await this.broker("fs-list", path)) as FsList;
    }
    throw new Error("知らない場所");
  }

  async fsRead(root: string, path: string): Promise<FsRead> {
    if (root === "work") {
      if (!this.bridge) throw new Error("plasmod-bridge が設定されていない");
      return (await this.bridge.request({ type: "fs_read", path })) as unknown as FsRead;
    }
    if (root === "hermes") {
      if (!this.broker) throw new Error("仲介が設定されていない");
      return JSON.parse(await this.broker("fs-read", path)) as FsRead;
    }
    throw new Error("知らない場所");
  }
}

export function parsePlans(raw: string): PlanCost[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter((p) => p && typeof p.name === "string" && typeof p.usd === "number") : [];
  } catch {
    return [];
  }
}
