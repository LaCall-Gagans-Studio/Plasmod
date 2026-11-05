// 最初の描画の前にテーマを決めて、白→黒のちらつきを出さない（theme.ts と同じ決め方）
try {
  var t = localStorage.getItem("gh-theme");
  document.documentElement.dataset.theme = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
} catch (e) {
  document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
