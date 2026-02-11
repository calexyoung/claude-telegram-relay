/**
 * Claude Relay Dashboard — Frontend
 *
 * Vanilla JS SPA with auto-refresh.
 * Fetches from /api/dashboard/* endpoints.
 */

const API = "/api/dashboard";
let refreshTimer = null;
let currentTab = "daily";
let availableModels = {};

// ── Navigation ──────────────────────────────────────────────

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    if (item.dataset.tab) switchTab(item.dataset.tab);
  });
});

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach((t) => t.classList.remove("active"));
  document.querySelector(`.nav-item[data-tab="${tab}"]`)?.classList.add("active");
  document.getElementById(`tab-${tab}`)?.classList.add("active");
  // Hide project detail when switching tabs
  const pd = document.getElementById("projectDetail");
  if (pd) pd.style.display = "none";
  const pg = document.getElementById("projectsGrid");
  if (pg) pg.style.display = "";
  const ps = document.getElementById("projectsStats");
  if (ps) ps.style.display = "";
  const fb = document.getElementById("filterBar");
  if (fb) fb.style.display = "";
  loadTabData(tab);
}

function loadTabData(tab) {
  switch (tab) {
    case "daily": loadDaily(); break;
    case "projects": loadProjects(); break;
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

function truncateText(text, max) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "\u2026" : text;
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

// ══════════════════════════════════════════════════════════════
// ── Daily Tab ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

let dailyData = {};

function moodColor(val) {
  if (val >= 8) return "var(--green)";
  if (val >= 6) return "var(--yellow)";
  return "var(--red)";
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good Morning";
  if (hour < 17) return "Good Afternoon";
  return "Good Evening";
}

function updateDailyClock() {
  const now = new Date();
  const timeEl = document.getElementById("dailyTime");
  const greetEl = document.getElementById("dailyGreeting");
  const utcEl = document.getElementById("dailyUtc");
  if (timeEl) timeEl.textContent = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  if (greetEl) greetEl.innerHTML = `${getGreeting()}, <span>Alex</span>`;
  if (utcEl) utcEl.textContent = `UTC: ${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
}

function weatherEmoji(code) {
  const c = parseInt(code);
  if (c === 113) return "\u2600\uFE0F";
  if (c === 116) return "\u26C5";
  if (c === 119 || c === 122) return "\u2601\uFE0F";
  if ([143, 248, 260].includes(c)) return "\u{1F32B}\uFE0F";
  if ([176, 263, 266, 293, 296].includes(c)) return "\u{1F326}\uFE0F";
  if ([299, 302, 305, 308, 356, 359].includes(c)) return "\u{1F327}\uFE0F";
  if ([200, 386, 389, 392].includes(c)) return "\u26C8\uFE0F";
  if ([179, 182, 185, 227, 230, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377, 395].includes(c)) return "\u2744\uFE0F";
  return "\u{1F324}\uFE0F";
}

async function loadDaily() {
  const [data, weather, captures] = await Promise.all([
    api("daily"),
    api("weather"),
    api("captures"),
  ]);

  if (data) {
    dailyData = data;
    renderDailyContent(data);
  }

  if (weather && !weather.error) {
    renderWeather(weather);
  }

  renderCaptures(captures);
  updateDailyClock();

  // Update date display
  if (data && data.date) {
    const dateEl = document.getElementById("dailyDate");
    if (dateEl) {
      dateEl.textContent = `${data.dayOfWeek}, ${new Date(data.date + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;
    }
  }
}

function renderWeather(w) {
  const el = document.getElementById("dailyWeather");
  if (!el) return;
  const emoji = weatherEmoji(w.icon);
  el.innerHTML = `
    <div class="daily-weather-emoji">${emoji}</div>
    <div class="daily-weather-temp">${w.temp_F}\u00B0F / ${w.temp_C}\u00B0C</div>
    <div class="daily-weather-desc">${escapeHtml(w.condition)}</div>
    <div class="daily-weather-details">
      <span>\u{1F4A8} ${w.windMph} mph ${w.windDir}</span>
      <span>\u{1F4A7} ${w.humidity}%</span>
    </div>
  `;
}

function renderDailyContent(d) {
  // Metrics
  const metricsEl = document.getElementById("dailyMetrics");
  if (metricsEl) {
    metricsEl.innerHTML = `
      <div class="daily-metric">
        <div class="daily-metric-circle" style="border-color:${moodColor(d.mood)};color:${moodColor(d.mood)}">${d.mood}</div>
        <div class="daily-metric-label">Mood</div>
      </div>
      <div class="daily-metric">
        <div class="daily-metric-circle" style="border-color:${moodColor(d.energy)};color:${moodColor(d.energy)}">${d.energy}</div>
        <div class="daily-metric-label">Energy</div>
      </div>
    `;
  }

  const sleepEl = document.getElementById("dailySleep");
  if (sleepEl) sleepEl.textContent = "\u{1F4A4} " + (d.sleep || "--");

  const focusEl = document.getElementById("dailyFocusText");
  if (focusEl) focusEl.textContent = d.focus || "";

  // ADHD Focus
  const adhdEl = document.getElementById("dailyAdhd");
  if (adhdEl && d.adhdFocus) {
    const af = d.adhdFocus;
    adhdEl.innerHTML = `
      <span class="daily-adhd-day">Day ${af.day}/${af.total}</span>
      <span class="daily-adhd-label">${escapeHtml(af.label)}</span>
      <div class="daily-adhd-title">${escapeHtml(af.title)}</div>
      <div class="daily-adhd-desc">${escapeHtml(af.description)}</div>
      <div class="daily-adhd-strategy">\u{1F4A1} ${escapeHtml(af.strategy)}</div>
    `;
  }

  // Schedule
  const schedEl = document.getElementById("dailySchedule");
  if (schedEl && d.schedule) {
    schedEl.innerHTML = d.schedule.map((s, i) => `
      <div class="daily-schedule-item${i === 0 ? " next" : ""}">
        <div class="daily-schedule-time">${i === 0 ? '<span class="daily-next-badge">NEXT</span>' : ""}${escapeHtml(s.time)}</div>
        <div class="daily-schedule-event">${escapeHtml(s.event)}</div>
      </div>
    `).join("");
  }

  // Tasks Kanban
  renderKanban(d);

  // Habits
  renderHabits(d);
}

function taskMoveButtons(column, index) {
  const cols = { today: "Today", thisWeek: "This Week", nextWeek: "Next Week", later: "Later" };
  let btns = `<button class="daily-task-btn done" onclick="dailyTaskDone('${column}',${index})">Done</button>`;
  for (const [key, label] of Object.entries(cols)) {
    if (key === column) continue;
    btns += `<button class="daily-task-btn move" onclick="dailyTaskMove('${column}',${index},'${key}')">${label}</button>`;
  }
  btns += `<button class="daily-task-btn trash" onclick="dailyTaskTrash('${column}',${index})">Trash</button>`;
  return btns;
}

function renderKanban(d) {
  const el = document.getElementById("dailyKanban");
  if (!el || !d.tasks) return;

  const cols = [
    { key: "today", label: "Today", cls: "col-today" },
    { key: "thisWeek", label: "This Week", cls: "col-week" },
    { key: "nextWeek", label: "Next Week", cls: "col-next" },
    { key: "later", label: "Later", cls: "col-later" },
    { key: "noDate", label: "No Date", cls: "col-nodate" },
  ];

  let html = cols.map((c) => {
    const tasks = d.tasks[c.key] || [];
    const cards = tasks.length
      ? tasks.map((t, i) => `<div class="daily-task-card">
          <div class="daily-task-text">${escapeHtml(t)}</div>
          <div class="daily-task-actions">${taskMoveButtons(c.key, i)}</div>
        </div>`).join("")
      : '<div class="daily-no-tasks">No tasks</div>';
    return `<div class="daily-kanban-col ${c.cls}">
      <h4>${c.label} <span class="daily-count">${tasks.length}</span></h4>
      ${cards}
    </div>`;
  }).join("");

  // Done
  const done = d.tasks.done || [];
  if (done.length > 0) {
    html += `<div class="daily-kanban-col col-done">
      <h4>Done <span class="daily-count">${done.length}</span></h4>
      ${done.slice().reverse().map((t) => `<div class="daily-done-task">${escapeHtml(typeof t === "string" ? t : t.text)}</div>`).join("")}
    </div>`;
  }

  // Trash
  const trash = d.tasks.trash || [];
  if (trash.length > 0) {
    html += `<div class="daily-kanban-col col-trash">
      <h4>Trash <span class="daily-count">${trash.length}</span></h4>
      ${trash.map((t, i) => `<div class="daily-task-card">
        <div class="daily-task-text" style="opacity:0.6">${escapeHtml(typeof t === "string" ? t : t.text)}</div>
        <div class="daily-task-actions">
          <button class="daily-task-btn move" onclick="dailyTaskRestore(${i},'today')">Today</button>
          <button class="daily-task-btn move" onclick="dailyTaskRestore(${i},'thisWeek')">This Week</button>
          <button class="daily-task-btn move" onclick="dailyTaskRestore(${i},'later')">Later</button>
        </div>
      </div>`).join("")}
    </div>`;
  }

  el.innerHTML = html;
}

function renderHabits(d) {
  const el = document.getElementById("dailyHabits");
  if (!el || !d.habits) return;
  const h = d.habits;
  const today = new Date((d.date || new Date().toISOString().split("T")[0]) + "T12:00:00");
  const dayHeaders = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(today);
    day.setDate(today.getDate() - i);
    dayHeaders.push(`<div class="daily-habit-header">${day.toLocaleDateString("en-US", { weekday: "short" })}</div>`);
  }
  let html = `<div class="daily-habit-row"><div></div>${dayHeaders.join("")}</div>`;
  h.labels.forEach((label, i) => {
    const cells = h.data[i].map((v) => {
      if (v === true) return '<div class="daily-habit-cell yes">\u2713</div>';
      if (v === false) return '<div class="daily-habit-cell no">\u2717</div>';
      return '<div class="daily-habit-cell na">\u2014</div>';
    }).join("");
    html += `<div class="daily-habit-row"><div class="daily-habit-label">${escapeHtml(label)}</div>${cells}</div>`;
  });
  el.innerHTML = html;
}

// Daily task/capture mutations
async function dailyTaskDone(column, index) {
  await api("task/done", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ column, index }) });
  loadDaily();
}

async function dailyTaskMove(fromColumn, index, toColumn) {
  await api("task/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fromColumn, index, toColumn }) });
  loadDaily();
}

async function dailyTaskTrash(column, index) {
  await api("task/trash", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ column, index }) });
  loadDaily();
}

async function dailyTaskRestore(index, toColumn) {
  await api("task/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ index, toColumn }) });
  loadDaily();
}

async function submitCapture() {
  const input = document.getElementById("captureInput");
  const text = input.value.trim();
  if (!text) return;
  await api("captures", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  input.value = "";
  const captures = await api("captures");
  renderCaptures(captures);
}

async function captureDelete(id) {
  await api("captures/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
  const captures = await api("captures");
  renderCaptures(captures);
}

async function captureMove(id, column) {
  await api("captures/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, column }) });
  loadDaily();
}

function renderCaptures(captures) {
  const list = document.getElementById("captureList");
  if (!list) return;
  if (!captures || captures.length === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:12px 0;">No captures yet.</div>';
    return;
  }
  list.innerHTML = captures.slice().reverse().map((c) => {
    const t = new Date(c.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `<div class="daily-capture-item">
      <div class="daily-capture-header">
        <span class="daily-capture-text">${escapeHtml(c.text)}</span>
        <span class="daily-capture-time">${t}</span>
      </div>
      <div class="daily-capture-actions">
        <button class="daily-task-btn move" onclick="captureMove('${c.id}','today')">Today</button>
        <button class="daily-task-btn move" onclick="captureMove('${c.id}','thisWeek')">This Week</button>
        <button class="daily-task-btn move" onclick="captureMove('${c.id}','later')">Later</button>
        <button class="daily-task-btn trash" onclick="captureDelete('${c.id}')">Delete</button>
      </div>
    </div>`;
  }).join("");
}

// ══════════════════════════════════════════════════════════════
// ── Projects Tab ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

let projectsData = [];
let currentFilter = "all";

async function loadProjects() {
  const data = await api("projects");
  if (!data) {
    document.getElementById("projectsGrid").innerHTML = emptyState("\u{1F4CB}", "Failed to load projects");
    return;
  }
  projectsData = data;
  renderProjectStats();
  renderProjects();
}

function renderProjectStats() {
  const total = projectsData.length;
  const high = projectsData.filter((p) => p.priority === "high").length;
  const stale = projectsData.filter((p) => p.isStale).length;
  const withTodos = projectsData.filter((p) => p.progress.total > 0);
  const totalDone = withTodos.reduce((s, p) => s + p.progress.done, 0);
  const totalSteps = withTodos.reduce((s, p) => s + p.progress.total, 0);
  const el = document.getElementById("projectsStats");
  if (!el) return;
  el.innerHTML = `
    <div class="daily-proj-stat"><span class="daily-proj-stat-num">${total}</span> projects</div>
    <div class="daily-proj-stat"><span class="daily-proj-stat-num">${high}</span> high priority</div>
    <div class="daily-proj-stat"><span class="daily-proj-stat-num">${totalDone}/${totalSteps}</span> steps done</div>
    ${stale > 0 ? `<div class="daily-proj-stat" style="color:var(--yellow)"><span class="daily-proj-stat-num" style="color:var(--yellow)">${stale}</span> stale</div>` : ""}
  `;
}

function filterProjects(filter) {
  currentFilter = filter;
  document.querySelectorAll(".daily-filter-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === filter);
  });
  renderProjects();
}

function getFilteredProjects() {
  if (currentFilter === "all") return projectsData;
  if (currentFilter === "nasa") return projectsData.filter((p) => p.category === "nasa");
  if (currentFilter === "personal") return projectsData.filter((p) => p.category === "personal");
  if (currentFilter === "high") return projectsData.filter((p) => p.priority === "high");
  if (currentFilter === "stale") return projectsData.filter((p) => p.isStale);
  return projectsData;
}

function categoryBadgeClass(cat) {
  const map = { nasa: "badge-nasa", personal: "badge-personal", earthsky: "badge-earthsky", smithsonian: "badge-smithsonian", learning: "badge-learning" };
  return map[cat] || "badge-uncategorized";
}

function priorityBadgeClass(pri) {
  const map = { high: "badge-high", medium: "badge-medium", normal: "badge-normal" };
  return map[pri] || "badge-normal";
}

function renderProgressBar(done, total) {
  if (total === 0) return '<div class="daily-progress-bar empty"></div>';
  if (total > 30) {
    return `<div class="daily-progress-bar"><div style="flex:${done};background:var(--green);border-radius:2px;"></div><div style="flex:${total - done};background:rgba(255,255,255,0.08);border-radius:2px;"></div></div>`;
  }
  const segments = [];
  for (let i = 0; i < total; i++) {
    segments.push(`<div class="daily-progress-segment ${i < done ? "done" : "todo"}"></div>`);
  }
  return `<div class="daily-progress-bar">${segments.join("")}</div>`;
}

function renderProjects() {
  const filtered = getFilteredProjects();
  const grid = document.getElementById("projectsGrid");
  if (!grid) return;
  if (filtered.length === 0) {
    grid.innerHTML = emptyState("\u{1F4CB}", "No projects match this filter");
    return;
  }
  grid.innerHTML = filtered.map((p) => {
    const staleBadge = p.isStale ? `<span class="daily-badge badge-stale">\u26A0 ${p.staleDays}d</span>` : "";
    const nextHtml = p.nextAction
      ? `<div class="daily-project-next">\u26A1 ${escapeHtml(truncateText(p.nextAction, 80))}</div>`
      : (p.progress.total === 0
        ? '<div class="daily-project-next" style="opacity:0.5">No action items yet</div>'
        : '<div class="daily-project-next" style="color:var(--green)">All steps complete!</div>');
    return `<div class="daily-project-card${p.isStale ? " stale" : ""}" onclick="openProject('${p.id}')">
      <div class="daily-project-header">
        <span class="daily-project-emoji">${p.emoji}</span>
        <span class="daily-project-name">${escapeHtml(p.name)}</span>
        <span class="daily-badge ${categoryBadgeClass(p.category)}">${escapeHtml(p.category)}</span>
        <span class="daily-badge ${priorityBadgeClass(p.priority)}">${escapeHtml(p.priority)}</span>
        ${staleBadge}
      </div>
      <div class="daily-progress-container">
        ${renderProgressBar(p.progress.done, p.progress.total)}
        <span class="daily-progress-text">${p.progress.done}/${p.progress.total}</span>
      </div>
      ${nextHtml}
      ${p.isStale ? `<div class="daily-stale-warn">\u26A0 Not updated in ${p.staleDays} days</div>` : ""}
    </div>`;
  }).join("");
}

async function openProject(id) {
  const data = await api(`projects/${encodeURIComponent(id)}`);
  if (!data || data.error) return;
  // Hide grid/stats/filters, show detail
  document.getElementById("projectsGrid").style.display = "none";
  document.getElementById("projectsStats").style.display = "none";
  document.getElementById("filterBar").style.display = "none";
  const detail = document.getElementById("projectDetail");
  detail.style.display = "block";
  renderProjectDetail(data);
}

function closeProjectDetail() {
  document.getElementById("projectDetail").style.display = "none";
  document.getElementById("projectsGrid").style.display = "";
  document.getElementById("projectsStats").style.display = "";
  document.getElementById("filterBar").style.display = "";
}

function renderProjectDetail(p) {
  let foundNext = false;
  function isNextAction(todo) {
    if (!foundNext && !todo.done) { foundNext = true; return true; }
    return false;
  }

  let sectionsHtml = "";
  for (const sec of (p.sections || [])) {
    const todosHtml = sec.todos.map((t) => {
      const isNext = isNextAction(t);
      return `<div class="daily-detail-todo${t.done ? " done" : ""}${isNext ? " next" : ""}">
        <div class="daily-detail-check${t.done ? " checked" : ""}">${t.done ? "\u2713" : ""}</div>
        <div class="daily-detail-text">${isNext ? "\u26A1 " : ""}${escapeHtml(t.text)}</div>
      </div>`;
    }).join("");
    sectionsHtml += `<div class="daily-detail-section">
      <div class="daily-detail-section-header">
        <span>${escapeHtml(sec.name)}</span>
        <span class="daily-detail-section-count">${sec.done}/${sec.total}</span>
      </div>
      ${todosHtml || '<div style="color:var(--text-muted);font-size:12px;">No items</div>'}
    </div>`;
  }

  if (p.topLevelTodos && p.topLevelTodos.length > 0) {
    const topHtml = p.topLevelTodos.map((t) => {
      const isNext = isNextAction(t);
      return `<div class="daily-detail-todo${t.done ? " done" : ""}${isNext ? " next" : ""}">
        <div class="daily-detail-check${t.done ? " checked" : ""}">${t.done ? "\u2713" : ""}</div>
        <div class="daily-detail-text">${isNext ? "\u26A1 " : ""}${escapeHtml(t.text)}</div>
      </div>`;
    }).join("");
    sectionsHtml = `<div class="daily-detail-section">
      <div class="daily-detail-section-header">
        <span>Action Items</span>
        <span class="daily-detail-section-count">${p.topLevelTodos.filter((t) => t.done).length}/${p.topLevelTodos.length}</span>
      </div>
      ${topHtml}
    </div>` + sectionsHtml;
  }

  document.getElementById("projectDetailContent").innerHTML = `
    <div class="panel">
      <div class="panel-body">
        <div class="daily-detail-header">
          <span class="daily-detail-emoji">${p.emoji}</span>
          <span class="daily-detail-title">${escapeHtml(p.name)}</span>
        </div>
        <div class="daily-detail-meta">
          <span class="daily-badge ${categoryBadgeClass(p.category)}">${escapeHtml(p.category)}</span>
          <span class="daily-badge ${priorityBadgeClass(p.priority)}">${escapeHtml(p.priority)}</span>
          ${p.isStale ? '<span class="daily-badge badge-stale">\u26A0 Stale</span>' : ""}
          <span class="daily-badge badge-uncategorized">Updated ${new Date(p.modifiedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
        </div>
        <div class="daily-detail-progress-card">
          <div class="daily-detail-progress-label">Overall Progress</div>
          <div class="daily-detail-progress-big">${p.progress.percent}%</div>
          <div class="daily-progress-container">
            ${renderProgressBar(p.progress.done, p.progress.total)}
            <span class="daily-progress-text">${p.progress.done} of ${p.progress.total} steps</span>
          </div>
        </div>
        ${sectionsHtml || '<div style="color:var(--text-muted);padding:12px 0;">No action items found.</div>'}
      </div>
    </div>
  `;
}

// ── Overview ────────────────────────────────────────────────

async function loadOverview() {
  const [stats, tokens, health, logs] = await Promise.all([
    api("stats"),
    api("tokens?range=24h"),
    checkHealth(),
    api("logs?limit=10"),
  ]);

  if (stats) {
    document.getElementById("statMessages").textContent = stats.messagesToday || 0;
    document.getElementById("statGoals").textContent = stats.activeGoals || 0;
    document.getElementById("statActions").textContent = stats.pendingActions || 0;
    document.getElementById("statErrors").textContent = stats.errorsToday || 0;
  }

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

  const sysEl = document.getElementById("overviewSystem");
  if (health) {
    sysEl.innerHTML = `
      <div class="breakdown-item"><span class="breakdown-label">Uptime</span><span class="breakdown-values"><span class="breakdown-tokens">${formatUptime(health.uptime)}</span></span></div>
      <div class="breakdown-item"><span class="breakdown-label">Memory (RSS)</span><span class="breakdown-values"><span class="breakdown-tokens">${formatBytes(health.memory?.rss)}</span></span></div>
      <div class="breakdown-item"><span class="breakdown-label">Heap Used</span><span class="breakdown-values"><span class="breakdown-tokens">${formatBytes(health.memory?.heapUsed)}</span></span></div>
      <div class="breakdown-item"><span class="breakdown-label">Last Message</span><span class="breakdown-values"><span class="breakdown-tokens">${health.lastMessageAt ? formatDateTime(health.lastMessageAt) : "None"}</span></span></div>
    `;
  } else {
    sysEl.innerHTML = emptyState("&#9888;", "Cannot reach health endpoint");
  }

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
  const topEl = document.getElementById("topErrorEvents");
  if (data.topEvents && data.topEvents.length > 0) {
    topEl.innerHTML = `<table class="data-table"><thead><tr><th>Event</th><th>Count</th></tr></thead><tbody>${data.topEvents.map((e) => `<tr><td>${escapeHtml(e.event)}</td><td>${e.count}</td></tr>`).join("")}</tbody></table>`;
  } else {
    topEl.innerHTML = emptyState("&#10003;", "No errors in the last 24 hours");
  }
  const recentEl = document.getElementById("recentErrors");
  if (data.recentErrors && data.recentErrors.length > 0) {
    recentEl.innerHTML = data.recentErrors.map((e) => `<div class="error-item"><div class="error-header"><span class="error-event">${escapeHtml(e.event)}</span><span class="error-time">${formatDateTime(e.created_at)}</span></div><div class="error-message">${escapeHtml(e.message)}</div></div>`).join("");
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
  if (!data || data.length === 0) { container.innerHTML = emptyState("&#9993;", "No messages yet"); return; }
  container.innerHTML = data.map((msg) => `
    <div class="message-item">
      <div class="message-avatar ${msg.role === "user" ? "user" : "assistant"}">${msg.role === "user" ? "&#128100;" : "&#129302;"}</div>
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
  if (!items || items.length === 0) { container.innerHTML = emptyState("&#9733;", emptyText); return; }
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
  const stats = data.stats || {};
  document.getElementById("actionStats").innerHTML = `
    <div class="stat-card blue"><div class="label">Total Actions</div><div class="value">${stats.total || 0}</div></div>
    <div class="stat-card green"><div class="label">Approved</div><div class="value">${stats.approved || 0}</div></div>
    <div class="stat-card red"><div class="label">Denied</div><div class="value">${stats.denied || 0}</div></div>
    <div class="stat-card accent"><div class="label">Executed</div><div class="value">${stats.executed || 0}</div></div>
  `;
  const pendingEl = document.getElementById("pendingActions");
  if (data.pending && data.pending.length > 0) {
    pendingEl.innerHTML = `<table class="data-table"><thead><tr><th>Type</th><th>Description</th><th>Created</th><th>Status</th></tr></thead><tbody>${data.pending.map((a) => `<tr><td>${escapeHtml(a.type)}</td><td>${escapeHtml(a.description || a.payload || "")}</td><td>${formatDateTime(a.created_at)}</td><td><span class="badge pending">Pending</span></td></tr>`).join("")}</tbody></table>`;
  } else { pendingEl.innerHTML = emptyState("&#10003;", "No pending actions"); }
  const historyEl = document.getElementById("actionHistory");
  if (data.history && data.history.length > 0) {
    historyEl.innerHTML = `<table class="data-table"><thead><tr><th>Type</th><th>Description</th><th>Status</th><th>Date</th></tr></thead><tbody>${data.history.map((a) => `<tr><td>${escapeHtml(a.type)}</td><td>${escapeHtml(a.description || a.payload || "")}</td><td><span class="badge ${a.status}">${a.status}</span></td><td>${formatDateTime(a.created_at)}</td></tr>`).join("")}</tbody></table>`;
  } else { historyEl.innerHTML = emptyState("&#128196;", "No action history"); }
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
  const agentSelect = document.getElementById("msgAgent");
  if (agentSelect && agentSelect.options.length <= 1) {
    configs.forEach((c) => { const opt = document.createElement("option"); opt.value = c.agent; opt.textContent = c.agent; agentSelect.appendChild(opt); });
  }
  if (configs.length === 0) { container.innerHTML = emptyState("&#9881;", "No model configurations found"); return; }
  const allProviders = Object.keys(availableModels);
  container.innerHTML = configs.map((cfg) => `
    <div class="model-row" data-agent="${escapeHtml(cfg.agent)}">
      <span class="model-agent">${escapeHtml(cfg.agent)}</span>
      <div class="model-selects">
        <select class="select model-provider" data-agent="${escapeHtml(cfg.agent)}" onchange="onProviderChange(this)">${allProviders.map((p) => `<option value="${p}" ${p === cfg.provider ? "selected" : ""}>${p}</option>`).join("")}</select>
        <select class="select model-model" data-agent="${escapeHtml(cfg.agent)}">${(availableModels[cfg.provider] || []).map((m) => `<option value="${m}" ${m === cfg.model ? "selected" : ""}>${m}</option>`).join("")}</select>
        <button class="btn sm primary" onclick="saveModel('${escapeHtml(cfg.agent)}')">Save</button>
      </div>
      <span class="model-status" id="model-status-${escapeHtml(cfg.agent)}"></span>
    </div>
  `).join("");
}

function onProviderChange(el) {
  const agent = el.dataset.agent;
  const models = availableModels[el.value] || [];
  const sel = document.querySelector(`.model-model[data-agent="${agent}"]`);
  if (sel) sel.innerHTML = models.map((m) => `<option value="${m}">${m}</option>`).join("");
}

async function saveModel(agent) {
  const provider = document.querySelector(`.model-provider[data-agent="${agent}"]`)?.value;
  const model = document.querySelector(`.model-model[data-agent="${agent}"]`)?.value;
  const statusEl = document.getElementById(`model-status-${agent}`);
  if (!provider || !model) return;
  statusEl.textContent = "Saving...";
  statusEl.style.color = "var(--text-muted)";
  const result = await api("models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent, provider, model }) });
  statusEl.textContent = result?.success ? "Saved" : "Error";
  statusEl.style.color = result?.success ? "var(--green)" : "var(--red)";
  setTimeout(() => { statusEl.textContent = ""; }, 3000);
}

async function loadTokenStats() {
  const range = document.getElementById("tokenRange")?.value || "24h";
  const data = await api(`tokens?range=${range}`);
  if (!data) return;
  document.getElementById("tokenStatCards").innerHTML = `
    <div class="stat-card accent"><div class="label">Total Tokens</div><div class="value">${formatTokens(data.total?.tokens)}</div></div>
    <div class="stat-card green"><div class="label">Total Cost</div><div class="value">${formatCost(data.total?.cost)}</div></div>
  `;
  const breakdownEl = document.getElementById("tokenBreakdown");
  const sections = [{ title: "By Provider", data: data.byProvider }, { title: "By Agent", data: data.byAgent }, { title: "By Model", data: data.byModel }];
  breakdownEl.innerHTML = `<div class="breakdown-grid">${sections.map((section) => {
    const entries = Object.entries(section.data || {});
    if (entries.length === 0) return "";
    return `<div><h4 style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px;">${section.title}</h4>${entries.map(([name, vals]) => `<div class="breakdown-item"><span class="breakdown-label">${escapeHtml(name)}</span><span class="breakdown-values"><span class="breakdown-tokens">${formatTokens(vals.tokens)}</span><span class="breakdown-cost">${formatCost(vals.cost)}</span></span></div>`).join("")}</div>`;
  }).join("")}</div>`;
}

async function loadCostTimeline() {
  const period = document.getElementById("costPeriod")?.value || "day";
  const data = await api(`costs?period=${period}`);
  const container = document.getElementById("costTimeline");
  if (!data || data.length === 0) { container.innerHTML = emptyState("&#128202;", "No cost data yet"); return; }
  const maxCost = Math.max(...data.map((d) => d.cost || 0), 0.001);
  container.innerHTML = `<div style="margin-bottom:28px;"><div class="cost-bar-chart">${data.map((d) => { const height = Math.max(((d.cost || 0) / maxCost) * 100, 2); return `<div class="cost-bar" style="height:${height}%;"><span class="cost-bar-value">${formatCost(d.cost)}</span><span class="cost-bar-label">${d.date?.substring(5) || ""}</span></div>`; }).join("")}</div></div><div style="font-size:11px;color:var(--text-muted);text-align:center;">Total: ${formatCost(data.reduce((sum, d) => sum + (d.cost || 0), 0))} &middot; ${formatTokens(data.reduce((sum, d) => sum + (d.tokens || 0), 0))} tokens</div>`;
}

// ── Services ────────────────────────────────────────────────

async function loadServices() {
  const [data, health] = await Promise.all([api("services"), checkHealth()]);
  if (!data) return;
  const bot = data.bot || {};
  document.getElementById("botConfig").innerHTML = `<div class="service-grid">${serviceCard("Forum Mode", bot.forumMode, "&#128172;")}${serviceCard("Text-to-Speech", bot.tts, "&#128264;")}${serviceCard("Phone Calls", bot.phone, "&#128222;")}${serviceCard("Fallback AI", bot.fallback, "&#128260;")}</div>`;
  const integrations = data.integrations || {};
  document.getElementById("integrations").innerHTML = `<div class="service-grid">${serviceCard("Supabase", integrations.supabase, "&#128451;")}${serviceCard("Weather", integrations.weather, "&#9925;")}${serviceCard("Notion", integrations.notion, "&#128221;")}${serviceCard("Gmail", integrations.gmail, "&#9993;")}${serviceCard("Calendar", integrations.calendar, "&#128197;")}</div>`;
  const agents = data.agents || [];
  const agentsEl = document.getElementById("agentsList");
  if (agents.length > 0) {
    agentsEl.innerHTML = `<table class="data-table"><thead><tr><th>Name</th><th>Slug</th><th>Topic ID</th></tr></thead><tbody>${agents.map((a) => `<tr><td>${escapeHtml(a.name)}</td><td><code>${escapeHtml(a.slug)}</code></td><td>${a.topicId || '<span style="color:var(--text-muted);">--</span>'}</td></tr>`).join("")}</tbody></table>`;
  } else { agentsEl.innerHTML = emptyState("&#129302;", "No agents configured"); }
}

function serviceCard(name, enabled, icon) {
  return `<div class="service-item"><div class="service-icon ${enabled ? "on" : "off"}">${icon}</div><div class="service-info"><div class="service-name">${name}</div><div class="service-status">${enabled ? "Active" : "Not configured"}</div></div></div>`;
}

// ── Auto-refresh ────────────────────────────────────────────

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { loadTabData(currentTab); }, 30000);
}

// ── Init ────────────────────────────────────────────────────

(async function init() {
  await checkHealth();
  loadDaily();
  startAutoRefresh();
  updateDailyClock();
  setInterval(updateDailyClock, 1000);

  document.getElementById("logSearch")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadLogs();
  });
  document.getElementById("captureInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitCapture();
  });
})();
