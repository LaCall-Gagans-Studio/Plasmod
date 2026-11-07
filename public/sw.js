// 画面のキャッシュ（v2.0 A）。電波や Tailscale が無くても画面を開けるようにする。
// API はキャッシュしない（メモの写しは IndexedDB、memo-sync.ts）。
// - 名前にハッシュが付く /assets/ は、一度取ったらずっと使う
// - それ以外の画面は、まずサーバーへ。届かなければキャッシュ
const CACHE = "gh-shell-v1";
const NETWORK_MS = 2500;
const MAX_ENTRIES = 200;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  ),
);

async function remember(key, res) {
  if (!res.ok || res.type === "opaque") return;
  const c = await caches.open(CACHE);
  await c.put(key, res);
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) if (!k.url.endsWith("/index.html")) await c.delete(k);
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  await remember(req, res.clone());
  return res;
}

/** サーバーを少しだけ待つ。遅ければキャッシュを見せて、届いた分は次のために覚える */
async function networkFirst(req, key) {
  const net = fetch(req).then(async (res) => {
    await remember(key, res.clone());
    return res;
  });
  const hit = await caches.match(key);
  if (!hit) return net;
  const late = new Promise((resolve) => setTimeout(() => resolve(hit), NETWORK_MS));
  return Promise.race([net.catch(() => hit), late]);
}

// Web Push: 届いたら通知を出す（iOS は必ず出さないと通知の権限を失う）
self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || "Plasmod", {
      body: d.body || "",
      tag: d.tag || undefined,
      renotify: !!d.tag,
      requireInteraction: !!d.urgent,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { path: d.path || "" },
    }),
  );
});

// 通知を押したら、その画面へ。開いている画面があれば使い回す
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const path = (e.notification.data && e.notification.data.path) || "";
  // 自分の画面の中だけ（# で始まる行き先）
  const url = new URL(`/${path.startsWith("#") ? path : ""}`, self.location.origin).href;
  e.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of list) {
        if (new URL(c.url).origin !== self.location.origin) continue;
        await c.focus();
        if ("navigate" in c) await c.navigate(url).catch(() => {});
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/share" || url.pathname === "/sw.js") return;
  if (url.pathname.startsWith("/assets/")) return e.respondWith(cacheFirst(req));
  // メモの html の箱は index.html にしない（オフラインでも開けるように覚える）
  if (url.pathname === "/memo-box") return e.respondWith(networkFirst(req, "/memo-box"));
  // 画面の移動はどの URL でも同じ index.html（?launch= などが付いていても）
  if (req.mode === "navigate") return e.respondWith(networkFirst(req, "/index.html"));
  e.respondWith(networkFirst(req, req));
});
