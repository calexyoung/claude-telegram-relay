/**
 * Claude Relay Dashboard — Frontend
 *
 * Vanilla JS SPA with auto-refresh.
 * Fetches from /api/dashboard/* endpoints.
 */

const API = "/api/dashboard";
let refreshTimer = null;
let currentTab = "overview";
let availableModels = {};

// ── Navigation ──────────────────────────────────────────────

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    switchTab(item.dataset.tab);
  });
});

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach((t) => t.classList.remove("active"));
  document.querySelector(`.nav-item[data-tab="${tab}"]`)?.classList.add("active");
  document.getElementById(`tab-${tab}`)?.classList.add("active");
  loadTabData(tab);
}

function loadTabData(tab) {
  switch (tab) {
    case "overview": loadOverview(); break;
    case "logs": loadLogs(); break;
    case "errors": loadErrors(); break;
    case "messages": loadMessages(); break;
    case "memory": loadMemory(); break;
    case "actions": loadActions(); break;
    case "models": loadModelsPage(); break;
    case "services": loadServices(); break;
  }
}

// ── API Helpers ─────────────────────────────────────────────

async function api(path, opts) {
  try {
    const res = await fetch(`${API}/${path}`, opts);
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`API error: ${path}`, err);
    return null;
  }
}

function formatTime(iso) {
  if (!iso) return "--";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(iso) {
  if (!iso) return "--";
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatDateTime(iso) {
  if (!iso) return "--";
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatTokens(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toString();
}

function formatCost(n) {
  if (!n) return "$0.00";
  if (n < 0.01) return "$" + n.toFixed(4);
  return "$" + n.toFixed(2);
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + " GB";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1024).toFixed(1) + " KB";
}

function formatUptime(seconds) {
  if (!seconds) return "--";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function emptyState(icon, text) {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><div class="empty-text">${text}</div></div>`;
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Health Check ────────────────────────────────────────────

async function checkHealth() {
  try {
    const res = await fetch("/health");
    if (res.ok) {
      document.getElementById("statusDot").className = "status-dot";
      document.getElementById("statusText").textContent = "Online";
      return await res.json();
    }
  } catch {}
  document.getElementById("statusDot").className = "status-dot offline";
  document.getElementById("statusText").textContent = "Offline";
  return null;
}

// ── Overview ────────────────────────────────────────────────

async function loadOverview() {
  const [stats, tokens, health, logs] = await Promise.all([
    api("stats"),
    api("tokens?range=24h"),
    checkHealth(),
    api("logs?limit=10"),
  ]);

  // Stats cards
  if (stats) {
    document.getElementById("statMessages").textContent = stats.messagesToday || 0;
    document.getElementById("statGoals").textContent = stats.activeGoals || 0;
    document.getElementById("statActions").textContent = stats.pendingActions || 0;
    document.getElementById("statErrors").textContent = stats.errorsToday || 0;
  }

  // Token summary
  const tokenEl = document.getElementById("overviewTokens");
  if (tokens && tokens.total) {
    const providers = Object.entries(tokens.byProvider || {});
    tokenEl.innerHTML = `
      <div style="margin-bottom:16px;">
        <div style="font-size:24px;font-weight:700;color:var(--accent-hover);">${formatTokens(tokens.total.tokens)}</div>
        <div style="font-size:12px;color:var(--text-muted);">tokens &middot; ${formatCost(tokens.total.cost)} total cost</div>
      </div>
      ${providers.map(([name, data]) => `
        <div class="breakdown-item">
          <span class="breakdown-label">${escapeHtml(name)}</span>
          <span class="breakdown-values">
            <span class="breakdown-tokens">${formatTokens(data.tokens)}</span>
            <span class="breakdown-cost">${formatCost(data.cost)}</span>
          </span>
        </div>
      `).join("")}
      ${providers.length === 0 ? '<div style="color:var(--text-muted);font-size:12px;">No token usage recorded yet</div>' : ""}
    `;
  } else {
    tokenEl.innerHTML = emptyState("&#128202;", "No token data yet");
  }

  // System info
  const sysEl = document.getElementById("overviewSystem");
  if (health) {
    sysEl.innerHTML = `
      <div class="breakdown-item">
        <span class="breakdown-label">Uptime</span>
        <span class="breakdown-values"><span class="breakdown-tokens">${formatUptime(health.uptime)}</span></span>
      </div>
      <div class="breakdown-item">
        <span class="breakdown-label">Memory (RSS)</span>
        <span class="breakdown-values"><span class="breakdown-tokens">${formatBytes(health.memory?.rss)}</span></span>
      </div>
      <div class="breakdown-item">
        <span class="breakdown-label">Heap Used</span>
        <span class="breakdown-values"><span class="breakdown-tokens">${formatBytes(health.memory?.heapUsed)}</span></span>
      </div>
      <div class="breakdown-item">
        <span class="breakdown-label">Forum Mode</span>
        <span class="breakdown-values"><span class="breakdown-tokens">${health.forumMode ? "Enabled" : "Disabled"}</span></span>
      </div>
      <div class="breakdown-item">
        <span class="breakdown-label">Fallback</span>
        <span class="breakdown-values"><span class="breakdown-tokens">${health.fallbackEnabled ? "Enabled" : "Disabled"}</span></span>
      </div>
      <div class="breakdown-item">
        <span class="breakdown-label">Last Message</span>
        <span class="breakdown-values"><span class="breakdown-tokens">${health.lastMessageAt ? formatDateTime(health.lastMessageAt) : "None"}</span></span>
      </div>
    `;
  } else {
    sysEl.innerHTML = emptyState("&#9888;", "Cannot reach health endpoint");
  }

  // Recent logs
  renderLogs(logs, document.getElementById("overviewLogs"));
}

// ── Logs ────────────────────────────────────────────────────

async function loadLogs() {
  const level = document.getElementById("logLevel")?.value || "";
  const search = document.getElementById("logSearch")?.value || "";
  const params = new URLSearchParams();
  if (level) params.set("level", level);
  if (search) params.set("search", search);
  params.set("limit", "200");

  const data = await api(`logs?${params}`);
  renderLogs(data, document.getElementById("logsContainer"));
}

function renderLogs(data, container) {
  if (!data || data.length === 0) {
    container.innerHTML = emptyState("&#9776;", "No logs found");
    return;
  }

  container.innerHTML = data.map((log) => `
    <div class="log-entry">
      <span class="log-time">${formatTime(log.created_at)}</span>
      <span class="log-level ${log.level || "info"}">${(log.level || "info").toUpperCase()}</span>
      <span class="log-event">${escapeHtml(log.event)}</span>
      <span class="log-message">${escapeHtml(log.message)}</span>
      ${log.duration_ms ? `<span class="log-duration">${log.duration_ms}ms</span>` : ""}
    </div>
  `).join("");
}

// ── Errors ──────────────────────────────────────────────────

async function loadErrors() {
  const data = await api("errors");
  if (!data) return;

  document.getElementById("errorTotal").textContent = data.totalErrors || 0;
  document.getElementById("errorRate").textContent = data.errorRate || 0;

  // Top events
  const topEl = document.getElementById("topErrorEvents");
  if (data.topEvents && data.topEvents.length > 0) {
    topEl.innerHTML = `<table class="data-table">
      <thead><tr><th>Event</th><th>Count</th></tr></thead>
      <tbody>${data.topEvents.map((e) => `
        <tr><td>${escapeHtml(e.event)}</td><td>${e.count}</td></tr>
      `).join("")}</tbody>
    </table>`;
  } else {
    topEl.innerHTML = emptyState("&#10003;", "No errors in the last 24 hours");
  }

  // Recent errors
  const recentEl = document.getElementById("recentErrors");
  if (data.recentErrors && data.recentErrors.length > 0) {
    recentEl.innerHTML = data.recentErrors.map((e) => `
      <div class="error-item">
        <div class="error-header">
          <span class="error-event">${escapeHtml(e.event)}</span>
          <span class="error-time">${formatDateTime(e.created_at)}</span>
        </div>
        <div class="error-message">${escapeHtml(e.message)}</div>
      </div>
    `).join("");
  } else {
    recentEl.innerHTML = emptyState("&#10003;", "No recent errors");
  }
}

// ── Messages ────────────────────────────────────────────────

async function loadMessages() {
  const agent = document.getElementById("msgAgent")?.value || "";
  const params = new URLSearchParams();
  if (agent) params.set("agent", agent);
  params.set("limit", "100");

  const data = await api(`messages?${params}`);
  const container = document.getElementById("messagesContainer");

  if (!data || data.length === 0) {
    container.innerHTML = emptyState("&#9993;", "No messages yet");
    return;
  }

  container.innerHTML = data.map((msg) => `
    <div class="message-item">
      <div class="message-avatar ${msg.role === "user" ? "user" : "assistant"}">
        ${msg.role === "user" ? "&#128100;" : "&#129302;"}
      </div>
      <div class="message-content">
        <div class="message-meta">
          <span class="message-role">${msg.role === "user" ? "You" : "Claude"}</span>
          ${msg.agent ? `<span class="message-agent">${escapeHtml(msg.agent)}</span>` : ""}
          <span class="message-time">${formatDateTime(msg.created_at)}</span>
        </div>
        <div class="message-text">${escapeHtml(msg.content)}</div>
      </div>
    </div>
  `).join("");
}

// ── Memory ──────────────────────────────────────────────────

async function loadMemory() {
  const data = await api("memory");
  if (!data) return;

  renderMemorySection(data.goals || [], document.getElementById("memoryGoals"), "goal", "No active goals");
  renderMemorySection(data.facts || [], document.getElementById("memoryFacts"), "fact", "No facts stored");
  renderMemorySection(data.preferences || [], document.getElementById("memoryPrefs"), "preference", "No preferences stored");
  renderMemorySection(data.completed || [], document.getElementById("memoryCompleted"), "completed", "No completed goals");
}

function renderMemorySection(items, container, type, emptyText) {
  if (!items || items.length === 0) {
    container.innerHTML = emptyState("&#9733;", emptyText);
    return;
  }

  container.innerHTML = `<div class="memory-grid">${items.map((item) => `
    <div class="memory-item ${type}">
      <div class="memory-type">${type}</div>
      <div class="memory-content">${escapeHtml(item.content)}</div>
      <div class="memory-meta">
        <span>${formatDateTime(item.created_at)}</span>
        ${item.deadline ? `<span>Due: ${formatDate(item.deadline)}</span>` : ""}
        ${item.priority ? `<span>Priority: ${item.priority}</span>` : ""}
        ${item.completed_at ? `<span>Completed: ${formatDateTime(item.completed_at)}</span>` : ""}
      </div>
    </div>
  `).join("")}</div>`;
}

// ── Actions ─────────────────────────────────────────────────

async function loadActions() {
  const data = await api("actions");
  if (!data) return;

  // Stats
  const stats = data.stats || {};
  document.getElementById("actionStats").innerHTML = `
    <div class="stat-card blue">
      <div class="label">Total Actions</div>
      <div class="value">${stats.total || 0}</div>
    </div>
    <div class="stat-card green">
      <div class="label">Approved</div>
      <div class="value">${stats.approved || 0}</div>
    </div>
    <div class="stat-card red">
      <div class="label">Denied</div>
      <div class="value">${stats.denied || 0}</div>
    </div>
    <div class="stat-card accent">
      <div class="label">Executed</div>
      <div class="value">${stats.executed || 0}</div>
    </div>
  `;

  // Pending
  const pendingEl = document.getElementById("pendingActions");
  if (data.pending && data.pending.length > 0) {
    pendingEl.innerHTML = `<table class="data-table">
      <thead><tr><th>Type</th><th>Description</th><th>Created</th><th>Status</th></tr></thead>
      <tbody>${data.pending.map((a) => `
        <tr>
          <td>${escapeHtml(a.type)}</td>
          <td>${escapeHtml(a.description || a.payload || "")}</td>
          <td>${formatDateTime(a.created_at)}</td>
          <td><span class="badge pending">Pending</span></td>
        </tr>
      `).join("")}</tbody>
    </table>`;
  } else {
    pendingEl.innerHTML = emptyState("&#10003;", "No pending actions");
  }

  // History
  const historyEl = document.getElementById("actionHistory");
  if (data.history && data.history.length > 0) {
    historyEl.innerHTML = `<table class="data-table">
      <thead><tr><th>Type</th><th>Description</th><th>Status</th><th>Date</th></tr></thead>
      <tbody>${data.history.map((a) => `
        <tr>
          <td>${escapeHtml(a.type)}</td>
          <td>${escapeHtml(a.description || a.payload || "")}</td>
          <td><span class="badge ${a.status}">${a.status}</span></td>
          <td>${formatDateTime(a.created_at)}</td>
        </tr>
      `).join("")}</tbody>
    </table>`;
  } else {
    historyEl.innerHTML = emptyState("&#128196;", "No action history");
  }
}

// ── Models & Costs ──────────────────────────────────────────

async function loadModelsPage() {
  await Promise.all([loadModelAssignment(), loadTokenStats(), loadCostTimeline()]);
}

async function loadModelAssignment() {
  const data = await api("models");
  if (!data) return;

  availableModels = data.available || {};
  const configs = data.configs || [];
  const container = document.getElementById("modelAssignment");

  // Populate message agent filter too
  const agentSelect = document.getElementById("msgAgent");
  if (agentSelect && agentSelect.options.length <= 1) {
    configs.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.agent;
      opt.textContent = c.agent;
      agentSelect.appendChild(opt);
    });
  }

  if (configs.length === 0) {
    container.innerHTML = emptyState("&#9881;", "No model configurations found");
    return;
  }

  const allProviders = Object.keys(availableModels);

  container.innerHTML = configs.map((cfg) => `
    <div class="model-row" data-agent="${escapeHtml(cfg.agent)}">
      <span class="model-agent">${escapeHtml(cfg.agent)}</span>
      <div class="model-selects">
        <select class="select model-provider" data-agent="${escapeHtml(cfg.agent)}" onchange="onProviderChange(this)">
          ${allProviders.map((p) => `<option value="${p}" ${p === cfg.provider ? "selected" : ""}>${p}</option>`).join("")}
        </select>
        <select class="select model-model" data-agent="${escapeHtml(cfg.agent)}">
          ${(availableModels[cfg.provider] || []).map((m) => `<option value="${m}" ${m === cfg.model ? "selected" : ""}>${m}</option>`).join("")}
        </select>
        <button class="btn sm primary" onclick="saveModel('${escapeHtml(cfg.agent)}')">Save</button>
      </div>
      <span class="model-status" id="model-status-${escapeHtml(cfg.agent)}"></span>
    </div>
  `).join("");
}

function onProviderChange(el) {
  const agent = el.dataset.agent;
  const provider = el.value;
  const models = availableModels[provider] || [];
  const modelSelect = document.querySelector(`.model-model[data-agent="${agent}"]`);
  if (modelSelect) {
    modelSelect.innerHTML = models.map((m) => `<option value="${m}">${m}</option>`).join("");
  }
}

async function saveModel(agent) {
  const provider = document.querySelector(`.model-provider[data-agent="${agent}"]`)?.value;
  const model = document.querySelector(`.model-model[data-agent="${agent}"]`)?.value;
  const statusEl = document.getElementById(`model-status-${agent}`);

  if (!provider || !model) return;

  statusEl.textContent = "Saving...";
  statusEl.style.color = "var(--text-muted)";

  const result = await api("models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent, provider, model }),
  });

  if (result && result.success) {
    statusEl.textContent = "Saved";
    statusEl.style.color = "var(--green)";
  } else {
    statusEl.textContent = "Error";
    statusEl.style.color = "var(--red)";
  }

  setTimeout(() => { statusEl.textContent = ""; }, 3000);
}

async function loadTokenStats() {
  const range = document.getElementById("tokenRange")?.value || "24h";
  const data = await api(`tokens?range=${range}`);
  if (!data) return;

  // Stat cards
  document.getElementById("tokenStatCards").innerHTML = `
    <div class="stat-card accent">
      <div class="label">Total Tokens</div>
      <div class="value">${formatTokens(data.total?.tokens)}</div>
    </div>
    <div class="stat-card green">
      <div class="label">Total Cost</div>
      <div class="value">${formatCost(data.total?.cost)}</div>
    </div>
  `;

  // Breakdown
  const breakdownEl = document.getElementById("tokenBreakdown");
  const sections = [
    { title: "By Provider", data: data.byProvider },
    { title: "By Agent", data: data.byAgent },
    { title: "By Model", data: data.byModel },
  ];

  breakdownEl.innerHTML = `<div class="breakdown-grid">${sections.map((section) => {
    const entries = Object.entries(section.data || {});
    if (entries.length === 0) return "";
    return `
      <div>
        <h4 style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px;">${section.title}</h4>
        ${entries.map(([name, vals]) => `
          <div class="breakdown-item">
            <span class="breakdown-label">${escapeHtml(name)}</span>
            <span class="breakdown-values">
              <span class="breakdown-tokens">${formatTokens(vals.tokens)}</span>
              <span class="breakdown-cost">${formatCost(vals.cost)}</span>
            </span>
          </div>
        `).join("")}
      </div>
    `;
  }).join("")}</div>`;
}

async function loadCostTimeline() {
  const period = document.getElementById("costPeriod")?.value || "day";
  const data = await api(`costs?period=${period}`);
  const container = document.getElementById("costTimeline");

  if (!data || data.length === 0) {
    container.innerHTML = emptyState("&#128202;", "No cost data yet");
    return;
  }

  const maxCost = Math.max(...data.map((d) => d.cost || 0), 0.001);

  container.innerHTML = `
    <div style="margin-bottom:28px;">
      <div class="cost-bar-chart">
        ${data.map((d) => {
          const height = Math.max(((d.cost || 0) / maxCost) * 100, 2);
          return `
            <div class="cost-bar" style="height:${height}%;">
              <span class="cost-bar-value">${formatCost(d.cost)}</span>
              <span class="cost-bar-label">${d.date?.substring(5) || ""}</span>
            </div>
          `;
        }).join("")}
      </div>
    </div>
    <div style="font-size:11px;color:var(--text-muted);text-align:center;">
      Total: ${formatCost(data.reduce((sum, d) => sum + (d.cost || 0), 0))} &middot;
      ${formatTokens(data.reduce((sum, d) => sum + (d.tokens || 0), 0))} tokens
    </div>
  `;
}

// ── Services ────────────────────────────────────────────────

async function loadServices() {
  const [data, health] = await Promise.all([api("services"), checkHealth()]);
  if (!data) return;

  // Bot config
  const botEl = document.getElementById("botConfig");
  const bot = data.bot || {};
  botEl.innerHTML = `<div class="service-grid">
    ${serviceCard("Forum Mode", bot.forumMode, "&#128172;")}
    ${serviceCard("Text-to-Speech", bot.tts, "&#128264;")}
    ${serviceCard("Phone Calls", bot.phone, "&#128222;")}
    ${serviceCard("Fallback AI", bot.fallback, "&#128260;")}
  </div>`;

  // Integrations
  const intEl = document.getElementById("integrations");
  const integrations = data.integrations || {};
  intEl.innerHTML = `<div class="service-grid">
    ${serviceCard("Supabase", integrations.supabase, "&#128451;")}
    ${serviceCard("Weather", integrations.weather, "&#9925;")}
    ${serviceCard("Notion", integrations.notion, "&#128221;")}
    ${serviceCard("Gmail", integrations.gmail, "&#9993;")}
    ${serviceCard("Calendar", integrations.calendar, "&#128197;")}
  </div>`;

  // Agents
  const agentsEl = document.getElementById("agentsList");
  const agents = data.agents || [];
  if (agents.length > 0) {
    agentsEl.innerHTML = `<table class="data-table">
      <thead><tr><th>Name</th><th>Slug</th><th>Topic ID</th></tr></thead>
      <tbody>${agents.map((a) => `
        <tr>
          <td>${escapeHtml(a.name)}</td>
          <td><code>${escapeHtml(a.slug)}</code></td>
          <td>${a.topicId || '<span style="color:var(--text-muted);">--</span>'}</td>
        </tr>
      `).join("")}</tbody>
    </table>`;
  } else {
    agentsEl.innerHTML = emptyState("&#129302;", "No agents configured");
  }
}

function serviceCard(name, enabled, icon) {
  return `
    <div class="service-item">
      <div class="service-icon ${enabled ? "on" : "off"}">${icon}</div>
      <div class="service-info">
        <div class="service-name">${name}</div>
        <div class="service-status">${enabled ? "Active" : "Not configured"}</div>
      </div>
    </div>
  `;
}

// ── Auto-refresh ────────────────────────────────────────────

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    loadTabData(currentTab);
  }, 30000);
}

// ── Init ────────────────────────────────────────────────────

(async function init() {
  await checkHealth();
  loadOverview();
  startAutoRefresh();

  // Log search on enter
  document.getElementById("logSearch")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadLogs();
  });
})();
