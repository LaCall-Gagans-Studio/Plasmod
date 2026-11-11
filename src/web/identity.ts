// アプリの名前・持ち主・開発エージェントの呼び名（/api/about）。起動のときに1回読み、端末に覚える
import { useSyncExternalStore } from "react";
import { setTimeZone } from "../shared/time";

export interface About {
  name: string;
  version: string;
  owner: string;
  ownerIsDefault: boolean;
  /** PR の依頼先の名前 */
  devAgent: string;
  /** Claude Code のエージェントの名前（入れていなければ null） */
  claudeAgent?: string | null;
  /** GitHub を設定しているか（開発の画面を出すか） */
  github?: boolean;
  /** 持ち主のカード */
  ownerTitle?: string;
  ownerColor?: string;
  ownerAvatar?: string;
  joinedAt?: number;
  /** 使ったトークンの総数（生き物の育ち具合） */
  tokensTotal?: number;
  /** 初回の案内を終えたか */
  setupDone?: boolean;
  developer: string;
  repoUrl: string;
  license: string;
  timeZone?: string;
}

const KEY = "gh-about";
const FALLBACK: About = { name: "Plasmod", version: "", owner: "オーナー", ownerIsDefault: false, devAgent: "開発", developer: "", repoUrl: "", license: "MIT" };

function read(): About {
  try {
    return { ...FALLBACK, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<About>) };
  } catch {
    return FALLBACK;
  }
}

let about: About = typeof localStorage === "undefined" ? FALLBACK : read();
setTimeZone(about.timeZone);
export const getAbout = () => about;
export const ownerName = () => about.owner;
export const devAgentName = () => about.devAgent;
export const claudeName = () => about.claudeAgent ?? "Claude Code";

export async function loadAbout() {
  try {
    const r = await fetch("/api/about");
    if (!r.ok) return;
    about = (await r.json()) as About;
    setTimeZone(about.timeZone);
    for (const fn of listeners) fn();
    localStorage.setItem(KEY, JSON.stringify(about));
  } catch {
    /* 前回の値のまま */
  }
}

const listeners = new Set<() => void>();
/** 名前などが読み込まれたら描き直す */
export function useAbout(): About {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => about,
  );
}

/** 初回の案内を終える */
export async function finishSetup() {
  const r = await fetch("/api/setup/done", { method: "POST" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await loadAbout();
}

/** 呼び名を変える */
export async function saveOwner(owner: string) {
  const r = await fetch("/api/about", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner }) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await loadAbout();
}
