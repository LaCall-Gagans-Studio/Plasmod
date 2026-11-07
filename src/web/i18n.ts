// 画面の言語。文言は日本語をそのまま鍵にして t("チャット") と書き、英語は i18n-en.ts の辞書から引く。
// 辞書に無いものは日本語のまま出るので、画面を順に移していける。切り替えたら読み込み直す。
import { EN } from "./i18n-en";

export type Lang = "ja" | "en";
const KEY = "plasmod-lang";

function initial(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "en") return v;
  } catch {
    /* 覚えられない端末は日本語 */
  }
  // 英語の画面はまだ一部だけ（v4.0 で全部を移す）。選ばない限り日本語
  return "ja";
}

export const lang: Lang = typeof localStorage === "undefined" ? "ja" : initial();

/** 日本語の文言を、今の言語にする */
export const translate = (ja: string, to: Lang): string => (to === "en" ? (EN[ja] ?? ja) : ja);
export const t = (ja: string): string => translate(ja, lang);

export function setLang(next: Lang) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* この回だけ切り替わる */
  }
  location.reload();
}

if (typeof document !== "undefined") document.documentElement.lang = lang;
