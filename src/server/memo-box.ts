// メモの ```html の箱を表示するページ。必ず sandbox（allow-scripts だけ）の iframe の中で開く。
// スクリプトは動くが、アプリとは別の扱い（opaque origin）なので Cookie・API・画面の中身には触れない。
// スクリプトからの通信は CSP で止める（https の画像だけ通す）。人が押した外部リンクは親（アプリ本体）に頼んで開く。Android の WebView は別窓を開けないので、枠の中の target=_blank は開かない。中身は親から postMessage で受け取り、URL にもサーバーにも載せない。

export const MEMO_BOX_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Type": "text/html; charset=utf-8",
};

export const MEMO_BOX_HTML = `<!doctype html>
<meta charset="utf-8">
<script>
addEventListener("message", function on(e) {
  if (e.source !== parent || !e.data || typeof e.data.html !== "string") return;
  removeEventListener("message", on);
  var dark = !!e.data.dark;
  var base = "<!doctype html><html data-theme=" + (dark ? "dark" : "light") + "><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><style>:root{color-scheme:" + (dark ? "dark" : "light") + "}html,body{margin:0}body{padding:12px;font:14px/1.7 system-ui,'Noto Sans JP',sans-serif;background:" + (dark ? "#15151a" : "#fff") + ";color:" + (dark ? "#f2f1ec" : "#17171a") + ";overflow-wrap:anywhere}img,svg{max-width:100%}</style>";
  var report = "<script>(function(){function r(){parent.postMessage({plasmodBox:'height',h:document.documentElement.scrollHeight},'*')}new ResizeObserver(r).observe(document.documentElement);addEventListener('load',r);document.addEventListener('toggle',r,true);document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href');if(h.indexOf('#/memo/')===0&&/^[0-9]+$/.test(h.slice(7))){e.preventDefault();parent.postMessage({plasmodBox:'open',hash:h},'*')}else if(h.toLowerCase().indexOf('https://')===0){e.preventDefault();parent.postMessage({plasmodBox:'external',href:h},'*')}else if(h.charAt(0)!=='#')e.preventDefault()});r()})()<\\/script>";
  document.open();
  document.write(base + e.data.html + report);
  document.close();
});
parent.postMessage({ plasmodBox: "ready" }, "*");
</script>
`;
