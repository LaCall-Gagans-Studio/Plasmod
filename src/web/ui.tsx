import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AmoebaBurst } from "./amoeba";
import { type AgentProfile, findProfile, type NavBadges } from "../shared/types";
import { ownerName } from "./identity";
import { t as tr } from "./i18n";

export const ME: AgentProfile = {
  id: "me",
  get name() {
    return ownerName();
  },
  get initial() {
    return [...ownerName()][0] ?? "?";
  },
  color: "var(--color-me)",
};

export function profileOf(agents: AgentProfile[], id: string): AgentProfile {
  if (id === "me") return ME;
  const hit = findProfile(agents, id);
  if (hit) return { ...hit, id };
  return agents.find((a) => a.id === id) ?? { id, name: id, initial: id.slice(0, 1).toUpperCase(), color: "var(--color-unknown)" };
}

export function Avatar({ p, size = 34, ring }: { p: AgentProfile; size?: number; ring?: string }) {
  const inner = p.avatar ? (
    <img src={p.avatar} alt={p.name} className="block size-full rounded-full object-cover" draggable={false} />
  ) : (
    <span
      className={`flex items-center justify-center rounded-full font-bold ${p.id === "me" ? "text-ink" : "text-on"}`}
      style={{ width: "100%", height: "100%", background: p.color, fontSize: size * 0.4 }}
    >
      {p.initial}
    </span>
  );
  if (!ring) return <span className="block flex-none" style={{ width: size, height: size }}>{inner}</span>;
  return (
    <span className="block flex-none rounded-full p-[3px]" style={{ width: size, height: size, border: `3px solid ${ring}` }}>
      {inner}
    </span>
  );
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "今";
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}

const icons: Record<string, ReactNode> = {
  chat: <path d="M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v8a2.5 2.5 0 01-2.5 2.5H10l-4.5 3.5V17A2.5 2.5 0 014 14.5z" />,
  habit: (
    <>
      <rect x="4" y="4" width="4.4" height="4.4" rx="1" />
      <rect x="9.8" y="4" width="4.4" height="4.4" rx="1" />
      <rect x="15.6" y="4" width="4.4" height="4.4" rx="1" />
      <rect x="4" y="9.8" width="4.4" height="4.4" rx="1" />
      <rect x="9.8" y="9.8" width="4.4" height="4.4" rx="1" />
      <rect x="4" y="15.6" width="4.4" height="4.4" rx="1" />
    </>
  ),
  dev: <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />,
  watch: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
    </>
  ),
  system: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
    </>
  ),
  pj: (
    <>
      <path d="M3 6.5A1.5 1.5 0 014.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0121 8.7v9.8a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18.5z" />
      <path d="M7.5 13l1.6 1.6 3-3M14.5 14h3" />
    </>
  ),
  todo: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <path d="M7.5 9.5l1.6 1.6 3-3M7.5 15.5l1.6 1.6 3-3M14.5 10h3M14.5 16h3" />
    </>
  ),
  memo: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4M9 11h7M9 15h7M9 19h4" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </>
  ),
  send: <path d="M5 12h14M13 6l6 6-6 6" />,
  // レポート用（マテリアルのアイコンに寄せた線画）
  insights: (
    <>
      <rect x="4" y="12" width="3.6" height="8" rx="1" />
      <rect x="10.2" y="5" width="3.6" height="15" rx="1" />
      <rect x="16.4" y="9" width="3.6" height="11" rx="1" />
    </>
  ),
  taskDone: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.8 2.8L16.5 9.5" />
    </>
  ),
  trophy: (
    <>
      <path d="M7 4h10v5a5 5 0 01-10 0z" />
      <path d="M7 6H4a3 3 0 003 4M17 6h3a3 3 0 01-3 4M12 14v3M8 20h8M9 20l1-3h4l1 3" />
    </>
  ),
  bolt: <path d="M13 2L5 13h6l-1 9 8-11h-6z" />,
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4M8 14h3" />
    </>
  ),
  hourglass: <path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9" />,
  team: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19.5c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
      <circle cx="17" cy="9" r="2.6" />
      <path d="M16.5 14.2c2.6.2 4.5 2.1 4.5 5" />
    </>
  ),
};

export function Icon({ name, size = 22 }: { name: keyof typeof icons; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      {icons[name]}
    </svg>
  );
}

/** 画面の列の幅。スマホは 520px。タブレット・PC は画面いっぱいに使い（中は各画面が段組みにする）、とても広い画面だけ 1760px で止める */
export const COL = "mx-auto w-full max-w-[520px] md:max-w-none md:px-2 lg:px-4 2xl:max-w-[1760px]";
/** 広い画面（lg 以上）では、下のメニューを左の縦並びにする。その幅だけ中身を右にずらす */
export const RAIL = "lg:pl-[88px]";

// 下のメニューは4つ（チャット・プロジェクト・ルーティーン・開発）と「メニュー」。ほかの画面は左から出るメニューから開く
const TABS = [
  { href: "#/", label: "チャット", icon: "chat" },
  { href: "#/pj", label: "プロジェクト", icon: "pj" },
  { href: "#/habits", label: "ルーティーン", icon: "habit" },
  { href: "#/dev", label: "開発", icon: "dev" },
] as const;

/** 下のメニューの数字。画面をまたいで1つを共有し、20秒おき（と画面に戻ったとき）に取り直す */
let badges: NavBadges = { home: 0, dev: 0, watching: 0, system: 0 };
const badgeListeners = new Set<() => void>();
let badgeTimer: ReturnType<typeof setInterval> | null = null;
const loadBadges = () =>
  fetch("/api/badges")
    .then((r) => (r.ok ? r.json() : null))
    .then((b: NavBadges | null) => {
      if (!b) return;
      badges = b;
      for (const fn of badgeListeners) fn();
    })
    .catch(() => {});
function useBadges(): NavBadges {
  return useSyncExternalStore(
    (fn) => {
      badgeListeners.add(fn);
      if (!badgeTimer) {
        void loadBadges();
        badgeTimer = setInterval(loadBadges, 20_000);
        document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void loadBadges());
      }
      return () => void badgeListeners.delete(fn);
    },
    () => badges,
  );
}
/** 開発＝PR とカンバンの止まっているもの、をまとめて1つの数字に */
const badgeOf = (b: NavBadges, href: string) => (href === "#/" ? b.home : href === "#/dev" ? b.dev + b.watching : 0);

function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="absolute -right-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-orange px-1 text-[10px] font-bold leading-none text-white tabular-nums">
      {n > 99 ? "99+" : n}
    </span>
  );
}

// 左から出るメニュー。開いているかどうかは画面をまたいで1つ
let drawerOpen = false;
const drawerListeners = new Set<() => void>();
export function setDrawer(open: boolean) {
  if (drawerOpen === open) return;
  drawerOpen = open;
  for (const fn of drawerListeners) fn();
}
const useDrawerOpen = () =>
  useSyncExternalStore(
    (fn) => {
      drawerListeners.add(fn);
      return () => void drawerListeners.delete(fn);
    },
    () => drawerOpen,
  );

// 小項目は普段は畳んでいて、右の ˅ で開く（開いたものは覚えておく）
const MENU: { href: string; label: string; icon: string; badge?: keyof NavBadges; match?: string[]; sub?: { href: string; label: string }[] }[] = [
  { href: "#/", label: "チャット", icon: "chat", badge: "home", sub: [{ href: "#/search", label: "検索" }] },
  { href: "#/pj", label: "プロジェクト", icon: "pj", match: ["#/memo", "#/todo"], sub: [{ href: "#/memos", label: "メモ" }, { href: "#/todos", label: "タスク" }, { href: "#/todos?sort=due", label: "タスク（期限順）" }] },
  { href: "#/habits", label: "ルーティーン", icon: "habit" },
  { href: "#/dev", label: "開発", icon: "dev", badge: "dev", match: ["#/watching", "#/task/"], sub: [{ href: "#/dev", label: "PR" }, { href: "#/watching", label: "カンバン" }] },
  { href: "#/report", label: "レポート", icon: "insights", match: ["#/watch"], sub: [{ href: "#/report", label: "今日のレポート" }, { href: "#/watch", label: "定期報告" }] },
  {
    href: "#/settings",
    label: "設定",
    icon: "settings",
    badge: "system",
    match: ["#/system", "#/root"],
    sub: [
      { href: "#/settings", label: "一般" },
      { href: "#/settings?tab=agents", label: "エージェント" },
      { href: "#/settings?tab=connections", label: "接続" },
      { href: "#/settings?tab=usage", label: "使用量" },
      { href: "#/settings?tab=vps", label: "VPS" },
    ],
  },
];

// 2026-10-29: 既定を「畳む」に変えたので、覚えるものも「開いたもの」にした（前の gh-menu-folded は使わない）
const OPEN_KEY = "gh-menu-open";
function readOpened(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** メニューの文字の下に敷く、地の色の小さな座布団（左下のアメーバと重なっても読める） */
const HALO = "-mx-1.5 rounded-md bg-ground/85 px-1.5 py-0.5 backdrop-blur-[2px]";
/** 選んでいる行は地が chip なので、座布団も chip に */
const HALO_ON = "-mx-1.5 rounded-md bg-chip/85 px-1.5 py-0.5 backdrop-blur-[2px]";

const inSection = (hash: string, m: (typeof MENU)[number]) =>
  m.href === "#/" ? hash === "#/" || hash === "" : hash === m.href || hash.startsWith(`${m.href}?`) || hash.startsWith(`${m.href}/`) || (m.match ?? []).some((x) => hash.startsWith(x));

/** 右へなぞってもメニューを開かないところ: 入力欄・エディタと、横に動かせるもの */
function swipeBlocked(target: EventTarget | null): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== document.body; el = el.parentElement) {
    if (el.matches("input, textarea, select, pre, table, .cm-editor, [data-noswipe]")) return true;
    if (el.scrollWidth > el.clientWidth + 1 && ["auto", "scroll"].includes(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}

/** 左から出るメニュー（App に1つ）。画面の左端から右へなぞる・下の「メニュー」で開く。左へなぞる・外を押す・Esc で閉じる */
export function Drawer() {
  const open = useDrawerOpen();
  const b = useBadges();
  const hash = location.hash || "#/";
  const panel = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState<string[]>(readOpened);
  const fold = (href: string) =>
    setOpened((f) => {
      const next = f.includes(href) ? f.filter((x) => x !== href) : [...f, href];
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        /* 覚えられないだけ */
      }
      return next;
    });

  // 左端（20px）から右へなぞったら開く。横に流れる一覧の邪魔をしないよう、端から始めたときだけ
  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = !drawerOpen && e.touches.length === 1 && !swipeBlocked(e.target) ? { x: t.clientX, y: t.clientY } : null;
    };
    const move = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      if (Math.abs(t.clientY - start.y) > 30 || dx < -10) start = null;
      else if (dx > 70) {
        start = null;
        setDrawer(true);
      }
    };
    addEventListener("touchstart", down, { passive: true });
    addEventListener("touchmove", move, { passive: true });
    const key = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    addEventListener("keydown", key);
    const close = () => setDrawer(false);
    addEventListener("hashchange", close);
    return () => {
      removeEventListener("touchstart", down);
      removeEventListener("touchmove", move);
      removeEventListener("keydown", key);
      removeEventListener("hashchange", close);
    };
  }, []);

  // 開いているときは、左へなぞると閉じる
  const swipe = useRef<number | null>(null);
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
  }, [open]);

  return (
    <div className={`fixed inset-0 z-40 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div onClick={() => setDrawer(false)} className={`absolute inset-0 bg-black/30 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="メニュー"
        onTouchStart={(e) => (swipe.current = e.touches[0].clientX)}
        onTouchMove={(e) => {
          if (swipe.current !== null && swipe.current - e.touches[0].clientX > 48) {
            swipe.current = null;
            setDrawer(false);
          }
        }}
        className={`absolute inset-y-0 left-0 flex w-[min(300px,82vw)] flex-col overflow-y-auto bg-ground pb-[max(env(safe-area-inset-bottom),16px)] pt-[max(env(safe-area-inset-top),20px)] transition-transform duration-200 ease-[cubic-bezier(.2,.8,.2,1)] ${open ? "translate-x-0 shadow-xl" : "-translate-x-full"}`}
      >
        <div className="flex items-center px-5 pb-3">
          <span className="text-[17px] font-bold">Plasmod</span>
          <button onClick={() => setDrawer(false)} aria-label="メニューを閉じる" tabIndex={open ? 0 : -1} className="ml-auto flex size-10 items-center justify-center text-ink-2"><Icon name="close" size={20} /></button>
        </div>
        <nav className="relative z-10 flex flex-col px-2">
          {MENU.map((m) => {
            const on = inSection(hash, m);
            const n = m.badge === "dev" ? b.dev + b.watching : m.badge ? b[m.badge] : 0;
            return (
              <div key={m.href} className="flex flex-col">
                <div className={`flex items-center rounded-xl ${on ? "bg-chip" : "hover:bg-chip/60"}`}>
                  <a href={m.href} tabIndex={open ? 0 : -1} aria-current={on ? "page" : undefined} className={`flex min-h-11 flex-1 items-center gap-3 px-3 text-[14.5px] no-underline ${on ? "font-semibold text-ink" : "text-ink-2"}`}>
                    <span className={`${on ? HALO_ON : HALO} flex items-center gap-3`}>
                      <span className="relative flex"><Icon name={m.icon} size={20} /><Badge n={n} /></span>
                      {tr(m.label)}
                    </span>
                  </a>
                  {m.sub && (
                    <button onClick={() => fold(m.href)} tabIndex={open ? 0 : -1} aria-expanded={opened.includes(m.href)} aria-label={`${tr(m.label)}の小項目を${opened.includes(m.href) ? "畳む" : "開く"}`} className="mr-1 flex size-9 items-center justify-center rounded-lg text-mute hover:text-ink">
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true" className={`transition-transform duration-200 ${opened.includes(m.href) ? "" : "-rotate-90"}`}><path d="M6 9l6 6 6-6" /></svg>
                    </button>
                  )}
                </div>
                {m.sub && opened.includes(m.href) && (
                  <div className="flex flex-col pb-1 pl-11">
                    {m.sub.map((x) => (
                      <a key={x.href} href={x.href} tabIndex={open ? 0 : -1} className={`flex min-h-9 items-center rounded-lg px-2 text-[13px] no-underline ${hash === x.href || (x.href === "#/search" && hash.startsWith("#/search")) || (x.href === "#/settings" && hash === "#/system") ? "font-semibold text-ink" : "text-mute hover:text-ink"}`}><span className={HALO}>{tr(x.label)}</span></a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        {/* 左下の角から、アイコンのアメーバが放射状に広がる（開いているときだけ動く）。文字の後ろには回らない高さに */}
        <div className="pointer-events-none absolute bottom-0 left-0 h-[min(300px,40vh)] w-full" aria-hidden="true">
          <AmoebaBurst active={open} />
        </div>
      </div>
    </div>
  );
}

export function Nav({ current }: { current: string }) {
  const b = useBadges();
  return (
    <nav className="flex justify-around border-t border-line/60 pb-[max(env(safe-area-inset-bottom),14px)] pt-3 text-[11px] text-mute lg:fixed lg:inset-y-0 lg:left-0 lg:z-10 lg:w-[88px] lg:flex-col lg:justify-start lg:gap-7 lg:border-r lg:border-t-0 lg:bg-ground lg:pt-[max(env(safe-area-inset-top),28px)]">
      {TABS.map((t) => {
        const n = badgeOf(b, t.href) + (t.href === "#/" ? b.system : 0); // スマホではメニューのボタンが無いので、設定の数もチャットに足す
        return (
          <a
            key={t.href}
            href={t.href}
            className={`flex min-w-16 flex-col items-center gap-1 ${current === t.href ? "text-ink" : ""}`}
            aria-current={current === t.href ? "page" : undefined}
            aria-label={n ? `${tr(t.label)}（${n}）` : undefined}
          >
            <span className="relative">
              <Icon name={t.icon} />
              <Badge n={n} />
            </span>
            {tr(t.label)}
          </a>
        );
      })}
      {/* スマホは右へなぞって開く。広い画面だけ押して開ける入り口を置く。設定の承認待ちはここに数字 */}
      <button onClick={() => setDrawer(true)} className={`hidden min-w-16 flex-col items-center gap-1 lg:flex ${TABS.some((t) => t.href === current) ? "" : "text-ink"}`} aria-label={b.system ? `メニュー（設定に ${b.system}）` : "メニュー"}>
        <span className="relative">
          <Icon name="menu" />
          <Badge n={b.system} />
        </span>
        {tr("メニュー")}
      </button>
    </nav>
  );
}

export function Page({ title, right, children, current }: { title: string; right?: ReactNode; children: ReactNode; current: string }) {
  return (
    <div className={`h-full ${RAIL}`}>
      <div className={`${COL} flex h-full flex-col`}>
        <header className="flex items-center justify-between px-5 pb-1 pt-[max(env(safe-area-inset-top),18px)]">
          <h1 className="m-0 text-[22px] font-bold">{title}</h1>
          {right}
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
        <Nav current={current} />
      </div>
    </div>
  );
}
