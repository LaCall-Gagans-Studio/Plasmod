// セッション（TASK-157）: コマンドラインのような、少し無骨な見た目。
import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../shared/types";
import { submit, useOutgoing } from "./outbox";
import { PinMark, SessionRow } from "./sessionmenu";
import { Avatar, Icon, ago, profileOf } from "./ui";
import { useAgents, useHideCron, useSessions, useView, useCredits, useOlder, NAME, LAST_AGENT, lastSessionKey, recall, remember, useChatUnread, CHAT_TEAM, type Team } from "./session-data";
import { CreditsLine, ViewBody } from "./SessionBody";
import { Composer } from "./Composer";
import { Skeleton } from "./loading";

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

export function SessionPanel({ snap }: { snap: Snapshot | null }) {
  const all = useAgents();
  /** 実働（ハブ・開発エージェント・アオ・経理エージェント）と監察（監査・ITS・戦略立案）を、並びの右端のアイコンで切り替える */
  const [team, setTeamState] = useState<Team>(() => (recall(CHAT_TEAM) === "watch" ? "watch" : "work"));
  const teamOf = (id: string): Team => (snap ? (profileOf(snap.agents, id).team ?? "work") : "work");
  const agents = all.filter((a) => teamOf(a.id) === team);
  const [agent, setAgentState] = useState<string | null>(null);
  const setAgent = (a: string) => {
    setAgentState(a);
    remember(LAST_AGENT, a);
  };
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
  const pick = (id: string) => {
    if (agent) remember(lastSessionKey(agent), id);
    setFresh(false);
    setPicking(false);
    setPicked((x) => x + 1);
  };
  const agentIds = agents.map((a) => a.id).join(",");
  useEffect(() => {
    if (agent && agentIds.split(",").includes(agent)) return;
    if (!agentIds) return void (agent && setAgentState(null));
    const last = recall(LAST_AGENT);
    setAgentState(agentIds.split(",").includes(last ?? "") ? last : agentIds.split(",")[0]);
  }, [agentIds, agent]);
  const setTeam = (t: Team) => {
    setTeamState(t);
    remember(CHAT_TEAM, t);
    setFresh(false);
    setPicking(false);
  };
  const { sessions, error } = useSessions(agent, bump);
  // 最後に開いていたセッションがまだあればそれ、無ければ一番新しいもの
  const lastId = agent ? recall(lastSessionKey(agent)) : null;
  const latest = fresh ? null : (sessions?.find((s) => s.id === lastId) ?? sessions?.[0] ?? null);
  const { view } = useView(agent, latest?.id ?? null, 3000);
  const outgoing = useOutgoing(agent ?? "", latest?.id ?? null);
  const unread = useChatUnread(all, agent);
  const other: Team = team === "work" ? "watch" : "work";
  const otherUnread = all.some((a) => teamOf(a.id) === other && unread.has(a.id));

  return (
    <section className="mx-3.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-panel font-mono" aria-label="セッション">
      <div className="flex gap-1 overflow-x-auto border-b border-line px-2 py-2 text-xs [scrollbar-width:none]" role="tablist" aria-label="エージェント">
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
        {snap?.agents.some((a) => a.team === "watch") || team === "watch" ? (
          <button
            onClick={() => setTeam(other)}
            aria-label={other === "watch" ? "監察チームに切り替える" : "実働チームに切り替える"}
            title={other === "watch" ? "監察チーム" : "実働チーム"}
            className="sticky right-0 ml-auto flex min-h-8 flex-none items-center gap-1 rounded-md border border-line-2 bg-panel px-2 text-[11px] font-semibold text-ink-2"
          >
            <span className="relative">
              <Icon name={other === "watch" ? "watch" : "team"} size={16} />
              {otherUnread && <span className="absolute -right-1 -top-1 size-2 rounded-full border border-panel bg-orange" aria-label="未読あり" />}
            </span>
            {other === "watch" ? "監察" : "実働"}
          </button>
        ) : null}
      </div>

      {/* スマホ以外: セッションの一覧を左に出しておく（スマホは時計のボタンで開く） */}
      <div className="flex min-h-0 flex-1">
        {agent && (
          <aside className="hidden w-[210px] flex-none flex-col border-r border-line md:flex" aria-label="セッションの一覧">
            <button
              onClick={() => (setFresh(true), setPicking(false))}
              className={`mx-2 mt-2 flex min-h-9 flex-none items-center gap-1.5 rounded-lg border border-dashed px-2.5 text-[12px] ${fresh ? "border-ink text-ink" : "border-line-2 text-ink-2"}`}
            >
              ＋ 新しいセッション
            </button>
            <CronToggle className="mx-2.5 mt-2" />
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {sessions?.map((s) => (
                <SessionRow
                  key={s.id}
                  s={s}
                  who={snap ? profileOf(snap.agents, s.agent) : undefined}
                  onPick={() => pick(s.id)}
                  onChanged={() => setBump((x) => x + 1)}
                  aria-current={s.id === latest?.id ? "true" : undefined}
                  className={`mb-0.5 flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left ${s.id === latest?.id ? "bg-chip text-ink" : "text-ink-2 hover:bg-chip"}`}
                >
                  <span className="line-clamp-2 text-[12px] leading-snug">{s.pinnedAt && <PinMark />}{s.title}</span>
                  <span className="flex items-center gap-1.5 text-[10.5px] text-mute">
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
              {latest ? (
                <a href={`#/session/${agent}/${encodeURIComponent(latest.id)}`} className="min-w-0 truncate hover:text-ink-2">
                  {latest.title}
                </a>
              ) : (
                <span className="truncate">新しいセッション</span>
              )}
              <button
                onClick={() => (setFresh(true), setPicking(false))}
                aria-label="新しいセッションを始める"
                title="新しいセッション"
                className={`flex size-6 flex-none items-center justify-center rounded-md border text-[13px] leading-none md:hidden ${fresh ? "border-ink text-ink" : "border-line-2 text-mute hover:text-ink"}`}
              >
                +
              </button>
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
                  aria-selected={s.id === latest?.id}
                  onPick={() => pick(s.id)}
                  onChanged={() => setBump((x) => x + 1)}
                  className={`flex min-h-10 w-full items-center gap-2 border-b border-line px-2.5 text-left text-[12px] last:border-b-0 ${s.id === latest?.id ? "font-semibold text-ink" : "text-ink-2"}`}
                >
                  {s.working && <span className="size-1.5 flex-none rounded-full bg-lime" aria-label="作業中" />}
                  {s.pinnedAt && <PinMark />}
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <span className="flex-none text-[10.5px] text-mute">{ago(s.last)}</span>
                </SessionRow>
              ))}
            </div>
          )}

          {agents.length === 0 && (
            <div className="p-4 text-[12.5px] text-mute">
              {team === "watch" ? "監察チーム（監査・ITS・戦略立案）はまだチャットにつながっていない。Hermes 側でプロファイルを作ると、ここに並ぶ" : "セッションの窓口につながっていない"}
            </div>
          )}
          {error && <div className="p-4 text-[12.5px] text-orange-ink">{error}</div>}
          {!fresh && sessions && sessions.length === 0 && <div className="p-4 text-[12.5px] text-mute">まだセッションがない。下から話しかけると始まる</div>}
          {fresh && <div className="flex-1 p-4 text-[12.5px] leading-relaxed text-mute">下から話しかけると、{agent ? NAME(snap, agent) : ""}との新しいセッションが始まる。</div>}
          {(latest || outgoing.length > 0) && <ViewBody
              view={latest ? view : null}
              compact
              outgoing={outgoing}
              scrollKey={`${agent}:${latest?.id ?? "new"}`}
              onChoose={agent && latest ? (t) => void submit(agent, latest.id, t, []).then(() => setBump((x) => x + 1)) : undefined}
            />}
          {!latest && !fresh && outgoing.length === 0 && <div className="flex-1" />}
          <div className="p-2.5">
            {agent && (
              <Composer
                placeholder={`${NAME(snap, agent)}に頼む…`}
                draftKey={`${agent}:${latest?.id ?? "new"}`}
                onSend={(t, f) => {
                  setFresh(false);
                  if (!latest) remember(lastSessionKey(agent), null); // 新しく始めたものを、次からの「最後」にする
                  void submit(agent, latest?.id ?? null, t, f).then(() => setBump((x) => x + 1));
                }}
              />
            )}
          </div>
        </div>
      </div>
    </section>
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
  const { view, error } = useView(agent, current, agent === "dev" ? 2000 : 1500);
  const info = sessions?.find((s) => s.id === current);
  const outgoing = useOutgoing(agent, current);
  const older = useOlder(agent, current, view);
  const credits = useCredits(agent !== "dev");
  const unread = useChatUnread(agents, agent);
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
            <span className="text-[11px] text-mute">{NAME(snap, agent)}</span>
            <span className="w-full truncate text-[13px] font-semibold">{current ? (info?.title ?? "…") : "新しいセッション"}</span>
          </button>
          {agent === "dev" && current && info?.alive && (
            <button
              onClick={() => void fetch(`/api/sessions/dev/${encodeURIComponent(current)}/stop`, { method: "POST" }).then(() => setBump((x) => x + 1))}
              className="min-h-9 flex-none rounded-md border border-line-2 px-2.5 text-[11px] text-mute"
            >
              止める
            </button>
          )}
        </div>
        {credits && <CreditsLine c={credits} />}

        {current ? (
          error ? <div className="p-4 text-[12.5px] text-orange-ink">{error}</div> : <ViewBody
              view={view}
              outgoing={outgoing}
              scrollKey={`${agent}:${current}`}
              history={older}
              onChoose={(t) => void submit(agent, current, t, []).then(() => setBump((x) => x + 1))}
            />
        ) : outgoing.length > 0 ? (
          <ViewBody view={null} outgoing={outgoing} />
        ) : (
          <div className="flex-1 p-4 text-[12.5px] leading-relaxed text-mute">新しいセッション。{NAME(snap, agent)}に最初の一言を送ると始まる。</div>
        )}

        <div className="border-t border-line p-3 pb-[max(env(safe-area-inset-bottom),18px)]">
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
