/**
 * スマホでソフトウェアキーボードが開いている間、<html data-kbd> を付ける。
 * 画面の高さを確保するため、チャット画面の上のカードと下のバーが `.kbd-fold` で畳まれる（styles.css）。
 * 判定: 文字を打つ欄にフォーカスがあり、かつ表示領域がキーボードを出す前より 120px 以上縮んでいる。
 * 外付けキーボードやデスクトップでは領域が縮まないので反応しない。
 */
export function startKeyboardWatch() {
  const vv = window.visualViewport;
  if (!vv) return;
  let base = Math.max(innerHeight, vv.height);
  const editing = () => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) return false;
    if (el.isContentEditable) return true;
    if (el instanceof HTMLTextAreaElement) return !el.readOnly;
    if (el instanceof HTMLInputElement) return !el.readOnly && /^(text|search|email|url|tel|password|number|)$/.test(el.type);
    return false;
  };
  const update = () => {
    const focused = editing();
    // 何も打っていない間の高さを「キーボード無し」の高さとして覚える（向きの変更にも追従する）
    if (!focused) base = vv.height;
    else base = Math.max(base, vv.height);
    const open = focused && base - vv.height > 120;
    document.documentElement.toggleAttribute("data-kbd", open);
  };
  vv.addEventListener("resize", update);
  addEventListener("focusin", update);
  // 欄から欄へ移るときに一瞬閉じないよう、focusout は次のフレームで見る
  addEventListener("focusout", () => requestAnimationFrame(update));
  addEventListener("orientationchange", () => {
    base = 0;
    setTimeout(update, 300);
  });
}
