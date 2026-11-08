// 設定: 一般（表示・呼び名・このアプリ） / エージェント（名前と顔・モデル・スキル・定期実行） / 使用量 / VPS（状態・root 作業・ファイル）
import { useEffect, useState } from "react";
import type { AgentInfo, FsList, FsRead, ModelEntry, NousCredits, PerfName, PerfRow, Snapshot, UsageSnapshot, VpsService, VpsStatus } from "../shared/types";
import { OrchestrationGraph } from "./graph";
import { type ManagedAgent, useAgentSettings, PlayerCard, ProfileEditor, TeamsEditor } from "./AgentSquad";
import { Connections } from "./Connections";
import { RichText } from "./markdown";
import { Schedules } from "./Schedules";
import { creditsUsed } from "./session-data";
import { type ThemePref, useTheme } from "./theme";
import { Avatar, COL, Page, ago, profileOf } from "./ui";
import { claudeName, getAbout } from "./identity";
import { DEFAULT_TEAMS, RUNTIME_CAPS, teamOfProfile } from "../shared/types";
import { toast } from "./touch";
import { lang, setLang, t, t as tr } from "./i18n";
import { fetchRetry } from "./api";
import { PushSection } from "./webpush";
import { RELEASE_NOTES, versionName } from "../shared/release-notes";
import { ProfileCard } from "./ProfileCard";
import { VpsChart } from "./VpsChart";
import { Allowlists } from "./Allowlists";

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`;

/** メーターの色（塗り）を、白の上で読める文字の色にする */
const TEXT_ON_WHITE: Record<string, string> = { "#C8F25A": "var(--color-lime-ink)", "#FF8A3D": "var(--color-orange-ink)", "#8FB8FF": "var(--color-blue)" };

function Meter({ title, sub, value, ratio, note, color }: { title: string; sub: string; value: string; ratio: number | null; note: string; color: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="font-bold">{title}</span>
        <span className="text-[11px] text-mute">{sub}</span>
        <span className="ml-auto font-mono text-[11px]" style={{ color: TEXT_ON_WHITE[color] ?? color }}>{value}</span>
      </div>
      {ratio !== null && (
        <div className="h-2 rounded bg-line">
          <div className="h-2 rounded" style={{ width: `${Math.min(100, Math.max(2, ratio * 100))}%`, background: color }} />
        </div>
      )}
      <div className="text-[11px] text-mute">{note}</div>
    </div>
  );
}

type Gauge = { label: string; value: string; ratio: number | null; note: string };

/** 1人ぶんの使用量: トークンと金額を同じ箱に、バーを2本続けて積む */
function UsageBox({ title, sub, color, rows }: { title: string; sub: string; color: string; rows: Gauge[] }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-panel p-3">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="font-bold">{title}</span>
        <span className="min-w-0 truncate text-[11px] text-mute">{sub}</span>
      </div>
      {rows.map((r) => (
        <div key={r.label} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2 text-[11.5px]">
            <span className="text-ink-2">{r.label}</span>
            <span className="ml-auto font-mono text-[11px]" style={{ color: TEXT_ON_WHITE[color] ?? color }}>{r.value}</span>
          </div>
          <div className="h-2 rounded bg-line">
            {r.ratio !== null && <div className="h-2 rounded" style={{ width: `${Math.min(100, Math.max(2, r.ratio * 100))}%`, background: color }} />}
          </div>
          <div className="text-[11px] text-mute">{r.note}</div>
        </div>
      ))}
    </div>
  );
}

/** Nous のクレジット（Hermes のエージェント全員で同じアカウント） */
function CreditsMeter({ c }: { c: NousCredits }) {
  const u = creditsUsed(c);
  const left = [c.purchasedRemaining ? `買い足し分の残り $${c.purchasedRemaining.toFixed(2)}` : "", c.periodEnd ? `枠の更新 ${c.periodEnd.slice(0, 10)}` : ""].filter(Boolean).join(" · ");
  if (c.error && !u) return <Meter title="Nous" sub="Hermes のクレジット" value="?" ratio={null} note={c.error} color="#FF8A3D" />;
  return (
    <Meter
      title="Nous"
      sub={`Hermes のクレジット${c.plan ? ` · ${c.plan}` : ""}`}
      value={u ? `$${u.used.toFixed(2)} / $${u.cap.toFixed(2)}` : c.totalRemaining !== null ? `残り $${c.totalRemaining.toFixed(2)}` : "?"}
      ratio={u ? u.ratio : null}
      note={c.paidAccess === false ? `✕ クレジット切れ。有料モデルは止まっている${c.reason ? `（${c.reason}）` : ""}` : left || "月の枠に対して使った額"}
      color={c.paidAccess === false || (u && u.ratio >= 0.75) ? "#FF8A3D" : "#8FB8FF"}
    />
  );
}

function Usage({ snap }: { snap: Snapshot | null }) {
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [credits, setCredits] = useState<NousCredits | null>(null);

  useEffect(() => {
    fetch("/api/system/usage").then((r) => r.json()).then(setUsage).catch(() => {});
    fetch("/api/system/credits").then((r) => r.json()).then(setCredits).catch(() => {});
  }, []);

  const claude = usage && !("error" in usage.claude) ? usage.claude : null;
  return (
    <div className="flex flex-col gap-4 px-4 pb-4 pt-2.5">
      {usage && usage.monthlyUsd > 0 && (
        <div className="flex items-baseline justify-between">
          <div className="text-xs text-mute">月額（{usage.plans.map((p) => p.name).join(" + ")}）</div>
          <div className="text-[26px] font-bold">${usage.monthlyUsd}<span className="text-[13px] font-medium text-mute"> / 月</span></div>
        </div>
      )}
      <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:items-start">
        {!usage && <div className="text-sm text-mute">使用量を読み込み中…</div>}
        {usage && (
          claude ? (
            <UsageBox
              title="Claude"
              sub={`${claudeName()} · 直近5時間`}
              color="#C8F25A"
              rows={[
                {
                  label: "トークン",
                  value: fmt(sum(claude.h5)),
                  ratio: sum(claude.d7) ? sum(claude.h5) / sum(claude.d7) : null,
                  note: `メッセージ ${claude.messages_h5} 件${claude.oldest_h5 ? ` · 5時間枠の始まりから ${ago(claude.oldest_h5 * 1000).replace("前", "")}` : ""} · 7日で ${fmt(sum(claude.d7))}`,
                },
                // サブスクなので請求はされない。API で使ったらいくらかの目安
                claude.cost_d7 !== undefined && claude.cost_h5 !== undefined
                  ? {
                      label: "金額（API 換算）",
                      value: usd(claude.cost_h5),
                      ratio: claude.cost_d7 ? claude.cost_h5 / claude.cost_d7 : null,
                      note: `7日で ${usd(claude.cost_d7)} · サブスクなので実際の請求は月額だけ${claude.unpriced?.length ? ` · 単価不明で入れていない: ${claude.unpriced.join(", ")}` : ""}`,
                    }
                  : { label: "金額（API 換算）", value: "—", ratio: null, note: "bridge の更新（app-usage-cost.patch）待ち" },
              ]}
            />
          ) : getAbout().claudeAgent === null ? null : (
            <Meter title="Claude" sub={claudeName()} value="?" ratio={null} note={"error" in usage.claude ? usage.claude.error : ""} color="#FF8A3D" />
          )
        )}
        {credits && <CreditsMeter c={credits} />}
        {usage &&
          Object.entries(usage.hermes).map(([id, h]) =>
            "error" in h ? (
              <Meter key={id} title={snap ? profileOf(snap.agents, id).name : id} sub="Hermes" value="?" ratio={null} note={h.error} color="#FF8A3D" />
            ) : (
              <UsageBox
                key={id}
                title={snap ? profileOf(snap.agents, id).name : id}
                sub={`Hermes · ${h.models[0]?.model ?? ""} · 30日`}
                color="#8FB8FF"
                rows={[
                  { label: "トークン", value: fmt(h.d30.tokens), ratio: h.d30.tokens ? h.d7.tokens / h.d30.tokens : null, note: `5時間 ${fmt(h.h5.tokens)} · 7日 ${fmt(h.d7.tokens)} · セッション ${h.d30.sessions}` },
                  // Hermes が記録した費用（実額があれば実額、無ければ見積もり）
                  { label: "金額", value: usd(h.d30.cost), ratio: h.d30.cost ? h.d7.cost / h.d30.cost : null, note: `5時間 ${usd(h.h5.cost)} · 7日 ${usd(h.d7.cost)}` },
                ]}
              />
            ),
          )}
        {usage && <div className="text-[11px] text-mute">バーは、Claude は7日のうち直近5時間、Hermes は30日のうち7日の分</div>}
      </div>

    </div>
  );
}

/** ファイルを1つ読んで出す（SKILL.md・config.yaml など）。.md は整形して出す */
function FileSheet({ root, path, onClose }: { root: "work" | "hermes"; path: string; onClose: () => void }) {
  const [file, setFile] = useState<FsRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/system/fs/${root}?read=1&path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
        setFile(b);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [root, path]);
  return (
    <div role="dialog" aria-label={path} className="fixed inset-0 z-40 flex flex-col bg-ground">
      <div className={`${COL} flex items-center gap-2 border-b border-line px-4 pb-2 pt-[max(env(safe-area-inset-top),14px)]`}>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
        <button onClick={onClose} className="rounded-md border border-line-2 px-2.5 py-1.5 text-xs">閉じる</button>
      </div>
      <div className={`${COL} flex-1 overflow-y-auto px-4 py-3`}>
        {error && <div className="rounded-xl bg-orange/10 px-3 py-2 text-xs text-orange-ink">{error}</div>}
        {!file && !error && <div className="text-sm text-mute">読み込み中…</div>}
        {file &&
          (file.binary ? (
            <div className="text-xs text-mute">バイナリなので表示しない</div>
          ) : /\.md$/i.test(path) ? (
            <div className="text-[13.5px] leading-7 text-ink-2"><RichText text={file.text} /></div>
          ) : (
            <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-2">{file.text}</pre>
          ))}
      </div>
    </div>
  );
}

/** エージェント: 役割・モデル（ここで変えられる）・人格・設定ファイル・スキル。モデルと中身は別々に読む（片方が遅くても待たない） */
function Agents({ snap }: { snap: Snapshot | null }) {
  const [list, setList] = useState<AgentInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [soulOpen, setSoulOpen] = useState<string | null>(null);
  const settings = useAgentSettings();
  const [sheet, setSheet] = useState<{ root: "work" | "hermes"; path: string } | null>(null);
  useEffect(() => {
    const get = async <T,>(url: string): Promise<T> => {
      const r = await fetchRetry(url);
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error((b as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
      return b as T;
    };
    get<AgentInfo[]>("/api/system/agents").then(setList).catch((e) => {
      setList([]);
      setListError(String(e instanceof Error ? e.message : e).startsWith("HTTP 50") ? "読み込めませんでした。開き直してください" : String(e instanceof Error ? e.message : e));
    });
    get<ModelEntry[]>("/api/system/models").then(setModels).catch(() => setModels([]));
  }, []);
  const modelsOf = (a: AgentInfo) => (models ?? []).filter((m) => (a.kind === "claude-code" ? m.key.startsWith("dev:") : m.key === `hermes:${a.id}`));
  const choose = async (m: ModelEntry, choice: string, label: string) => {
    setMsg(null);
    const r = await fetch("/api/system/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: m.key, choice }) });
    const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; models?: ModelEntry[] };
    if (b.ok && b.models) {
      setModels(b.models);
      setPicking(null);
      setMsg({ ok: true, text: `${m.name} を ${label} にした（次のセッション・次のカードから）` });
    } else setMsg({ ok: false, text: b.error ?? `HTTP ${r.status}` });
  };
  // 並びはプロファイルの順。隠しているエージェントも出す（編集は開いた中で）
  const fromList = (i: AgentInfo): ManagedAgent => (snap ? profileOf(snap.agents, i.id) : { id: i.id, name: i.id, initial: i.id.slice(0, 1).toUpperCase(), color: "#2f6fdb" });
  const squad: ManagedAgent[] = settings.agents ?? (list ?? []).map(fromList);
  const extra = (list ?? []).filter((i) => !squad.some((p) => p.id === i.id)).map(fromList);
  const players = [...squad, ...extra];
  return (
    <div className="flex flex-col gap-3 px-4 pb-4 pt-2.5 lg:grid lg:grid-cols-2 lg:items-start">
      {list === null && <div className="text-sm text-mute">読み込み中…</div>}
      {listError && <div className="rounded-xl bg-orange/10 px-3 py-2 text-xs text-orange-ink lg:col-span-2">{listError}</div>}
      {settings.error && <div className="rounded-xl bg-orange/10 px-3 py-2 text-xs text-orange-ink lg:col-span-2">{settings.error}</div>}
      {msg && <div className={`rounded-xl px-3 py-2 text-xs lg:col-span-2 ${msg.ok ? "bg-lime-soft text-lime-ink" : "bg-orange/10 text-orange-ink"}`}>{msg.text}</div>}
      {settings.teams.length > 0 && <TeamsEditor teams={settings.teams} agents={settings.agents ?? []} onChange={() => void settings.loadTeams()} />}
      {players.map((p, n) => {
        const a = (list ?? []).find((i) => i.id === p.id);
        const isOpen = open === p.id;
        const cats = a ? [...new Set(a.skills.map((s) => s.category))] : [];
        return (
          <div key={p.id} className={`overflow-hidden rounded-2xl border bg-panel ${isOpen ? "border-lime-line" : "border-line"}`}>
            <PlayerCard a={p} info={a} no={n + 1} open={isOpen} teamName={teamOfProfile(p, settings.teams.length ? settings.teams : DEFAULT_TEAMS).name} onToggle={() => setOpen(isOpen ? null : p.id)} />
            {a?.error && <div className="px-3 pt-2 text-[11px] text-orange-ink">{a.error}</div>}
            {isOpen && (
              <div className="flex flex-col gap-3 p-3">
                {settings.agents && <ProfileEditor a={p} patch={settings.patch} upload={settings.upload} teams={settings.teams} />}
                {a && <>
                {/* モデル（許可リストの中から変えられる） */}
                <div className="flex flex-col gap-1">
                  <div className="text-[11px] text-mute">モデル</div>
                  {models === null && <div className="text-[12px] text-mute">読み込み中…</div>}
                  {models !== null && modelsOf(a).length === 0 && <div className="text-[12px] text-mute">選べるモデルは無い（許可リストに無いプロファイル）</div>}
                  {modelsOf(a).map((m) => (
                    <div key={m.key} className="overflow-hidden rounded-lg border border-line-2">
                      <button onClick={() => setPicking(picking === m.key ? null : m.key)} disabled={!m.choices.length} className="flex min-h-10 w-full items-center gap-2 px-2.5 text-left text-[12.5px]">
                        <span className="text-ink-2">{m.name.includes("（") ? m.name.slice(m.name.indexOf("（")) : "いまのモデル"}</span>
                        <span className="ml-auto font-mono text-[11.5px]">{m.current}{m.choices.length ? " ▾" : ""}</span>
                      </button>
                      {m.error && <div className="px-2.5 pb-2 text-[11px] text-orange-ink">{m.error}</div>}
                      {picking === m.key && (
                        <div className="flex flex-col gap-0.5 border-t border-line p-1">
                          {m.choices.map((c) => (
                            <button key={c.id} onClick={() => void choose(m, c.id, c.label)} className="flex min-h-9 items-center gap-2 rounded-md px-2 text-left text-[12px] hover:bg-line">
                              <span className="font-mono">{c.label}</span>
                              <span className="ml-auto text-[11px] text-mute">{c.note}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {a.soul && (
                  <div className="flex flex-col gap-1">
                    <div className="text-[11px] text-mute">{RUNTIME_CAPS[a.kind].soulFile}</div>
                    <div className={`relative overflow-hidden text-[12.5px] leading-6 text-ink-2 ${soulOpen === a.id ? "" : "max-h-40"}`}>
                      <RichText text={a.soul} />
                      {soulOpen !== a.id && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-panel" />}
                    </div>
                    <button onClick={() => setSoulOpen(soulOpen === a.id ? null : a.id)} className="self-start text-[11px] text-blue">{soulOpen === a.id ? "たたむ" : "全部見る"}</button>
                  </div>
                )}
                {a.files.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {a.files.map((f) => (
                      <button key={f.path} onClick={() => setSheet(f)} className="min-h-8 rounded-lg border border-line-2 px-2.5 font-mono text-[11px] text-ink-2">{f.label}</button>
                    ))}
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <div className="text-[11px] text-mute">スキル</div>
                  {a.skills.length === 0 && <div className="text-[12px] text-mute">{a.kind === "claude-code" ? "Claude Code のスキルは ~/work の外にあるので、ここには出ない" : "スキルは無い"}</div>}
                  {cats.map((cat) => (
                    <div key={cat} className="flex flex-col">
                      {cat && <div className="pt-1.5 font-mono text-[10.5px] text-mute">{cat}/</div>}
                      {a.skills.filter((s) => s.category === cat).map((s) => (
                        <button key={s.path} onClick={() => setSheet(s)} className="flex min-h-10 flex-col items-start justify-center border-b border-line py-1.5 text-left last:border-b-0">
                          <span className="font-mono text-[12.5px] font-semibold">{s.name}</span>
                          {s.description && <span className="text-[11.5px] leading-snug text-mute">{s.description}</span>}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
                </>}
              </div>
            )}
          </div>
        );
      })}
      <p className="text-[11px] text-mute lg:col-span-2">カードを開くと、顔・名前・役割・色を変えられる。モデルは許可リストの中からだけ選べる。人格・スキル・設定ファイルは読むだけ（変えるときはエージェントに頼む）。</p>
      {sheet && <FileSheet root={sheet.root} path={sheet.path} onClose={() => setSheet(null)} />}
    </div>
  );
}

const ROOTS = [
  { id: "work", label: "~/work" },
  { id: "hermes", label: "~/.hermes" },
] as const;

function Files() {
  const [root, setRoot] = useState<(typeof ROOTS)[number]["id"]>("work");
  const [path, setPath] = useState("");
  const [list, setList] = useState<FsList | null>(null);
  const [file, setFile] = useState<FsRead | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setList(null);
    setError(null);
    fetch(`/api/system/fs/${root}?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
        setList(b);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [root, path]);

  const open = async (name: string) => {
    const p = path ? `${path}/${name}` : name;
    const r = await fetch(`/api/system/fs/${root}?read=1&path=${encodeURIComponent(p)}`);
    const b = await r.json();
    if (r.ok) setFile(b);
    else setError(b.error ?? `HTTP ${r.status}`);
  };

  const crumbs = path ? path.split("/") : [];
  return (
    <div className="flex flex-col gap-2.5 px-4 pb-4 pt-2.5">
      <div className="flex gap-1.5 font-mono text-[11.5px]">
        {ROOTS.map((r) => (
          <button key={r.id} onClick={() => (setRoot(r.id), setPath(""), setFile(null))} className={`min-h-[34px] rounded-lg border px-2.5 ${root === r.id ? "border-lime-line bg-lime-soft" : "border-line"}`}>{r.label}</button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1 font-mono text-xs text-mute">
        <button onClick={() => (setPath(""), setFile(null))} className="underline-offset-2 hover:underline">{ROOTS.find((r) => r.id === root)!.label}</button>
        {crumbs.map((c, i) => (
          <span key={i}>/ <button onClick={() => (setPath(crumbs.slice(0, i + 1).join("/")), setFile(null))} className="hover:underline">{c}</button></span>
        ))}
      </div>
      {error && <div className="rounded-xl bg-orange/10 px-3 py-2 text-xs text-orange-ink">{error}</div>}
      {file ? (
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-panel-2 p-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono font-semibold">{file.path.split("/").pop()}</span>
            <span className="text-[11px] text-mute">{fmt(file.size)}B{file.truncated ? "（先頭 256KB）" : ""}</span>
            <button onClick={() => setFile(null)} className="ml-auto rounded-md border border-line-2 px-2 py-1 text-[11px]">閉じる</button>
          </div>
          {file.binary ? <div className="text-xs text-mute">バイナリなので表示しない</div> : <pre className="m-0 max-h-[55vh] overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-2">{file.text}</pre>}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-panel-2 font-mono text-[12.5px]">
          {!list && !error && <div className="p-3 text-mute">読み込み中…</div>}
          {list?.items.length === 0 && <div className="p-3 text-mute">空のフォルダ</div>}
          {list?.items.map((it) => (
            <button
              key={it.name}
              disabled={it.locked}
              onClick={() => (it.dir ? (setPath(path ? `${path}/${it.name}` : it.name), setFile(null)) : void open(it.name))}
              className="flex min-h-10 w-full items-center gap-2.5 border-b border-line px-3 text-left disabled:cursor-not-allowed"
            >
              <span className={`w-4 ${it.locked ? "text-orange" : it.dir ? "text-lime-ink" : "text-mute"}`}>{it.locked ? "⊘" : it.dir ? "▸" : "·"}</span>
              <span className={`min-w-0 flex-1 truncate ${it.locked ? "text-mute" : it.dir ? "text-ink" : "text-ink-2"}`}>{it.name}{it.dir ? "/" : ""}</span>
              <span className="text-[11px] text-mute">{it.locked ? "中身は見せない" : it.dir ? ago(it.mtime * 1000) : `${fmt(it.size)}B`}</span>
            </button>
          ))}
        </div>
      )}
      <p className="text-[11px] text-mute">読み取りだけ。.env・鍵・トークン・DB・.git は、VPS 側（bridge・仲介）で拒否している。</p>
    </div>
  );
}

const bytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)}GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)}MB` : `${Math.round(n / 1024)}KB`);
const span = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  return m >= 1440 ? `${Math.floor(m / 1440)}日${Math.floor((m % 1440) / 60)}時間` : m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分`;
};

function serviceState(s: VpsService): { label: string; tone: "ok" | "idle" | "bad" } {
  if (s.active === "failed" || (s.oneshot && s.result && s.result !== "success")) return { label: s.active === "failed" ? "失敗" : `前回 ${s.result}`, tone: "bad" };
  if (s.active === "active") return { label: s.sub === "running" ? "動作中" : s.sub, tone: "ok" };
  if (s.active === "activating" || s.active === "reloading") return { label: s.oneshot ? "実行中" : "起動中", tone: "ok" };
  return s.oneshot ? { label: "待機（タイマー）", tone: "idle" } : { label: "停止", tone: "bad" };
}

const PERF_LABEL: Record<PerfName, string> = { startup: "起動", startup_entry: "起動: 入口の画面", startup_doc: "起動: 画面の取得", startup_script: "起動: スクリプト", startup_data: "起動: 最初のデータ", startup_retry: "起動: データの取り直し（回）", session_new: "新しいセッションの最初の返事", session_reply: "続きの返事" };
const sec = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}秒`;

/** 速さの基準値（直近30日）。v2.0 の改善の前後を比べる */
function PerfBox() {
  const [rows, setRows] = useState<PerfRow[] | null>(null);
  useEffect(() => {
    fetch("/api/perf").then((r) => r.json()).then(setRows).catch(() => setRows([]));
  }, []);
  if (!rows?.length) return null;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="border-b border-line px-3 py-2 text-[12px] font-bold">速さ（直近30日）</div>
      {rows.map((r) => (
        <div key={`${r.name}${r.via}`} className="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px] last:border-b-0">
          <span className="min-w-0 flex-1 truncate">{PERF_LABEL[r.name]}<span className="text-mute"> · {r.via === "apk" ? "APK" : "ブラウザ"}</span></span>
          <span className="flex-none font-mono text-[11px] text-ink-2">中央 {sec(r.p50)} / 遅い時 {sec(r.p90)} / {r.n}回</span>
        </div>
      ))}
    </div>
  );
}

/** VPS: 負荷・メモリ・ディスク・主なサービス。15秒ごとに読み直す（読むだけ） */
function Vps() {
  const [v, setV] = useState<VpsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/system/vps")
        .then(async (r) => {
          const b = await r.json();
          if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
          if (alive) (setV(b), setError(null));
        })
        .catch((e) => alive && setError(String(e.message ?? e)));
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!v) return <div className="px-4 pt-3 text-sm text-mute">{error ?? "VPS の状態を読み込み中…"}</div>;
  const bad = v.services.filter((s) => serviceState(s).tone === "bad");
  return (
    <div className="flex flex-col gap-3 px-4 pb-6 pt-2.5">
      <div className={`rounded-xl px-3.5 py-2.5 text-[13px] ${bad.length || v.failed.length ? "bg-orange/10 text-orange-ink" : "bg-lime-soft text-lime-ink"}`}>
        {bad.length || v.failed.length ? `⚠ 気にしたいもの ${new Set([...bad.map((s) => s.unit), ...v.failed]).size} 件` : "✓ 主なサービスはすべて正常"}
        <div className="mt-0.5 font-mono text-[11px] opacity-80">
          {v.hostname}
          {v.uptime !== null && ` · 起動から ${span(v.uptime)}`}
          {v.deployed && ` · 本番 ${v.deployed.slice(0, 7)}`}
        </div>
      </div>
      <VpsChart v={v} />
      <PerfBox />
      {v.failed.length > 0 && (
        <div className="rounded-xl border border-orange/40 bg-panel p-3 text-[12.5px]">
          <div className="mb-1 font-bold text-orange-ink">失敗しているユニット</div>
          <div className="flex flex-col gap-0.5 font-mono text-[11.5px]">{v.failed.map((u) => <span key={u}>{u}</span>)}</div>
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="border-b border-line px-3 py-2 text-[12px] font-bold">サービス</div>
        {v.services.map((s) => {
          const st = serviceState(s);
          return (
            <div key={s.unit} className="flex items-center gap-2.5 border-b border-line px-3 py-2 last:border-b-0">
              <span className={`size-2 flex-none rounded-full ${st.tone === "ok" ? "bg-lime" : st.tone === "bad" ? "bg-orange" : "bg-line-2"}`} aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-[12px]">{s.unit.replace(/\.service$/, "")}</span>
                {s.description && <span className="truncate text-[11px] text-mute">{s.description}</span>}
              </span>
              <span className="flex flex-none flex-col items-end text-[11px]">
                <span className={st.tone === "bad" ? "font-semibold text-orange-ink" : "text-ink-2"}>{st.label}</span>
                <span className="text-mute">
                  {[s.since && !s.oneshot ? ago(s.since) : "", s.memory ? bytes(s.memory) : "", s.restarts ? `再起動 ${s.restarts}` : ""].filter(Boolean).join(" · ")}
                </span>
              </span>
            </div>
          );
        })}
        {v.services.length === 0 && <div className="p-3 text-[12px] text-mute">サービスを読めなかった</div>}
      </div>
      {v.errors.length > 0 && <div className="rounded-xl bg-orange/10 px-3 py-2 text-[11.5px] text-orange-ink">{v.errors.map((e) => `${e.source}: ${e.error}`).join(" / ")}</div>}
      <p className="text-[11px] text-mute">読むだけ（グラフは5秒、ほかは15秒ごとに更新）。止まっているサービスを動かすときは、エージェントに頼む</p>
    </div>
  );
}

const THEMES: { id: ThemePref; label: string }[] = [
  { id: "auto", label: "自動" },
  { id: "light", label: "白" },
  { id: "dark", label: "黒" },
];

function LangPicker() {
  return (
    <div className="mx-4 mb-3 flex min-h-11 items-center gap-2 rounded-xl border border-line bg-panel px-3.5 text-[13px]">
      <span>{t("言語")}</span>
      <div className="ml-auto flex gap-1" role="radiogroup" aria-label={t("言語")}>
        {(["ja", "en"] as const).map((l) => (
          <button key={l} role="radio" aria-checked={lang === l} onClick={() => lang !== l && setLang(l)} className={`min-h-8 rounded-full px-3 text-[12px] ${lang === l ? "bg-ink font-bold text-paper" : "border border-line-2 text-ink-2"}`}>
            {l === "ja" ? "日本語" : "English"}
          </button>
        ))}
      </div>
    </div>
  );
}

function ThemePicker() {
  const [pref, setPref] = useTheme();
  return (
    <div className="mx-4 mb-3 flex min-h-11 items-center gap-2 rounded-xl border border-line bg-panel px-3.5 text-[13px]">
      <span>{t("表示")}</span>
      <span className="text-[11px] text-mute">{pref === "auto" ? t("スマホの設定に合わせる") : ""}</span>
      <div className="ml-auto flex gap-1" role="radiogroup" aria-label="表示の色">
        {THEMES.map((t) => (
          <button key={t.id} role="radio" aria-checked={pref === t.id} onClick={() => setPref(t.id)} className={`min-h-8 rounded-full px-3 text-xs ${pref === t.id ? "bg-ink font-bold text-paper" : "border border-line-2 text-ink-2"}`}>
            {tr(t.label)}
          </button>
        ))}
      </div>
    </div>
  );
}

type Tab = "general" | "agents" | "connections" | "usage" | "vps";
export const SETTINGS_TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "一般" },
  { id: "agents", label: "エージェント" },
  { id: "connections", label: "接続" },
  { id: "usage", label: "使用量" },
  { id: "vps", label: "VPS" },
];

/** このアプリについて: 版・開発者・ライセンス */
function AboutApp() {
  const a = getAbout();
  const row = "flex items-center justify-between gap-3 px-3.5 py-2.5";
  return (
    <section aria-label="このアプリについて" className="mx-4 divide-y divide-line rounded-xl border border-line text-[13px]">
      <div className="flex flex-col gap-2 px-3.5 py-3">
        <span className="font-bold">{a.name}</span>
        <blockquote className="m-0 font-serif text-[15px] leading-relaxed text-ink">{lang === "ja" ? "わたくしといふ現象は" : "I contain multitudes."}</blockquote>
        <cite className="font-mono text-[10.5px] not-italic text-mute">{lang === "ja" ? "宮沢賢治『春と修羅』" : "Walt Whitman, Song of Myself"}</cite>
      </div>
      <div className={row}>
        <span className="text-mute">バージョン</span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-semibold">{versionName(a.version)}</span>
          <span className="flex-none font-mono text-[12px] text-mute">{a.version || "—"}</span>
        </span>
      </div>
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-2.5 [&::-webkit-details-marker]:hidden">
          <span className="text-mute">{tr("リリースノート")}</span>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true" className="flex-none text-mute transition-transform duration-200 group-open:rotate-90"><path d="M9 6l6 6-6 6" /></svg>
        </summary>
        <div className="flex flex-col gap-4 px-3.5 pb-3.5 pt-0.5">
          {RELEASE_NOTES.map((n) => (
            <section key={n.version} aria-label={n.name}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-[12px] font-bold">v{n.version}</span>
                <span className="text-[13.5px] font-bold">{n.name}</span>
                <span className="ml-auto font-mono text-[10.5px] text-mute">{n.date ?? tr("開発中")}</span>
              </div>
              <ul className="m-0 mt-1 list-disc pl-4 text-[12.5px] leading-relaxed text-ink-2">
                {n.items.map((x) => <li key={x}>{x}</li>)}
              </ul>
            </section>
          ))}
        </div>
      </details>
      {a.developer && (
        <div className={row}>
          <span className="text-mute">開発者</span>
          <span>{a.developer}</span>
        </div>
      )}
      <div className={row}>
        <span className="text-mute">ライセンス</span>
        <span>{a.license}</span>
      </div>
      {a.repoUrl && (
        <a href={a.repoUrl} target="_blank" rel="noreferrer" className={`${row} text-ink-2 no-underline`}>
          <span className="text-mute">ソースコード</span>
          <span className="truncate">{a.repoUrl.replace(/^https?:\/\//, "")} ›</span>
        </a>
      )}
    </section>
  );
}


function General() {
  return (
    <div className="flex flex-col gap-3 pb-6 pt-2.5">
      <ProfileCard />
      <ThemePicker />
      <LangPicker />
      <PushSection />
      <AboutApp />
    </div>
  );
}

function Section({ title }: { title: string }) {
  return <h2 className="m-0 mx-5 mt-5 text-[12px] font-semibold text-mute">{title}</h2>;
}

/** VPS: 状態・root 作業・許可リスト・ファイル */
function VpsTab({ snap }: { snap: Snapshot | null }) {
  return (
    <>
      <Vps />
      <Section title="root 作業" />
      <a href="#/root" className="mx-4 mt-2 flex min-h-11 items-center justify-between rounded-xl border border-line bg-panel px-3.5 text-[13px] text-ink no-underline">
        <span className="flex flex-col">
          <span>root 作業の承認</span>
          <span className="text-[11px] text-mute">エージェントが頼んだ VPS の root 作業を見て、パスワードで通す</span>
        </span>
        <span className="text-mute">›</span>
      </a>
      <Section title="許可リスト" />
      <Allowlists agents={snap?.agents ?? []} />
      <Section title="ファイル" />
      <Files />
    </>
  );
}

export function System({ snap }: { snap: Snapshot | null }) {
  // 左のメニューから #/settings?tab=agents のように直接開ける
  const fromHash = (): Tab => {
    const t = new URLSearchParams(location.hash.split("?")[1] ?? "").get("tab");
    return SETTINGS_TABS.some((x) => x.id === t) ? (t as Tab) : "general";
  };
  const [tab, setTab] = useState<Tab>(fromHash);
  useEffect(() => {
    const on = () => setTab(fromHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", t === "general" ? "#/settings" : `#/settings?tab=${t}`);
  };
  return (
    <Page title={t("設定")} current="#/settings">
      <div className="flex gap-1.5 overflow-x-auto px-4 pt-2.5 [scrollbar-width:none]" role="tablist">
        {SETTINGS_TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => go(t.id)} className={`min-h-9 flex-none rounded-full px-3.5 text-xs ${tab === t.id ? "bg-ink font-bold text-paper" : "border border-line-2 text-ink-2"}`}>
            {tr(t.label)}
          </button>
        ))}
      </div>
      {tab === "usage" ? (
        <Usage snap={snap} />
      ) : tab === "agents" ? (
        <>
          {snap && (
            <>
              <Section title="オーケストレーション" />
              <OrchestrationGraph agents={snap.agents} tasks={snap.board?.tasks ?? []} />
            </>
          )}
          <Agents snap={snap} />
          <Section title="定期実行" />
          <Schedules snap={snap} />
        </>
      ) : tab === "connections" ? (
        <Connections />
      ) : tab === "vps" ? (
        <VpsTab snap={snap} />
      ) : (
        <General />
      )}
    </Page>
  );
}
