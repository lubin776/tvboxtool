// ============================================================
// CF Pages Function: /api/uas
// ============================================================

const UA_LIBRARY = {
  "okhttp315": { ua: "okhttp/3.15", xrw: "com.iptvbox" },
  "okhttp493": { ua: "okhttp/4.9.3", xrw: "com.iptvbox" },
  "tvbox100":  { ua: "TVBox/1.0.0", xrw: "com.iptvbox" },
  "tvboxgit":  { ua: "com.github.tvbox", xrw: "com.iptvbox" },
  "dalvik":    { ua: "Dalvik/2.1.0 (Linux; U; Android 9; Pixel 3 XL Build/PQ3A.190801.002)", xrw: "com.iptvbox" },
  "chrome":    { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", xrw: "" },
  "firefox":   { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0)", xrw: "" },
  "safari":    { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", xrw: "" },
};

const ALLOWED_ORIGINS = [
  "https://0.wudaozhe.net",
  "https://jm.wudaozhe.net",         
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://127.0.0.1:5500",
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export async function onRequestGet(context) {
  const origin = context.request.headers.get("Origin") || "";
  const list = Object.entries(UA_LIBRARY).map(([id, info]) => ({
    id,
    ua: info.ua,
    isBrowser: info.ua.includes("Mozilla") || info.ua.includes("Chrome"),
  }));
  return new Response(JSON.stringify(list), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

export async function onRequestOptions(context) {
  const origin = context.request.headers.get("Origin") || "";
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}