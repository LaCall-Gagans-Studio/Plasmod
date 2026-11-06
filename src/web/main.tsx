import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { applyTheme } from "./theme";
import { startMemoSync } from "./memo-db";
import { startTaskSync } from "./task-db";
import { startVersionWatch } from "./version";
import { loadAbout } from "./identity";
import { burst } from "./loading";

applyTheme();
void loadAbout();
startVersionWatch();

// 起動画面のアメーバから、画面いっぱいに広がって最初の画面へ
if (document.querySelector(".gh-splash")) burst();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
    // オフラインで開く画面を、先に読んでキャッシュに入れておく
    setTimeout(() => {
      void import("./Projects");
      void import("./MemoPage");
      void import("./VoiceMemo");
    }, 3000);
  });
}
startMemoSync();
startTaskSync();
