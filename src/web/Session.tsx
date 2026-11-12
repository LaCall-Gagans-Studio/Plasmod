// セッション（TASK-157）: コマンドラインのような、少し無骨な見た目。
import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../shared/types";
import { capsOfAgent } from "../shared/types";
import { submit, useOutgoing } from "./outbox";
import { PinMark, SessionRow } from "./sessionmenu";
import { Avatar, Icon, ago, profileOf } from "./ui";
import type { AgentProfile, SessionInfo } from "../shared/types";
import { DEFAULT_TEAM, DEFAULT_TEAMS, teamOfProfile } from "../shared/types";
import { ALL, CHAT_PICK, sessionKey, useAllSessions, useAgents, useAgentList, useHideCron, useSessions, useView, useCredits, useOlder, NAME, LAST_AGENT, lastSessionKey, recall, remember, useChatUnread, CHAT_TEAM } from "./session-data";
import { CreditsLine, ViewBody } from "./SessionBody";
import { Composer } from "./Composer";
import { useLongPress } from "./touch";
import { Beckon, Seeking, Skeleton } from "./loading";
import { blobPath } from "./amoeba";

/** 一覧の「新しいセッション」の下に置く、cron の回を省くトグル */
function CronToggle({ className = "" }: { className?: string }) {
  const [hide, setHide] = useHideCron();
  return (
    <button role="switch" aria-checked={hide} onClick={() => setHide(!hide)} className={`flex items-center gap-1.5 text-[10.5px] text-mute ${className}`}>
      <span className={`relative h-3.5 w-6 flex-none rounded-full transition-colors ${hide ? "bg-ink" : "bg-line-2"}`}>
        <span className={`absolute top-0.5 size-2.5 rounded-full bg-paper transition-all ${hide ? "left-3" : "left-0.5"}`} />
      </span>
      cron の回を省く
    </button>
  );
}

/** 「全員」の画面で、新しいセッションの相手を示す小さい丸。押すとその相手で始め、長押し（PC は右クリック）で相手を変える */
function NewWhoDot({ agents, snap, value, active, onPick, onStart, size = 26, align = "right", className = "" }: { agents: { id: string }[]; snap: Snapshot | null; value: string | null; active: boolean; onPick: (id: string) => void; onStart: () => void; size?: number; align?: "left" | "right"; className?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const lp = useLongPress(() => setOpen(true));
  useEffect(() => {
    if (!open) return;
    const on = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", on);
    return () => document.removeEventListener("pointerdown", on);
  }, [open]);
  if (!snap || !value) return null;
  return (
    <span ref={box} className={`relative flex-none ${className}`}>
      <button
        {...lp}
        onClick={onStart}
        aria-label={`${NAME(snap, value)}と新しいセッションを始める（長押しで相手を変える）`}
        title={`${NAME(snap, value)}（長押しで相手を変える）`}
        className={`select-none rounded-full p-0.5 [-webkit-touch-callout:none] ${active ? "ring-2 ring-ink" : "ring-1 ring-line-2"}`}
      >
        <Avatar p={profileOf(snap.agents, value)} size={size} />
      </button>
      {open && (
        <div role="menu" aria-label="新しいセッションの相手" className={`absolute top-full z-20 mt-1.5 w-44 overflow-hidden rounded-lg border border-line bg-panel-2 shadow-lg ${align === "right" ? "right-0" : "left-0"}`}>
          {agents.map((a) => (
            <button
              key={a.id}
              role="menuitemradio"
              aria-checked={a.id === value}
              onClick={() => (setOpen(false), onPick(a.id))}
              className={`flex min-h-10 w-full items-center gap-2 border-b border-line px-2.5 text-left font-sans text-[12.5px] last:border-b-0 ${a.id === value ? "font-semibold text-ink" : "text-ink-2"}`}
            >
              <Avatar p={profileOf(snap.agents, a.id)} size={22} />
              <span className="min-w-0 flex-1 truncate">{NAME(snap, a.id)}</span>
              {a.id === value && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** 相手のアイコンを包むアメーバ。体がぷるぷる形を変え、偽足が下の入力欄へ伸びて「こっち」と招く（動きを減らす設定では止める） */
function HeroAmoeba({ p, color, size }: { p?: AgentProfile; color: string; size: number }) {
  const W = 180;
  const H = 210;
  const cx = W / 2;
  const cy = 84;
  const body = useRef<SVGPathElement>(null);
  const arm = useRef<SVGPathElement>(null);
  const tip = useRef<SVGCircleElement>(null);
  const R = size / 2 + 20;
  useEffect(() => {
    const draw = (t: number) => {
      const radii = Array.from({ length: 9 }, (_, i) => R + Math.sin(t * 1.1 + i * 1.7) * 4.5 + Math.sin(t * 0.7 + i * 2.9) * 3);
      body.current?.setAttribute("d", blobPath(cx, cy, radii, t * 0.12));
      const sway = Math.sin(t * 1.5) * 12;
      const hop = Math.max(0, Math.sin(t * 0.75 + 0.6)) ** 8 * 8;
      const y0 = cy + R - 8;
      const len = 40 + Math.sin(t * 0.9) * 4 + hop;
      const x1 = cx + sway;
      const y1 = y0 + len;
      arm.current?.setAttribute("d", `M${cx} ${y0} C${cx - sway * 0.6} ${y0 + len * 0.45} ${x1 + sway * 0.4} ${y1 - len * 0.4} ${x1.toFixed(1)} ${y1.toFixed(1)}`);
      tip.current?.setAttribute("cx", x1.toFixed(1));
      tip.current?.setAttribute("cy", y1.toFixed(1));
    };
    draw(0);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const t0 = performance.now();
    const frame = (ms: number) => {
      draw((ms - t0) / 1000);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [R]);
  const fill = `color-mix(in srgb, ${color} 34%, transparent)`;
  return (
    <div className="relative flex-none" style={{ width: W, height: H }} aria-hidden="true">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 overflow-visible">
        <defs>
          <filter id="gh-hero-goo" x="0" y="0" width={W} height={H} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3.2" result="b" />
            <feColorMatrix in="b" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8" />
          </filter>
        </defs>
        <g filter="url(#gh-hero-goo)" style={{ fill, stroke: fill }}>
          <path ref={body} stroke="none" />
          <path ref={arm} fill="none" strokeWidth={9} strokeLinecap="round" />
          <circle ref={tip} r={6.5} stroke="none" />
        </g>
        <circle cx={cx} cy={cy} r={R} fill="none" stroke={color} strokeOpacity={0.55} strokeWidth={1.5} strokeDasharray="2 7" strokeLinecap="round" />
      </svg>
      <span className="absolute rounded-full" style={{ left: cx - size / 2, top: cy - size / 2, boxShadow: `0 0 0 3px ${color}, 0 10px 28px -8px color-mix(in srgb, ${color} 75%, transparent)` }}>
        {p ? <Avatar p={p} size={size} /> : null}
      </span>
    </div>
  );
}

/** 新しいセッションの画面いっぱいに出す「だれと始まるか」の表示。相手の色を背景に敷いて、取り違えを防ぐ */
function NewWithHero({ p, name, compact = false }: { p?: AgentProfile; name: string; compact?: boolean }) {
  const c = p?.color ?? "var(--color-line-2)";
  return (
    <div
      role="status"
      aria-live="polite"
      className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden px-6 py-4 text-center"
      style={{ background: `radial-gradient(ellipse 85% 70% at 50% 38%, color-mix(in srgb, ${c} 26%, transparent), color-mix(in srgb, ${c} 7%, transparent) 62%, transparent)` }}
    >
      <HeroAmoeba p={p} color={c} size={compact ? 60 : 76} />
      <div className="flex flex-col items-center gap-1 font-sans">
        <span className="text-[11px] font-semibold tracking-[0.18em] text-mute">NEW SESSION</span>
        <span className={`${compact ? "text-[19px]" : "text-[24px]"} font-bold leading-tight text-ink`}>{name}と始める</span>
        {p?.role && <span className="text-[12px] text-ink-2">{p.role}</span>}
      </div>
      <span className="font-sans text-[12px] text-mute">下から最初の一言を送ると始まる</span>
    </div>
  );
}

/** 一覧の行の「誰のセッションか」（全員の一覧で使う） */
function Who({ p, size = 14 }: { p?: AgentProfile; size?: number }) {
  if (!p) return null;
  return (
    <span className="flex min-w-0 flex-none items-center gap-1 font-semibold text-ink-2">
      <Avatar p={p} size={size} />
      <span className="max-w-[72px] truncate">{p.name}</span>
    </span>
  );
}

export function SessionPanel({ snap }: { snap: Snapshot | null }) {
  const list = useAgentList();
  const all = list.agents;
  /** チームごとに切り替える。メンバーがいるチームだけ順に回す */
  const teams = snap?.teams ?? DEFAULT_TEAMS;
  const teamOf = (id: string) => teamOfProfile(snap ? profileOf(snap.agents, id) : undefined, teams).id;
  const liveTeams = teams.filter((t) => all.some((a) => teamOf(a.id) === t.id));
  const [teamPick, setTeamState] = useState<string>(() => recall(CHAT_TEAM) ?? DEFAULT_TEAM);
  const team = liveTeams.some((t) => t.id === teamPick) ? teamPick : (liveTeams[0]?.id ?? DEFAULT_TEAM);
  const agents = all.filter((a) => teamOf(a.id) === team);
  const [agent, setAgentState] = useState<string | null>(null);
  const agentRef = useRef(agent);
  agentRef.current = agent;
  /** agent は個別のエージェントの id、または ALL（全員） */
  const setAgent = (a: string) => {
    setAgentState(a);
    remember(CHAT_PICK, a);
    if (a !== ALL) remember(LAST_AGENT, a);
  };
  const isAll = agent === ALL;
  const available = all.filter((a) => a.available);
  /** 全員の画面で、新しいセッションを始める相手 */
  const [newWith, setNewWith] = useState<string | null>(null);
  const lastAgent = recall(LAST_AGENT);
  const newTarget = available.some((a) => a.id === newWith) ? newWith : available.some((a) => a.id === lastAgent) ? lastAgent : (available[0]?.id ?? null);
  /** 「最後に開いていたセッション」を覚えるキー。全員は全員で別に覚える */
  const memoKey = lastSessionKey(isAll ? ALL : (agent ?? ""));
  const [bump, setBump] = useState(0);
  /** 「＋」を押したあと: 次の送信で新しいセッションを始める */
  const [fresh, setFresh] = useState(false);
  /** 過去のセッションの一覧を開いているか。選ぶと、それを「最後に開いていたもの」にする */
  const [picking, setPicking] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerBtn = useRef<HTMLButtonElement>(null);
  // 一覧の外をタップしたら畳む
  useEffect(() => {
    if (!picking) return;
    const on = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pickerRef.current?.contains(t) && !pickerBtn.current?.contains(t)) setPicking(false);
    };
    document.addEventListener("pointerdown", on);
    return () => document.removeEventListener("pointerdown", on);
  }, [picking]);
  const [, setPicked] = useState(0);
  const pick = (s: SessionInfo) => {
    remember(lastSessionKey(s.agent), s.id);
    if (isAll) remember(memoKey, sessionKey(s));
    setFresh(false);
    setPicking(false);
    setPicked((x) => x + 1);
  };
  const agentIds = agents.map((a) => a.id).join(",");
  useEffect(() => {
    if (!agentIds) return void (agent && setAgentState(null));
    if (agent === ALL || (agent && agentIds.split(",").includes(agent))) return;
    // 既定は「全員」。前回、個別のエージェントを選んでいたらそちら
    const last = recall(CHAT_PICK);
    setAgentState(last && agentIds.split(",").includes(last) ? last : ALL);
  }, [agentIds, agent]);
  const setTeam = (t: string) => {
    setTeamState(t);
    remember(CHAT_TEAM, t);
    // 別のチームに替えたら、前のチームのエージェントは並ばないので「全員」に戻る
    if (agent !== ALL) setAgent(ALL);
    setFresh(false);
    setPicking(false);
  };
  const own = useSessions(isAll ? null : agent, bump);
  const mixed = useAllSessions(isAll ? all : [], bump);
  const { sessions, error } = isAll ? mixed : own;
  // 最後に開いていたセッションがまだあればそれ、無ければ一番新しいもの
  const lastId = agent ? recall(memoKey) : null;
  // 一覧はピン留めが先頭なので、先頭ではなく最後に動いたものを選ぶ
  const newest = sessions?.reduce<(typeof sessions)[number] | null>((a, s) => (!a || s.last > a.last ? s : a), null) ?? null;
  const latest = fresh ? null : (sessions?.find((s) => (isAll ? sessionKey(s) : s.id) === lastId) ?? newest);
  /** いま話している相手（全員では、開いているセッションの持ち主か、新しく始める相手） */
  const target = isAll ? (latest?.agent ?? newTarget) : agent;
  const who = snap && target ? profileOf(snap.agents, target) : undefined;
  const { view } = useView(target, latest?.id ?? null, 3000);
  const outgoing = useOutgoing(target ?? "", latest?.id ?? null);
  const unread = useChatUnread(all, target);
  /** 次のチーム（チームが3つ以上なら順に回る） */
  const other = liveTeams.length > 1 ? liveTeams[(liveTeams.findIndex((t) => t.id === team) + 1) % liveTeams.length] : null;
  const otherUnread = all.some((a) => teamOf(a.id) !== team && unread.has(a.id));

  return (
    <section className="mx-3.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-panel font-mono" aria-label="セッション">
      <div className="flex gap-1 overflow-x-auto border-b border-line px-2 py-2 text-xs [scrollbar-width:none]" role="tablist" aria-label="エージェント">
        <button
          role="tab"
          aria-selected={isAll}
          onClick={() => {
            setAgent(ALL);
            setFresh(false);
            setPicking(false);
          }}
          className={`flex min-h-8 flex-none items-center gap-1.5 whitespace-nowrap rounded-md pl-1 pr-3 font-semibold ${isAll ? "bg-ink text-paper" : "text-mute"}`}
        >
          <span className="relative flex size-[22px] flex-none items-center justify-center rounded-full border border-current">
            <Icon name="team" size={14} />
            {!isAll && unread.size > 0 && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-panel bg-orange" aria-label="未読あり" />}
          </span>
          全員
        </button>
        {agents.map((a) => (
          <button
            key={a.id}
            role="tab"
            aria-selected={agent === a.id}
            onClick={() => {
              setAgent(a.id);
              setFresh(false);
              setPicking(false);
            }}
            className={`flex min-h-8 flex-none items-center gap-1.5 whitespace-nowrap rounded-md pl-1 pr-3 font-semibold ${agent === a.id ? "bg-ink text-paper" : "text-mute"} ${a.available ? "" : "opacity-40"}`}
          >
            {snap && (
              <span className="relative flex-none">
                <Avatar p={profileOf(snap.agents, a.id)} size={22} />
                {unread.has(a.id) && agent !== a.id && (
                  <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-panel bg-orange" aria-label="未読あり" />
                )}
              </span>
            )}
            {NAME(snap, a.id)}
          </button>
        ))}
        {other ? (
          <button
            onClick={() => setTeam(other.id)}
            aria-label={`${other.name}チームに切り替える`}
            title={`${other.name}チーム`}
            className="sticky right-0 ml-auto flex min-h-8 flex-none items-center gap-1 rounded-md border border-line-2 bg-panel px-2 text-[11px] font-semibold text-ink-2"
          >
            <span className="relative">
              <Icon name="team" size={16} />
              {otherUnread && <span className="absolute -right-1 -top-1 size-2 rounded-full border border-panel bg-orange" aria-label="未読あり" />}
            </span>
            {other.name}
          </button>
        ) : null}
      </div>

      {/* スマホ以外: セッションの一覧を左に出しておく（スマホは時計のボタンで開く） */}
      <div className="flex min-h-0 flex-1">
        {agent && (
          <aside className="hidden w-[210px] flex-none flex-col border-r border-line md:flex" aria-label="セッションの一覧">
            <div className="mx-2 mt-2 flex items-center gap-1.5">
              <button
                onClick={() => (setFresh(true), setPicking(false))}
                className={`flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-dashed px-2.5 text-[12px] ${fresh ? "border-ink text-ink" : "border-line-2 text-ink-2"}`}
              >
                ＋ 新しいセッション
              </button>
              {isAll && <NewWhoDot agents={available} snap={snap} value={newTarget} active={fresh} onPick={(id) => (setNewWith(id), setFresh(true), setPicking(false))} onStart={() => (setFresh(true), setPicking(false))} />}
            </div>
            <CronToggle className="mx-2.5 mt-2" />
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {sessions?.map((s) => (
                <SessionRow
                  key={s.id}
                  s={s}
                  who={snap ? profileOf(snap.agents, s.agent) : undefined}
                  onPick={() => pick(s)}
                  onChanged={() => setBump((x) => x + 1)}
                  aria-current={sessionKey(s) === (latest && sessionKey(latest)) ? "true" : undefined}
                  className={`mb-0.5 flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left ${sessionKey(s) === (latest && sessionKey(latest)) ? "bg-chip text-ink" : "text-ink-2 hover:bg-chip"}`}
                >
                  <span className="line-clamp-2 text-[12px] leading-snug">{s.pinnedAt && <PinMark />}{s.title}</span>
                  <span className="flex items-center gap-1.5 text-[10.5px] text-mute">
                    {isAll && <Who p={snap ? profileOf(snap.agents, s.agent) : undefined} />}
                    <span className={`size-1.5 rounded-full ${s.working ? "bg-lime" : s.alive ? "bg-mute" : "bg-line-2"}`} />
                    {s.working ? "作業中" : s.alive ? "待機" : "停止"} · {ago(s.last)}
                  </span>
                </SessionRow>
              ))}
            </div>
          </aside>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {agent && (
            <div className="flex items-center gap-1 px-3.5 pt-2 text-[11px] text-mute">
              {who && <Who p={who} size={18} />}
              {latest ? (
                <a href={`#/session/${latest.agent}/${encodeURIComponent(latest.id)}`} className="min-w-0 truncate hover:text-ink-2">
                  {latest.title}
                </a>
              ) : (
                <span className="truncate font-semibold text-ink">新しいセッション{fresh && who ? ` · ${who.name}` : ""}</span>
              )}
              <button
                onClick={() => (setFresh(true), setPicking(false))}
                aria-label="新しいセッションを始める"
                title="新しいセッション"
                className={`flex size-6 flex-none items-center justify-center rounded-md border text-[13px] leading-none md:hidden ${fresh ? "border-ink text-ink" : "border-line-2 text-mute hover:text-ink"}`}
              >
                +
              </button>
              {isAll && <NewWhoDot agents={available} snap={snap} value={newTarget} active={fresh} size={18} align="left" className="md:hidden" onPick={(id) => (setNewWith(id), setFresh(true), setPicking(false))} onStart={() => (setFresh(true), setPicking(false))} />}
              <button
                ref={pickerBtn}
                onClick={() => setPicking((x) => !x)}
                aria-label="過去のセッションに切り替える"
                aria-expanded={picking}
                title="過去のセッション"
                disabled={!sessions}
                className={`flex size-6 flex-none items-center justify-center rounded-md border disabled:opacity-30 md:hidden ${picking ? "border-ink text-ink" : "border-line-2 text-mute hover:text-ink"}`}
              >
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
              </button>
            </div>
          )}
          {agent && picking && sessions && (
            <div ref={pickerRef} className="mx-2.5 mt-1.5 max-h-56 overflow-y-auto rounded-lg border border-line bg-panel-2 md:hidden" role="listbox" aria-label="過去のセッション">
          <CronToggle className="min-h-9 w-full border-b border-line px-2.5" />
              {sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  s={s}
                  who={snap ? profileOf(snap.agents, s.agent) : undefined}
                  role="option"
                  aria-selected={sessionKey(s) === (latest && sessionKey(latest))}
                  onPick={() => pick(s)}
                  onChanged={() => setBump((x) => x + 1)}
                  className={`flex min-h-10 w-full items-center gap-2 border-b border-line px-2.5 text-left text-[12px] last:border-b-0 ${sessionKey(s) === (latest && sessionKey(latest)) ? "font-semibold text-ink" : "text-ink-2"}`}
                >
                  {isAll && snap && <Avatar p={profileOf(snap.agents, s.agent)} size={18} />}
                  {s.working && <span className="size-1.5 flex-none rounded-full bg-lime" aria-label="作業中" />}
                  {s.pinnedAt && <PinMark />}
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <span className="flex-none text-[10.5px] text-mute">{ago(s.last)}</span>
                </SessionRow>
              ))}
            </div>
          )}

          {agents.length === 0 && list.state === "loading" && <Seeking since={list.since} />}
          {agents.length === 0 && list.state === "error" && (
            <div className="flex flex-col items-center gap-2 p-6 text-center text-[12.5px] text-mute">
              <span>セッションの窓口に届かない（{list.error}）</span>
              <button onClick={list.retry} className="min-h-9 rounded-full border border-line-2 px-4 text-[12.5px] text-ink">もう一度つなぐ</button>
            </div>
          )}
          {agents.length === 0 && list.state === "ok" && (
            <div className="p-4 text-[12.5px] text-mute">
              {team === "watch" ? "監察チーム（監査・ITS・戦略立案）はまだチャットにつながっていない。Hermes 側でプロファイルを作ると、ここに並ぶ" : "セッションの窓口につながっていない"}
            </div>
          )}
          {error && <div className="p-4 text-[12.5px] text-orange-ink">{error}</div>}
          {!fresh && sessions && sessions.length === 0 && outgoing.length === 0 && <Beckon>まだセッションがない。下から話しかけると始まる</Beckon>}
          {fresh && outgoing.length === 0 && <NewWithHero p={who} name={target ? NAME(snap, target) : ""} compact />}
          {(latest || outgoing.length > 0) && <ViewBody
              who={who}
              view={latest ? view : null}
              compact
              outgoing={outgoing}
              scrollKey={`${target}:${latest?.id ?? "new"}`}
              onChoose={target && latest ? (t) => void submit(target, latest.id, t, []).then(() => setBump((x) => x + 1)) : undefined}
            />}
          {!latest && !fresh && outgoing.length === 0 && <div className="flex-1" />}
          <div className="p-2.5" style={fresh && !latest && who ? { boxShadow: `inset 0 3px 0 0 ${who.color}` } : undefined}>
            {target && (
              <Composer
                placeholder={`${NAME(snap, target)}に頼む…`}
                draftKey={`${target}:${latest?.id ?? "new"}`}
                onSend={(t, f) => {
                  const starting = !latest;
                  // 新しく始めるときは、番号が決まるまで「新しいセッション」のまま待つ（ほかのセッションを開かない）
                  void submit(target, latest?.id ?? null, t, f).then((sid) => {
                    if (starting && sid) {
                      remember(lastSessionKey(target), sid);
                      if (isAll) remember(memoKey, `${target}:${sid}`);
                      if (agentRef.current === agent) setFresh(false);
                    }
                    setBump((x) => x + 1);
                  });
                }}
              />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** #/session: 最後に開いていたエージェント・セッションを開く（メニューの「セッション」） */
export function OpenLastSession() {
  const list = useAgentList();
  const agents = list.agents;
  const ids = agents.map((a) => a.id).join(",");
  useEffect(() => {
    if (!ids) return;
    const list = ids.split(",");
    const last = recall(LAST_AGENT);
    const agent = last && list.includes(last) ? last : list[0];
    location.replace(`#/session/${agent}/${encodeURIComponent(recall(lastSessionKey(agent)) ?? "new")}`);
  }, [ids]);
  if (list.state === "loading" || agents.length) return <Seeking since={list.since} />;
  return (
    <div className="flex flex-col items-center gap-2 p-8 text-center text-[13px] text-mute">
      <span>{list.state === "error" ? `セッションの窓口に届かない（${list.error}）` : "話せるエージェントがいない"}</span>
      <button onClick={list.retry} className="min-h-9 rounded-full border border-line-2 px-4 text-[12.5px] text-ink">もう一度つなぐ</button>
    </div>
  );
}

/** 全画面のセッション。#/session/<agent>/<id>（id が new なら新しいセッション）。
 *  切り替えは左のサイドバー（エージェント → セッションを縦に並べる）。広い画面では常に出しておく。 */
export function SessionPage({ snap, agent, id }: { snap: Snapshot | null; agent: string; id: string }) {
  const agents = useAgents();
  const [bump, setBump] = useState(0);
  const [open, setOpen] = useState(false);
  const { sessions, error: listError } = useSessions(agent, bump);
  const current = id === "new" ? null : id;
  const caps = capsOfAgent(agent, agents.find((a) => a.id === agent)?.runtime);
  const { view, error } = useView(agent, current, caps.pollMs);
  const info = sessions?.find((s) => s.id === current);
  const outgoing = useOutgoing(agent, current);
  const older = useOlder(agent, current, view);
  const credits = useCredits(caps.credits);
  const unread = useChatUnread(agents, agent);
  const who = snap ? profileOf(snap.agents, agent) : undefined;
  useEffect(() => {
    remember(LAST_AGENT, agent);
    remember(lastSessionKey(agent), current);
  }, [agent, current]);

  const go = (a: string, s: string) => {
    setOpen(false);
    location.hash = `#/session/${a}/${encodeURIComponent(s)}`;
  };

  const sidebar = (
    <nav aria-label="セッション" className="flex h-full w-full flex-col bg-panel-2">
      <div className="flex flex-col gap-1 border-b border-line p-2.5 pt-[max(env(safe-area-inset-top),12px)]">
        {agents.map((a) => {
          const p = snap ? profileOf(snap.agents, a.id) : null;
          return (
            <button
              key={a.id}
              onClick={() => go(a.id, "new")}
              aria-current={a.id === agent ? "true" : undefined}
              className={`flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] ${a.id === agent ? "bg-ink font-semibold text-paper" : "text-ink-2"} ${a.available ? "" : "opacity-40"}`}
            >
              {p && (
                <span className="relative flex-none">
                  <Avatar p={p} size={24} />
                  {unread.has(a.id) && a.id !== agent && (
                    <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-panel-2 bg-orange" aria-label="未読あり" />
                  )}
                </span>
              )}
              {NAME(snap, a.id)}
            </button>
          );
        })}
      </div>
      <button onClick={() => go(agent, "new")} className={`m-2.5 flex min-h-11 items-center gap-2 rounded-lg border border-dashed px-3 text-[13px] ${current ? "border-line-2 text-ink-2" : "border-ink text-ink"}`}>
        ＋ 新しいセッション
      </button>
      <CronToggle className="mx-3 mb-2" />
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
        {listError && <div className="p-2 text-xs text-orange-ink">{listError}</div>}
        {!sessions && !listError && <Skeleton />}
        {sessions?.map((s) => (
          <SessionRow
            key={s.id}
            s={s}
            who={snap ? profileOf(snap.agents, s.agent) : undefined}
            onPick={() => go(agent, s.id)}
            onChanged={() => setBump((x) => x + 1)}
            aria-current={s.id === current ? "true" : undefined}
            className={`mb-1 flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left ${s.id === current ? "bg-chip text-ink" : "text-ink-2 hover:bg-chip"}`}
          >
            <span className="line-clamp-2 text-[13px] leading-snug">{s.pinnedAt && <PinMark />}{s.title}</span>
            <span className="flex items-center gap-1.5 text-[11px] text-mute">
              <span className={`size-1.5 rounded-full ${s.working ? "bg-lime" : s.alive ? "bg-mute" : "bg-line-2"}`} />
              {s.working ? "作業中" : s.alive ? "待機" : "停止"} · {ago(s.last)}
            </span>
          </SessionRow>
        ))}
      </div>
    </nav>
  );

  return (
    <div className="flex h-full bg-ground font-mono text-ink">
      {/* 広い画面: 常に左に出す */}
      <aside className="hidden w-[280px] flex-none border-r border-line md:block">{sidebar}</aside>
      {/* スマホ: 引き出し */}
      {open && (
        <div className="fixed inset-0 z-20 flex md:hidden">
          <aside className="h-full w-[84%] max-w-[320px] shadow-2xl">{sidebar}</aside>
          <button aria-label="閉じる" className="flex-1 bg-black/50" onClick={() => setOpen(false)} />
        </div>
      )}

      <div className="mx-auto flex h-full min-w-0 max-w-[760px] flex-1 flex-col lg:max-w-[1080px] 2xl:max-w-[1280px]">
        <div className="flex items-center gap-1 border-b border-line px-2 pb-2 pt-[max(env(safe-area-inset-top),10px)]">
          <a href="#/" aria-label="チャットへ" className="flex size-11 flex-none items-center justify-center"><svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg></a>
          <button onClick={() => setOpen(true)} aria-label="セッションの一覧" className="flex size-11 flex-none items-center justify-center md:hidden">
            <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          <button onClick={() => setOpen(true)} className="flex min-w-0 flex-1 flex-col items-start px-1 text-left">
            <span className="flex items-center gap-1.5 text-[11px] text-mute">{who && <Avatar p={who} size={16} />}{NAME(snap, agent)}</span>
            <span className="w-full truncate text-[13px] font-semibold">{current ? (info?.title ?? "…") : "新しいセッション"}</span>
          </button>
          {caps.stop && current && info?.alive && (
            <button
              onClick={() => void fetch(`/api/sessions/${agent}/${encodeURIComponent(current)}/stop`, { method: "POST" }).then(() => setBump((x) => x + 1))}
              className="min-h-9 flex-none rounded-md border border-line-2 px-2.5 text-[11px] text-mute"
            >
              止める
            </button>
          )}
        </div>
        {credits && <CreditsLine c={credits} />}

        {current ? (
          error ? <div className="p-4 text-[12.5px] text-orange-ink">{error}</div> : <ViewBody
              who={who}
              view={view}
              outgoing={outgoing}
              scrollKey={`${agent}:${current}`}
              history={older}
              onChoose={(t) => void submit(agent, current, t, []).then(() => setBump((x) => x + 1))}
            />
        ) : outgoing.length > 0 ? (
          <ViewBody who={who} view={null} outgoing={outgoing} />
        ) : (
          <NewWithHero p={who} name={NAME(snap, agent)} />
        )}

        <div className="border-t border-line p-3 pb-[max(env(safe-area-inset-bottom),18px)]" style={!current && who ? { boxShadow: `inset 0 3px 0 0 ${who.color}` } : undefined}>
          <Composer
            placeholder={`${NAME(snap, agent)}に頼む…`}
            busy={view?.kind === "chat" && view.working}
            draftKey={`${agent}:${current ?? "new"}`}
            onSend={(t, f) => {
              void submit(agent, current, t, f).then((sid) => {
                if (sid && !current) go(agent, sid);
                setBump((x) => x + 1);
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}
