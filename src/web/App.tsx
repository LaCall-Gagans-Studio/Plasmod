import { lazy, Suspense, useEffect, useState } from "react";
import { useSnapshot } from "./api";
import { SessionMenu } from "./sessionmenu";
import { TaskMenu } from "./taskmenu";
import { MemoMenu, ProjectMenu } from "./pjmenus";
import { Drawer } from "./ui";
import { useStale } from "./version";
import { Home } from "./Home";
import { OpenLastSession, SessionPage } from "./Session";
import { Toaster } from "./touch";
import { AmoebaLoader } from "./loading";
import { useAbout } from "./identity";

// メモはエディタ（CodeMirror）が大きいので、開いたときに読み込む
// ホームに要らない画面は、最初の読み込みから外す（起動のスクリプトを軽くする）。表示のあと手すきに先読みする
const loadCardView = () => import("./CardView");
const CardView = lazy(() => loadCardView().then((m) => ({ default: m.CardView })));
const loadReport = () => import("./Report");
const Report = lazy(() => loadReport().then((m) => ({ default: m.Report })));
const loadRoot = () => import("./Root");
const Root = lazy(() => loadRoot().then((m) => ({ default: m.Root })));
const loadSearch = () => import("./Search");
const Search = lazy(() => loadSearch().then((m) => ({ default: m.Search })));
const loadShare = () => import("./Share");
const Share = lazy(() => loadShare().then((m) => ({ default: m.Share })));
const loadSystem = () => import("./System");
const System = lazy(() => loadSystem().then((m) => ({ default: m.System })));
const loadTaskView = () => import("./Task");
const TaskView = lazy(() => loadTaskView().then((m) => ({ default: m.TaskView })));
const loadWatching = () => import("./Watching");
const Watching = lazy(() => loadWatching().then((m) => ({ default: m.Watching })));
const loadWatchPage = () => import("./WatchPage");
const WatchPage = lazy(() => loadWatchPage().then((m) => ({ default: m.WatchPage })));
const loadWelcome = () => import("./Welcome");
const Welcome = lazy(() => loadWelcome().then((m) => ({ default: m.Welcome })));
const PRELOAD = [loadCardView, loadReport, loadRoot, loadSearch, loadShare, loadSystem, loadTaskView, loadWatching, loadWatchPage, loadWelcome, () => import("./MemoPage"), () => import("./Projects")];
const MemoPage = lazy(() => import("./MemoPage").then((m) => ({ default: m.MemoPage })));
const VoiceMemo = lazy(() => import("./VoiceMemo").then((m) => ({ default: m.VoiceMemo })));
const PjShell = lazy(() => import("./Projects").then((m) => ({ default: m.PjShell })));
const PjSettings = lazy(() => import("./Projects").then((m) => ({ default: m.PjSettings })));
const Calendar = lazy(() => import("./Calendar").then((m) => ({ default: m.Calendar })));
const Habits = lazy(() => import("./Habits").then((m) => ({ default: m.Habits })));
const ProjectPage = lazy(() => import("./Projects").then((m) => ({ default: m.ProjectPage })));
const loading = <AmoebaLoader />;

function useHash() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}

/** 開いている間に新しい版が出たら、上に小さく出す（押すと読み込み直す） */
function UpdateBar() {
  const stale = useStale();
  if (!stale) return null;
  return (
    <button
      onClick={() => location.reload()}
      className="fixed left-1/2 top-[max(env(safe-area-inset-top),8px)] z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-[12.5px] font-semibold text-paper shadow-lg"
    >
      新しい版があります — 押して更新
    </button>
  );
}

export function App() {
  // 最初の表示が済んだら、手すきのときに残りの画面を順に先読みする（開くときに待たせない）
  useEffect(() => {
    let alive = true;
    const run = async () => {
      for (const load of PRELOAD) {
        if (!alive) return;
        await load().catch(() => {});
      }
    };
    const idle = (cb: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(cb, { timeout: 4000 }) : setTimeout(cb, 1500));
    const t = setTimeout(() => idle(() => void run()), 1200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []);
  return (
    <>
      <UpdateBar />
      <Toaster />
      <Suspense fallback={loading}>
        <Routes />
      </Suspense>
      <Drawer />
      <TaskMenu />
      <MemoMenu />
      <ProjectMenu />
      <SessionMenu />
    </>
  );
}

function Routes() {
  const hash = useHash();
  const { snap, online } = useSnapshot();
  if (useAbout().setupDone === false) return <Welcome />;
  if (hash.startsWith("#/card/")) return <CardView snap={snap} cardKey={decodeURIComponent(hash.slice("#/card/".length))} />;
  if (hash === "#/watching" || hash === "#/dev") return <Watching snap={snap} />;
  const task = hash.match(/^#\/task\/([A-Za-z0-9_-]{1,64})$/);
  if (task) return <TaskView snap={snap} id={task[1]} />;
  if (hash === "#/report") return <Report snap={snap} />;
  if (hash === "#/watch") return <WatchPage snap={snap} />;
  const share = hash.match(/^#\/share\/([0-9a-f]{24}|error)/);
  if (share) return <Share id={share[1]} />;
  if (hash === "#/session") return <OpenLastSession />;
  const ses = hash.match(/^#\/session\/([a-z0-9_-]+)\/(.+)$/);
  if (ses) return <SessionPage snap={snap} agent={ses[1]} id={decodeURIComponent(ses[2])} />;
  if (hash.startsWith("#/search")) return <Search snap={snap} />;
  const root = hash.match(/^#\/root(?:\/([0-9]{14}-[0-9a-f]{6}))?$/);
  if (root) return <Root id={root[1] ?? null} />;
  if (hash === "#/pj" || hash.startsWith("#/pj?")) return <Suspense fallback={loading}><PjShell snap={snap} view="pj" /></Suspense>;
  if (hash === "#/pj/settings") return <Suspense fallback={loading}><PjSettings /></Suspense>;
  const pj = hash.match(/^#\/pj\/([0-9]{1,15})(?:\?|$)/);
  if (pj) return <Suspense fallback={loading}><ProjectPage key={pj[1]} snap={snap} id={Number(pj[1])} /></Suspense>;
  if (hash === "#/todos" || hash.startsWith("#/todos?")) return <Suspense fallback={loading}><PjShell snap={snap} view="tasks" taskId={null} /></Suspense>;
  const todo = hash.match(/^#\/todo\/(-?[0-9]{1,18})(?:\?|$)/);
  if (todo) return <Suspense fallback={loading}><PjShell snap={snap} view="tasks" taskId={Number(todo[1])} /></Suspense>;
  if (hash === "#/memos" || hash.startsWith("#/memos?")) return <Suspense fallback={loading}><PjShell snap={snap} view="memos" /></Suspense>;
  if (hash.startsWith("#/memo/voice")) return <Suspense fallback={loading}><VoiceMemo /></Suspense>;
  const memo = hash.match(/^#\/memo\/(new|-?[0-9]{1,18})(?:\?|$)/);
  if (memo) return <Suspense fallback={loading}><MemoPage key={memo[1]} id={memo[1] === "new" ? "new" : Number(memo[1])} /></Suspense>;
  if (hash === "#/calendar") return <Suspense fallback={loading}><Calendar /></Suspense>;
  if (hash === "#/habits") return <Suspense fallback={loading}><Habits /></Suspense>;
  // システムは「設定」になった（#/system は古いリンク用）
  if (hash === "#/settings" || hash.startsWith("#/settings?") || hash === "#/system") return <System snap={snap} />;
  return <Home snap={snap} online={online} />;
}
