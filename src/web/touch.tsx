// 操作の共通部品（v2.0 D1）: 長押し・コピー・小さな知らせ・振動。
// 動きの決まりは styles.css の「動きの決まり」にまとめている。
import { type HTMLAttributes, type ReactNode, useRef, useSyncExternalStore } from "react";

const HAPTIC = { tap: 8, success: [10, 40, 10], error: [30, 50, 30] } as const;
export function haptic(kind: keyof typeof HAPTIC = "tap") {
  navigator.vibrate?.(HAPTIC[kind] as number | number[]);
}

// ---- 小さな知らせ ----
export type ToastTone = "ok" | "error";
export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
}
const TOAST_MS = 2200;
let toasts: ToastItem[] = [];
let nextToast = 1;
const toastListeners = new Set<() => void>();
const emitToasts = () => {
  for (const fn of toastListeners) fn();
};

export function toast(text: string, tone: ToastTone = "ok"): number {
  const id = nextToast++;
  toasts = [...toasts.slice(-2), { id, text, tone }]; // 同時に出すのは3つまで
  emitToasts();
  setTimeout(() => dismissToast(id), TOAST_MS);
  return id;
}

export function dismissToast(id: number) {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emitToasts();
}

export const currentToasts = () => toasts;

/** App に1つだけ置く */
export function Toaster() {
  const items = useSyncExternalStore(
    (fn) => {
      toastListeners.add(fn);
      return () => void toastListeners.delete(fn);
    },
    currentToasts,
  );
  if (!items.length) return null;
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+84px)] z-[70] flex flex-col items-center gap-1.5 px-4">
      {items.map((t) => (
        <div key={t.id} className={`gh-toast max-w-full truncate rounded-full px-3.5 py-2 font-sans text-[13px] shadow-lg ${t.tone === "error" ? "bg-red-ink text-white" : "bg-ink text-ground"}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---- コピー ----
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http（開発）など clipboard が使えないとき
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** コピーして、結果を知らせる */
export async function copyWithToast(text: string, label = text): Promise<boolean> {
  const ok = await writeClipboard(text);
  haptic(ok ? "success" : "error");
  toast(ok ? `${label} をコピーした` : "コピーできなかった", ok ? "ok" : "error");
  return ok;
}

// ---- 長押し ----
const LONG_PRESS_MS = 450;

/** 長押し（PC は右クリック）。指が動いたらやめる。長押しのあとの click は止める */
export function useLongPress(onLong: () => void, opts: { stop?: boolean } = {}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  const fire = () => {
    clear();
    if (fired.current) return;
    fired.current = true;
    haptic("tap");
    onLong();
  };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (opts.stop) e.stopPropagation(); // 外側の長押し（行のメニュー）を起こさない
      fired.current = false;
      if (e.button !== 0) return;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(fire, LONG_PRESS_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu: (e: React.MouseEvent) => {
      if (opts.stop) e.stopPropagation();
      e.preventDefault();
      fire();
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!fired.current) return;
      e.preventDefault();
      e.stopPropagation();
      fired.current = false;
    },
  };
}

/** タスク番号など。長押しでコピーする（リンクの中でも、押すだけならリンクのまま） */
export function CopyRef({ text, children, className = "", ...rest }: { text: string; children?: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  const press = useLongPress(() => void copyWithToast(text), { stop: true });
  return (
    <span {...rest} {...press} className={`gh-nocallout ${className}`}>
      {children ?? text}
    </span>
  );
}
