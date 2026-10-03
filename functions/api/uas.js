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

export async function onRequestGet() {
  const list = Object.entries(UA_LIBRARY).map(([id, info]) => ({
    id,
    ua: info.ua,
    isBrowser: info.ua.includes("Mozilla") || info.ua.includes("Chrome"),
  }));
  return new Response(JSON.stringify(list), {
    headers: { "Content-Type": "application/json" },
  });
}
