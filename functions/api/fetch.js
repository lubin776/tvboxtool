// 默认 UA 库
const UA_LIBRARY = {
  okhttp3: { ua: "okhttp/3.15", xrw: "" },
  android10: { ua: "Dalvik/2.1.0 (Linux; U; Android 10; MI 9 Build/QKQ1.190825.002)", xrw: "com.tvbox.osc" },
  android11: { ua: "Dalvik/2.1.0 (Linux; U; Android 11; Pixel 5 Build/RQ3A.210805.001)", xrw: "com.tvbox.osc" },
  android12: { ua: "Dalvik/2.1.0 (Linux; U; Android 12; SM-G998B Build/SP1A.210812.016)", xrw: "com.tvbox.osc" },
  chrome: { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36", xrw: "" },
  edge: { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36 Edg/115.0.0.0", xrw: "" },
  firefox: { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0", xrw: "" },
  safari: { ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1", xrw: "" }
};

function isBrowserUA(ua) {
  return /Mozilla|Chrome|Safari|Firefox|Edge/i.test(ua);
}

// 简单的解密占位函数（保持你原有的逻辑）
async function decryptAndProcess(data, target) {
  // 这里假设你原有解密逻辑，直接返回原数据如果不需要解密
  return data; 
}

async function tryFetchOnce(targetUrl, uaInfo) {
  const headers = {
    "User-Agent": uaInfo.ua,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
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

    // ===== 修复中文乱码核心代码 =====
    const arrayBuffer = await resp.arrayBuffer();
    const text = new TextDecoder("utf-8").decode(arrayBuffer);
    // =============================

    if (!text || text.length < 20) throw new Error("响应内容过短");
    if (text.trim().startsWith("<!DOCTYPE html") || text.trim().startsWith("<html")) {
      throw new Error("返回了 HTML 页面而非接口数据");
    }

    return { success: true, data: text, finalUrl: resp.url };
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === "AbortError" ? "超时 (15s)" : err.message);
  }
}

export async function onRequestPost(context) {
  const { request } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "无效的 JSON" }), { status: 400 });
  }

  const { target, uas: selectedUas } = body;
  if (!target) {
    return new Response(JSON.stringify({ error: "缺少 target 参数" }), { status: 400 });
  }

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

  const browserItems = queue.filter(u => isBrowserUA(u.ua));
  const nonBrowserItems = queue.filter(u => !isBrowserUA(u.ua));
  queue = [...nonBrowserItems, ...browserItems];

  if (queue.length === 0) {
    return new Response(JSON.stringify({ error: "UA 队列为空" }), { status: 400 });
  }

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
        
        // 解密处理 (await 已修复)
        const processed = await decryptAndProcess(result.data, target);

        send({
          type: "success",
          ua: uaInfo.ua,
          finalUrl: result.finalUrl,
          dataLength: processed.length,
        });
        send({ type: "data", content: processed });
      } catch (err) {
        send({ type: "failed", ua: uaInfo.ua, error: err.message });
      }
    }

    send({ type: "end" });
    writer.close();
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "application/json; charset=utf-8", // 明确声明 UTF-8
      "Transfer-Encoding": "chunked",
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
