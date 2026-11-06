// アプリの名前・持ち主・開発エージェントの呼び名（/api/about）。起動のときに1回読み、端末に覚える
import { setTimeZone } from "../shared/time";

export interface About {
  name: string;
  version: string;
  owner: string;
  ownerIsDefault: boolean;
  devAgent: string;
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

export async function loadAbout() {
  try {
    const r = await fetch("/api/about");
    if (!r.ok) return;
    about = (await r.json()) as About;
    setTimeZone(about.timeZone);
    localStorage.setItem(KEY, JSON.stringify(about));
  } catch {
    /* 前回の値のまま */
  }
}

/** 呼び名を変える */
export async function saveOwner(owner: string) {
  const r = await fetch("/api/about", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner }) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await loadAbout();
}
