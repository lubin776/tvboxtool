// ============================================================
// CF Pages Function: /api/fetch
// 模拟 TVBox 访问，逐个 UA 尝试，流式返回
// 已加 CORS，支持前端部署在其他服务器
// 不做 Content-Type 过滤，任何响应都读成文本交给 decode 层
// ============================================================

import { decryptAndProcess } from '../lib/decrypt.js';

/* ============ CORS 白名单（改成你的域名） ============ */
const ALLOWED_ORIGINS = [
  "https://2.cdz.qzz.io",          // A 版（同源）
  "https://你的前端域名.com",       // ← B 版，改成真的
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://127.0.0.1:5500",
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

/* ============ UA 库 ============ */
const UA_LIBRARY = {
  "okhttp315": { ua: "okhttp/3.15", xrw: "com.iptvbox" },
  "okhttp493": { ua: "okhttp/4.9.3", xrw: "com.iptvbox" },
  "tvbox100":  { ua: "TVBox/1.0.0", xrw: "com.iptvbox" },
  "tvboxgit":  { ua: "com.github.tvbox", xrw: "com.iptvbox" },
  "dalvik":    { ua: "Dalvik/2.1.0 (Linux; U; Android 9; Pixel 3 XL Build/PQ3A.190801.002)", xrw: "com.iptvbox" },
  "chrome":    { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", xrw: "" },
  "firefox":   { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0", xrw: "" },
  "safari":    { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15", xrw: "" },
};

const BROWSER_KEYWORDS = ["Mozilla", "Chrome", "Firefox", "Safari", "Edge"];

function isBrowserUA(ua) {
  return BROWSER_KEYWORDS.some(kw => ua.includes(kw));
}

async function tryFetchOnce(targetUrl, uaInfo) {
  const headers = {
    "User-Agent": uaInfo.ua,
    "Accept": "*/*",
    "Connection": "keep-alive",
  };
  if (uaInfo.xrw) headers["X-Requested-With"] = uaInfo.xrw;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(targetUrl, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    // 不做任何 Content-Type 过滤，原样读成文本
    const text = await resp.text();
    if (!text || text.length < 5) throw new Error("响应内容过短");

    return {
      success: true,
      data: text,
      finalUrl: resp.url,
      contentType: resp.headers.get("content-type") || "",
    };
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === "AbortError" ? "超时 (15s)" : err.message);
  }
}

/* ============ POST /api/fetch ============ */
export async function onRequestPost(context) {
  const { request } = context;
  const origin = request.headers.get("Origin") || "";

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "无效的 JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  const { target, uas: selectedUas } = body;
  if (!target) {
    return new Response(JSON.stringify({ error: "缺少 target 参数" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  // 构建 UA 队列
  let queue = [];
  if (selectedUas && selectedUas.length > 0) {
    for (const item of selectedUas) {
      if (UA_LIBRARY[item]) {
        queue.push(UA_LIBRARY[item]);
      } else if (typeof item === "string" && item.length > 10) {
        queue.push({ ua: item, xrw: "" });
      }
    }
  } else {
    queue = Object.values(UA_LIBRARY).filter(u => !isBrowserUA(u.ua));
  }

  // 浏览器 UA 强制置后
  const browserItems = queue.filter(u => isBrowserUA(u.ua));
  const nonBrowserItems = queue.filter(u => !isBrowserUA(u.ua));
  queue = [...nonBrowserItems, ...browserItems];

  if (queue.length === 0) {
    return new Response(JSON.stringify({ error: "UA 队列为空" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  // 流式响应
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    const send = (obj) => {
      writer.write(encoder.encode(JSON.stringify(obj) + "\n"));
    };

    send({ type: "start", total: queue.length, target });

    for (let i = 0; i < queue.length; i++) {
      const uaInfo = queue[i];
      send({ type: "trying", index: i + 1, total: queue.length, ua: uaInfo.ua });

      try {
        const result = await tryFetchOnce(target, uaInfo);

        // ===== 后置处理：删注释/删空白/多层解码 =====
        const { data: processed, trace } = await decryptAndProcess(result.data, target);

        send({
          type: "success",
          ua: uaInfo.ua,
          finalUrl: result.finalUrl,
          contentType: result.contentType,
          rawLength: result.data.length,
          dataLength: processed.length,
        });

        if (trace && trace.length) {
          send({ type: "trace", steps: trace });
        }

        send({ type: "data", content: processed });
        break;
      } catch (err) {
        send({ type: "failed", ua: uaInfo.ua, error: err.message });
      }
    }

    send({ type: "end" });
    writer.close();
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "X-Accel-Buffering": "no",
      "Cache-Control": "no-cache",
      ...corsHeaders(origin),
    },
  });
}

/* ============ OPTIONS 预检 ============ */
export async function onRequestOptions(context) {
  const origin = context.request.headers.get("Origin") || "";
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}