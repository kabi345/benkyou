function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [_, a, b] = ipv4.map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  if (h.startsWith("[") || h.includes(":")) return true;
  return false;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderErrorPage(url, msg) {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><style>
    body{font-family:sans-serif;background:#17191d;color:#f1f5f9;display:grid;place-items:center;min-height:90vh;margin:0;padding:20px;text-align:center}
    .box{max-width:480px;background:#20242b;padding:24px;border-radius:12px;border:1px solid #353a42}
    a{color:#60a5fa}
  </style></head><body><div class="box"><h3>ページを表示できませんでした</h3><p>${escapeHtml(msg)}</p><p style="font-size:12px;color:#94a3b8;word-break:break-all">${escapeHtml(url)}</p><p><a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">新しいタブで直接開く ↗</a></p></div></body></html>`;
}

export default async function handler(req, res) {
  const targetRaw = String(req.query?.url || "").trim();
  if (!targetRaw) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(400).send("URLが指定されていません。");
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetRaw);
    if (!["http:", "https:"].includes(targetUrl.protocol)) throw new Error();
    if (isBlockedHost(targetUrl.hostname)) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(403).send("このアドレスは表示できません。");
    }
  } catch {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(400).send("無効なURLです。");
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl.href, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
      }
    });
  } catch {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(502).send(renderErrorPage(targetUrl.href, "サイトへの接続に失敗しました。"));
  }

  const finalUrl = new URL(upstream.url || targetUrl.href);
  if (isBlockedHost(finalUrl.hostname)) {
    return res.status(403).send("リダイレクト先は表示できません。");
  }

  const contentType = (upstream.headers.get("content-type") || "").toLowerCase();

  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    if (contentType) res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=300");
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.status(upstream.status).send(buf);
  }

  let html = await upstream.text();
  html = html.replace(/<meta[^>]+http-equiv=["']?(?:Content-Security-Policy|X-Frame-Options|Refresh)["']?[^>]*>/gi, "");
  html = html.replace(/<base\b[^>]*>/gi, "");

  const baseHref = finalUrl.href;
  const injectedHead = `
<base href="${escapeAttr(baseHref)}">
<style>
  .__kabi_anon_bar {
    position: sticky; top: 0; z-index: 2147483647;
    background: #1e242d; color: #e2e8f0; font-family: system-ui, -apple-system, sans-serif;
    font-size: 12px; padding: 6px 14px; border-bottom: 1px solid #334155;
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
  }
  .__kabi_anon_badge {
    background: #0d9488; color: #fff; font-weight: 700; padding: 2px 8px; border-radius: 999px; font-size: 11px;
  }
  .__kabi_anon_url {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #94a3b8; flex: 1;
  }
</style>
<script>
(function() {
  const BASE = ${JSON.stringify(baseHref)};
  function toAbs(u) {
    try { return new URL(u, BASE).href; } catch { return null; }
  }
  document.addEventListener("click", function(e) {
    const a = e.target.closest("a[href]");
    if (!a) return;
    const rawHref = a.getAttribute("href");
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) return;
    const abs = toAbs(rawHref);
    if (!abs || (!abs.startsWith("http://") && !abs.startsWith("https://"))) return;
    e.preventDefault();
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "kabi-navigate", url: abs }, "*");
    } else {
      location.href = "/api/view?url=" + encodeURIComponent(abs);
    }
  }, true);

  document.addEventListener("submit", function(e) {
    const form = e.target;
    if (!form || (form.method && form.method.toLowerCase() !== "get")) return;
    const action = form.getAttribute("action") || BASE;
    const abs = toAbs(action);
    if (!abs) return;
    e.preventDefault();
    const u = new URL(abs);
    const fd = new FormData(form);
    for (const [k, v] of fd.entries()) {
      if (typeof v === "string") u.searchParams.set(k, v);
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "kabi-navigate", url: u.href }, "*");
    } else {
      location.href = "/api/view?url=" + encodeURIComponent(u.href);
    }
  }, true);
})();
</script>
`;

  const bannerHtml = `
<div class="__kabi_anon_bar">
  <span class="__kabi_anon_badge">🛡️ 匿名ビュー (Anonymous View)</span>
  <span class="__kabi_anon_url">${escapeHtml(finalUrl.href)}</span>
</div>
`;

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => m + injectedHead);
  } else {
    html = injectedHead + html;
  }

  if (/<body[^>]*>/i.test(html)) {
    html = html.replace(/<body[^>]*>/i, (m) => m + bannerHtml);
  } else {
    html = bannerHtml + html;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(html);
}
