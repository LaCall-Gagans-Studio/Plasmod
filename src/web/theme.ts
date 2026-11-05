// 白・黒の切り替え。自動ならスマホの設定に合わせる。選んだものはこの端末に覚える。
// 最初の描画の前に index.html の小さいスクリプトが同じ決め方で data-theme を付ける（白→黒のちらつきを出さない）
import { useEffect, useState } from "react";

export type ThemePref = "auto" | "light" | "dark";
const KEY = "gh-theme";
const dark = matchMedia("(prefers-color-scheme: dark)");

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function applyTheme(pref = themePref()) {
  const isDark = pref === "dark" || (pref === "auto" && dark.matches);
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    m.content = isDark ? "#0D0D0F" : "#F7F6F2";
    m.removeAttribute("media");
  }
}

dark.addEventListener("change", () => applyTheme());

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState(themePref);
  useEffect(() => applyTheme(pref), [pref]);
  return [
    pref,
    (p) => {
      try {
        if (p === "auto") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, p);
      } catch {
        /* 覚えられないときも、今の画面には効かせる */
      }
      setPref(p);
    },
  ];
}
