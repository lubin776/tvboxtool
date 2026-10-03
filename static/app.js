const UA_OPTIONS = [
  { id: "okhttp315", label: "okhttp/3.15 (TVBox)" },
  { id: "okhttp493", label: "okhttp/4.9.3 (TVBox)" },
  { id: "tvbox100",  label: "TVBox/1.0.0" },
  { id: "tvboxgit",  label: "com.github.tvbox" },
  { id: "dalvik",    label: "Dalvik/2.1.0 (Android 9)" },
  { id: "chrome",    label: "Chrome (浏览器兜底)" },
  { id: "firefox",   label: "Firefox (浏览器兜底)" },
  { id: "safari",    label: "Safari (浏览器兜底)" },
];

let fetchedData = "";

function renderUaList() {
  const list = document.getElementById("uaList");
  list.innerHTML = UA_OPTIONS.map(opt => `
    <label class="ua-item">
      <input type="checkbox" value="${opt.id}" checked>
      <span>${opt.label}</span>
    </label>
  `).join("");
}
renderUaList();

function getSelectedUas() {
  return Array.from(document.querySelectorAll(".ua-item input:checked")).map(cb => cb.value);
}

function selectAll() {
  document.querySelectorAll(".ua-item input").forEach(cb => cb.checked = true);
}
function selectNone() {
  document.querySelectorAll(".ua-item input").forEach(cb => cb.checked = false);
}
function selectTvbox() {
  selectNone();
  ["okhttp315","okhttp493","tvbox100","tvboxgit","dalvik"].forEach(id => {
    const cb = document.querySelector(`.ua-item input[value="${id}"]`);
    if (cb) cb.checked = true;
  });
}
function selectWithBrowser() {
  selectTvbox();
  ["chrome","firefox","safari"].forEach(id => {
    const cb = document.querySelector(`.ua-item input[value="${id}"]`);
    if (cb) cb.checked = true;
  });
}

function log(msg, type = "info") {
  const el = document.getElementById("log");
  const div = document.createElement("div");
  div.className = type;
  const time = new Date().toLocaleTimeString();
  div.textContent = `[${time}] ${msg}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function clearLog() {
  document.getElementById("log").innerHTML = "";
}

async function startFetch() {
  const target = document.getElementById("target").value.trim();
  if (!target) { alert("请输入目标接口 URL"); return; }

  const backend = window.location.origin;
  const selected = getSelectedUas();
  if (selected.length === 0) { alert("请至少选择一个 UA"); return; }

  const btn = document.getElementById("startBtn");
  btn.disabled = true;
  document.getElementById("resultCard").style.display = "none";
  fetchedData = "";
  clearLog();

  log(`目标: ${target}`, "info");
  log(`已选 UA: ${selected.length} 个`, "info");

  try {
    const response = await fetch(`${backend}/api/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, uas: selected }),
    });

    if (!response.ok) {
      log(`请求失败: HTTP ${response.status}`, "error");
      btn.disabled = false;
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);

        switch (msg.type) {
          case "start":
            log(`开始尝试，共 ${msg.total} 个 UA`, "info");
            break;
          case "trying":
            log(`[${msg.index}/${msg.total}] 尝试: ${msg.ua.slice(0, 50)}...`, "trying");
            break;
          case "failed":
            log(`✗ ${msg.ua.slice(0, 30)}... → ${msg.error}`, "failed");
            break;
          case "success":
            log(`✓ 成功! UA: ${msg.ua.slice(0, 40)}`, "success");
            break;
          case "data":
            fetchedData = msg.content;
            document.getElementById("result").textContent = msg.content.slice(0, 5000);
            document.getElementById("resultCard").style.display = "block";
            break;
          case "error":
            log(`✗ ${msg.message}`, "error");
            break;
          case "end":
            log("完成", "info");
            break;
        }
      }
    }
  } catch (err) {
    log(`连接错误: ${err.message}`, "error");
  }

  btn.disabled = false;
}

function copyData() {
  if (!fetchedData) return;
  navigator.clipboard.writeText(fetchedData);
  log("已复制到剪贴板", "success");
}

function downloadData() {
  if (!fetchedData) return;
  const blob = new Blob([fetchedData], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tvbox_api_${Date.now()}.json`;
  a.click();
}
