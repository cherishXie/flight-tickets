import { DESTINATIONS, HOLIDAYS, RECOMMENDATION_PRESETS } from "./data.js";
import {
  buildCustomDestination,
  buildCustomHoliday,
  buildManualPriceSnapshot,
  generateFlexibleDateOptions,
  parseCsvRows,
  splitList
} from "./domain.js";
import { parseBackup, pruneSnapshotsByTask, removeTaskData, serializeBackup, serializeCsv } from "./storage.js";
import { collectPriceSnapshots, listPriceSources, PRICE_SOURCE_TYPES } from "./priceSources.js";
import { buildEmailDraft, buildEmlDataHref, buildMailtoLink, listNotificationChannels } from "./notifications.js";
import {
  buildRecommendationScore,
  DEFAULT_ALERT_RULES,
  evaluateDeal,
  evaluateAlert,
  formatMoney,
  scoreDestination,
  summarizeSnapshots
} from "./pricing.js";

const STORAGE_KEY = "flight-tickets-v1";

const defaultSettings = {
  email: "your-email@example.com",
  cooldownHours: 12,
  defaultCurrency: "CNY",
  autoCollectEnabled: false,
  autoCollectIntervalMinutes: 60,
  autoPruneSnapshots: true,
  maxSnapshotsPerTask: 600,
  lastAutoRunAt: null,
  alertBudgetEnabled: DEFAULT_ALERT_RULES.budgetEnabled,
  alertHistoricalLowEnabled: DEFAULT_ALERT_RULES.historicalLowEnabled,
  alertAverageDropEnabled: DEFAULT_ALERT_RULES.averageDropEnabled,
  alertAverageDropPercent: DEFAULT_ALERT_RULES.averageDropPercent
};

const defaultProfiles = [
  {
    id: "local-user",
    displayName: "我",
    email: defaultSettings.email,
    originCity: "上海",
    originAirportCodes: ["PVG", "SHA"],
    preferredDestinationTags: ["自然风景", "历史人文"],
    createdAt: null,
    updatedAt: null
  }
];

const defaultState = {
  activeView: "recommendations",
  selectedTaskId: null,
  settings: defaultSettings,
  activeProfileId: "local-user",
  profiles: defaultProfiles,
  customHolidays: [],
  customDestinations: [],
  tasks: [],
  snapshots: [],
  alerts: [],
  backupText: "",
  backupMessage: "",
  maintenanceMessage: "",
  csvImportText: "",
  csvImportMessage: "",
  manualDraft: null,
  taskFilters: {
    query: "",
    status: "all",
    alertStatus: "all",
    sortBy: "deal"
  },
  snapshotFilters: {
    destinationId: "all",
    strategyType: "all",
    datePair: "all"
  },
  destinationFilters: {
    region: "all",
    tag: "all",
    query: ""
  }
};

let state = loadState();
let autoCollectTimer = null;

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const settings = { ...defaultSettings, ...saved?.settings };
    const profiles = normalizeProfiles(saved?.profiles, settings);
    const activeProfileId = profiles.some((profile) => profile.id === saved?.activeProfileId)
      ? saved.activeProfileId
      : profiles[0].id;
    return {
      ...defaultState,
      ...saved,
      settings,
      profiles,
      activeProfileId,
      customHolidays: saved?.customHolidays || [],
      customDestinations: saved?.customDestinations || [],
      backupText: "",
      backupMessage: "",
      maintenanceMessage: "",
      csvImportText: "",
      csvImportMessage: "",
      manualDraft: null,
      taskFilters: { ...defaultState.taskFilters },
      snapshotFilters: { ...defaultState.snapshotFilters },
      destinationFilters: { ...defaultState.destinationFilters },
      activeView: "recommendations"
    };
  } catch {
    return { ...defaultState };
  }
}

function saveState() {
  enforceSnapshotRetention();
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      tasks: state.tasks,
      snapshots: state.snapshots,
      alerts: state.alerts,
      settings: state.settings,
      profiles: state.profiles,
      activeProfileId: state.activeProfileId,
      customHolidays: state.customHolidays,
      customDestinations: state.customDestinations
    })
  );
}

function render() {
  const profile = activeProfile();
  const app = document.querySelector("#app");
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">FT</span>
          <div>
            <strong>节假日机票雷达</strong>
            <span>上海出发 · 推荐优先</span>
          </div>
        </div>
        <nav class="nav">
          ${navButton("recommendations", "+ 推荐")}
          ${navButton("tasks", "# 监控任务")}
          ${navButton("destinations", "@ 目的地库")}
          ${navButton("alerts", "! 邮件提醒")}
          ${navButton("settings", "* 设置")}
        </nav>
      </aside>
      <main class="workspace">
        <header class="topbar">
          <div>
            <p class="eyebrow">V1 Prototype</p>
            <h1>${viewTitle()}</h1>
          </div>
          <div class="topbar-actions">
            <span class="profile-pill">${escapeHtml(profile.displayName)} · ${escapeHtml(profile.originCity)}</span>
            <button class="ghost-button" data-action="simulate-all">模拟采集价格</button>
            <button class="ghost-button" data-action="toggle-auto">${state.settings.autoCollectEnabled ? "停止自动采集" : "启动自动采集"}</button>
            <button class="primary-button" data-action="open-manual">手动创建</button>
          </div>
        </header>
        ${summaryStrip()}
        ${renderView()}
      </main>
    </div>
  `;
  bindEvents();
}

function navButton(view, label) {
  return `<button class="${state.activeView === view ? "active" : ""}" data-view="${view}">${label}</button>`;
}

function viewTitle() {
  if (state.activeView === "taskDetail") {
    const task = state.tasks.find((item) => item.id === state.selectedTaskId);
    return task ? "任务详情" : "监控任务";
  }
  const titles = {
    recommendations: "系统推荐",
    tasks: "监控任务",
    destinations: "目的地库",
    alerts: "邮件提醒",
    settings: "设置"
  };
  return titles[state.activeView];
}

function summaryStrip() {
  const profile = activeProfile();
  const activeTasks = state.tasks.filter((task) => task.status === "active").length;
  const lastSnapshot = state.snapshots[state.snapshots.length - 1];
  const bestSnapshot = state.snapshots.length
    ? [...state.snapshots].sort((a, b) => a.priceAmount - b.priceAmount)[0]
    : null;
  const bestDestination = bestSnapshot ? destinationById(bestSnapshot.destinationId) : null;
  return `
    <section class="summary-grid">
      ${metric("节假日", allHolidays().length, `${state.customHolidays.length} 个自定义`)}
      ${metric("推荐目的地", DESTINATIONS.filter((destination) => destination.isSystemRecommended).length, "国内 / 国际")}
      ${metric("旅客档案", profile.displayName, `${profile.originCity} · ${profile.originAirportCodes.join(" / ")}`)}
      ${metric("启用任务", activeTasks, "本地保存")}
      ${metric("当前最低", bestSnapshot ? formatMoney(bestSnapshot.priceAmount, bestSnapshot.priceCurrency) : "-", bestDestination ? bestDestination.name : "暂无采集")}
      ${metric("最近采集", lastSnapshot ? formatDateTime(lastSnapshot.searchedAt) : "-", "模拟数据")}
      ${metric("自动采集", state.settings.autoCollectEnabled ? "已启动" : "未启动", state.settings.lastAutoRunAt ? `上次 ${formatDateTime(state.settings.lastAutoRunAt)}` : `${state.settings.autoCollectIntervalMinutes} 分钟/次`)}
    </section>
  `;
}

function metric(label, value, hint) {
  return `
    <div class="metric">
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${hint}</small>
    </div>
  `;
}

function renderView() {
  if (state.activeView === "taskDetail") return renderTaskDetail();
  if (state.activeView === "tasks") return renderTasks();
  if (state.activeView === "destinations") return renderDestinations();
  if (state.activeView === "alerts") return renderAlerts();
  if (state.activeView === "settings") return renderSettings();
  return renderRecommendations();
}

function renderRecommendations() {
  const presets = RECOMMENDATION_PRESETS.filter((preset) => preset.enabled)
    .map((preset) => {
      const holiday = HOLIDAYS.find((item) => item.id === preset.holidayId);
      const destinations = preset.destinationIds.map(destinationById).filter(Boolean);
      return {
        preset,
        holiday,
        destinations,
        score: buildRecommendationScore(preset, holiday, destinations)
      };
    })
    .sort((a, b) => b.score - a.score);

  return `
    <section class="section-header">
      <div>
        <h2>优先从系统推荐开始</h2>
        <p>系统根据上海出发、节假日长度、低价潜力、自然风景和历史人文偏好生成推荐组合。</p>
      </div>
    </section>
    <section class="recommendation-grid">
      ${presets.map(renderPreset).join("")}
    </section>
    ${manualPanel()}
  `;
}

function renderPreset({ preset, holiday, destinations, score }) {
  const tags = preset.tags.map((tag) => `<span class="tag">${tag}</span>`).join("");
  const destinationNames = destinations.map((destination) => destination.name).join(" · ");
  const strategyText = preset.recommendedStrategyTypes.includes("transfer") ? "直飞 + 中转" : "直飞";
  return `
    <article class="recommendation-card">
      <div class="card-topline">
        <span>${holiday.name}</span>
        <strong>${score}</strong>
      </div>
      <h3>${preset.name}</h3>
      <p>${preset.reason}</p>
      <div class="info-row">
        <span>日期</span>
        <strong>${holiday.startDate} 至 ${holiday.endDate}</strong>
      </div>
      <div class="info-row">
        <span>目的地</span>
        <strong>${destinationNames}</strong>
      </div>
      <div class="info-row">
        <span>策略</span>
        <strong>${strategyText}</strong>
      </div>
      <div class="info-row">
        <span>预算建议</span>
        <strong>${formatMoney(preset.recommendedBudgetAmount, preset.recommendedBudgetCurrency)}</strong>
      </div>
      <div class="tags">${tags}</div>
      <div class="card-actions">
        <button class="primary-button" data-action="create-from-preset" data-preset-id="${preset.id}">一键创建监控</button>
        <button class="ghost-button" data-action="customize-preset" data-preset-id="${preset.id}">调整后创建</button>
        <button class="ghost-button" data-action="preview-preset" data-preset-id="${preset.id}">查看目的地</button>
      </div>
    </article>
  `;
}

function manualPanel() {
  const draft = state.manualDraft || {};
  const profile = activeProfile();
  const destinations = allDestinations();
  const selectedDestinationIds = new Set(
    draft.destinationIds?.length ? draft.destinationIds : [destinations[0]?.id].filter(Boolean)
  );
  const destinationCheckboxes = destinations
    .map(
      (destination) => `
        <label class="checkbox destination-choice">
          <input type="checkbox" name="destinationIds" value="${destination.id}" ${selectedDestinationIds.has(destination.id) ? "checked" : ""} />
          <span>
            <strong>${escapeHtml(destination.name)}</strong>
            <small>${destination.isDomestic ? "国内" : "国际及港澳台"} · ${escapeHtml(destination.airportCodes.join(" / "))} · ${escapeHtml(destination.tags.slice(0, 3).join(" / "))}</small>
          </span>
        </label>
      `
    )
    .join("");
  const holidayOptions = allHolidays().map(
    (holiday) => `<option value="${holiday.id}" ${draft.holidayId === holiday.id ? "selected" : ""}>${holiday.name} (${holiday.startDate})</option>`
  ).join("");
  return `
    <section class="manual-panel" id="manual-panel">
      <div>
        <p class="eyebrow">Manual</p>
        <h2>手动输入</h2>
        <p>推荐优先，但你可以直接输入自己的日期、目的地和预算。当前出发档案：${escapeHtml(profile.displayName)} · ${escapeHtml(profile.originCity)}（${escapeHtml(profile.originAirportCodes.join(" / "))}）。</p>
        ${
          draft.sourcePresetName
            ? `<div class="draft-note"><strong>正在调整推荐</strong><span>${escapeHtml(draft.sourcePresetName)}</span><button class="ghost-button" data-action="clear-manual-draft" type="button">清空草稿</button></div>`
            : ""
        }
      </div>
      <form class="manual-form" data-form="manual-task">
        <label>
          任务名称
          <input name="name" value="${escapeHtml(draft.name || "我的节假日监控")}" required />
        </label>
        <label>
          节假日
          <select name="holidayId">
            ${holidayOptions}
            <option value="__custom__" ${draft.holidayId === "__custom__" ? "selected" : ""}>手动输入新节假日</option>
          </select>
        </label>
        <label>
          新节假日名称
          <input name="customHolidayName" placeholder="例如：公司年假 / 暑假" />
        </label>
        <fieldset class="destination-picker">
          <legend>候选目的地</legend>
          <p>可以同时选择多个目的地；系统会分别监控每个目的地的直飞 / 中转价格。</p>
          <div>${destinationCheckboxes}</div>
        </fieldset>
        <label>
          新目的地名称
          <input name="customDestinationName" placeholder="例如：福冈 / 青岛" />
        </label>
        <label>
          国家或地区
          <input name="customCountryOrRegion" placeholder="例如：日本 / 中国大陆" />
        </label>
        <label>
          机场代码
          <input name="customAirportCodes" placeholder="例如：FUK 或 TAO" />
        </label>
        <label>
          目的地标签
          <input name="customTags" placeholder="自然风景, 历史人文" />
        </label>
        <label>
          预估直飞价
          <input name="customDirectPrice" type="number" min="300" step="10" placeholder="2200" />
        </label>
        <label>
          预估中转价
          <input name="customTransferPrice" type="number" min="300" step="10" placeholder="1800" />
        </label>
        <label>
          出发日期
          <input name="departDate" type="date" value="${draft.departDate || ""}" required />
        </label>
        <label>
          返程日期
          <input name="returnDate" type="date" value="${draft.returnDate || ""}" required />
        </label>
        <label>
          前移天数
          <input name="dateFlexDaysBefore" type="number" min="0" max="7" value="${Number(draft.dateFlexDaysBefore) || 0}" required />
        </label>
        <label>
          后移天数
          <input name="dateFlexDaysAfter" type="number" min="0" max="7" value="${Number(draft.dateFlexDaysAfter) || 0}" required />
        </label>
        <label>
          乘客人数
          <input name="passengerCount" type="number" min="1" max="9" value="${Number(draft.passengerCount) || 1}" required />
        </label>
        <label>
          单人预算
          <input name="budgetAmount" type="number" min="300" step="10" value="${Number(draft.budgetAmount) || 2200}" required />
        </label>
        <fieldset>
          <legend>监控策略</legend>
          <label class="checkbox"><input type="checkbox" name="direct" ${draft.monitorDirect === false ? "" : "checked"} /> 直飞</label>
          <label class="checkbox"><input type="checkbox" name="transfer" ${draft.monitorTransfer === false ? "" : "checked"} /> 中转</label>
          <label class="checkbox"><input type="checkbox" name="customIsDomestic" /> 新目的地是国内航线</label>
        </fieldset>
        <button class="primary-button" type="submit">创建手动监控</button>
      </form>
    </section>
  `;
}

function renderTasks() {
  if (!state.tasks.length) {
    return emptyState("还没有监控任务", "从系统推荐一键创建，或使用手动输入创建第一条任务。");
  }
  const rows = filteredTasks();
  const summary = taskListSummary();
  return `
    <section class="table-panel">
      <div class="table-header">
        <h2>任务列表</h2>
        <span>${rows.length} / ${state.tasks.length} 个任务 · ${summary.needsAction} 个有未处理提醒</span>
      </div>
      ${renderTaskFilters()}
      <div class="task-list">
        ${rows.length ? rows.map(renderTask).join("") : `<div class="inline-empty">没有匹配的任务，调整筛选条件后再试。</div>`}
      </div>
    </section>
  `;
}

function renderTaskFilters() {
  const filters = state.taskFilters || defaultState.taskFilters;
  return `
    <form class="task-filter-form" data-form="task-filters">
      <label>
        关键词
        <input name="query" value="${escapeHtml(filters.query)}" placeholder="任务 / 目的地 / 标签" />
      </label>
      <label>
        任务状态
        <select name="status">
          <option value="all" ${filters.status === "all" ? "selected" : ""}>全部</option>
          <option value="active" ${filters.status === "active" ? "selected" : ""}>启用</option>
          <option value="paused" ${filters.status === "paused" ? "selected" : ""}>暂停</option>
          <option value="booked" ${filters.status === "booked" ? "selected" : ""}>已购票</option>
        </select>
      </label>
      <label>
        提醒状态
        <select name="alertStatus">
          <option value="all" ${filters.alertStatus === "all" ? "selected" : ""}>全部提醒</option>
          <option value="needsAction" ${filters.alertStatus === "needsAction" ? "selected" : ""}>有未处理提醒</option>
          <option value="handled" ${filters.alertStatus === "handled" ? "selected" : ""}>有已处理提醒</option>
          <option value="ignored" ${filters.alertStatus === "ignored" ? "selected" : ""}>有已忽略提醒</option>
        </select>
      </label>
      <label>
        排序
        <select name="sortBy">
          <option value="deal" ${filters.sortBy === "deal" ? "selected" : ""}>入手建议优先</option>
          <option value="price" ${filters.sortBy === "price" ? "selected" : ""}>当前低价优先</option>
          <option value="departDate" ${filters.sortBy === "departDate" ? "selected" : ""}>出发日期最近</option>
          <option value="updatedAt" ${filters.sortBy === "updatedAt" ? "selected" : ""}>最近更新</option>
        </select>
      </label>
      <div class="task-filter-actions">
        <button class="ghost-button" data-action="reset-task-filters" type="button">重置</button>
        <button class="primary-button" type="submit">应用</button>
      </div>
    </form>
  `;
}

function renderTask(task) {
  const destinations = task.destinationIds.map(destinationById).filter(Boolean);
  const profile = profileForTask(task);
  const best = bestSnapshotForTask(task.id);
  const deal = evaluateDeal({ task, snapshots: snapshotsForTask(task.id) });
  const alertCounts = taskAlertCounts(task.id);
  const strategies = [
    task.monitorDirect ? "直飞" : null,
    task.monitorTransfer ? "中转" : null
  ].filter(Boolean);
  return `
    <article class="task-row">
      <div>
        <span class="status ${task.status}">${taskStatusLabel(task.status)}</span>
        <h3>${escapeHtml(task.name)}</h3>
        <p>${destinations.map((destination) => destination.name).join(" · ")}</p>
      </div>
      <div class="task-meta">
        <span>${task.departDate} 至 ${task.returnDate}${flexText(task)}</span>
        <span>${profile.displayName} · ${task.originCity}</span>
        <span>${strategies.join(" + ")}</span>
        <span>${task.passengerCount || 1} 人 · 单人预算 ${formatMoney(task.budgetAmount, task.budgetCurrency)}</span>
        <strong>${best ? formatMoney(best.priceAmount, best.priceCurrency) : "未采集"}</strong>
        ${best ? `<span>预计总价 ${formatMoney(totalPrice(best.priceAmount, task), best.priceCurrency)}</span>` : ""}
        <span class="decision-pill ${deal.status}">${deal.label}</span>
        ${alertCounts.needsAction ? `<span class="alert-badge">未处理提醒 ${alertCounts.needsAction}</span>` : ""}
      </div>
      <div class="row-actions">
        <button class="ghost-button" data-action="view-task" data-task-id="${task.id}">详情</button>
        ${task.status === "active" ? `<button class="ghost-button" data-action="simulate-task" data-task-id="${task.id}">采集</button>` : ""}
        <button class="ghost-button" data-action="toggle-task" data-task-id="${task.id}">${task.status === "active" ? "暂停" : "恢复"}</button>
        ${task.status === "booked" ? "" : `<button class="ghost-button" data-action="mark-task-booked" data-task-id="${task.id}">标记已购票</button>`}
        <button class="ghost-button danger-button" data-action="delete-task" data-task-id="${task.id}">删除</button>
      </div>
      ${renderTaskHistory(task)}
    </article>
  `;
}

function renderTaskHistory(task) {
  const snapshots = state.snapshots
    .filter((snapshot) => snapshot.watchTaskId === task.id)
    .slice(-6)
    .reverse();
  if (!snapshots.length) {
    return `<div class="history-line empty">暂无价格历史。点击“采集”生成一批模拟价格。</div>`;
  }
  return `
    <div class="history-line">
      ${snapshots
        .map((snapshot) => {
          const destination = destinationById(snapshot.destinationId);
          const strategy = snapshot.strategyType === "direct" ? "直飞" : "中转";
          return `<span>${destination?.name || "目的地"} ${strategy} ${formatMoney(snapshot.priceAmount, snapshot.priceCurrency)}</span>`;
        })
        .join("")}
    </div>
  `;
}

function filteredTasks() {
  const filters = state.taskFilters || defaultState.taskFilters;
  const query = filters.query.trim().toLowerCase();
  return state.tasks
    .filter((task) => {
      if (filters.status !== "all" && task.status !== filters.status) return false;
      const alertCounts = taskAlertCounts(task.id);
      if (filters.alertStatus === "needsAction" && !alertCounts.needsAction) return false;
      if (filters.alertStatus === "handled" && !alertCounts.handled) return false;
      if (filters.alertStatus === "ignored" && !alertCounts.ignored) return false;
      if (!query) return true;
      const destinations = task.destinationIds.map(destinationById).filter(Boolean);
      const searchable = [
        task.name,
        task.originCity,
        task.departDate,
        task.returnDate,
        ...destinations.flatMap((destination) => [
          destination.name,
          destination.countryOrRegion,
          ...destination.airportCodes,
          ...destination.tags
        ])
      ]
        .join(" ")
        .toLowerCase();
      return searchable.includes(query);
    })
    .sort(compareTasks(filters.sortBy));
}

function compareTasks(sortBy) {
  return (a, b) => {
    if (sortBy === "price") return nullableNumber(bestSnapshotForTask(a.id)?.priceAmount) - nullableNumber(bestSnapshotForTask(b.id)?.priceAmount);
    if (sortBy === "departDate") return new Date(a.departDate) - new Date(b.departDate);
    if (sortBy === "updatedAt") return new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);

    const dealA = evaluateDeal({ task: a, snapshots: snapshotsForTask(a.id) });
    const dealB = evaluateDeal({ task: b, snapshots: snapshotsForTask(b.id) });
    if (dealB.score !== dealA.score) return dealB.score - dealA.score;
    return nullableNumber(bestSnapshotForTask(a.id)?.priceAmount) - nullableNumber(bestSnapshotForTask(b.id)?.priceAmount);
  };
}

function taskListSummary() {
  return state.tasks.reduce(
    (summary, task) => {
      const counts = taskAlertCounts(task.id);
      summary.needsAction += counts.needsAction;
      if (task.status === "active") summary.active += 1;
      if (task.status === "paused") summary.paused += 1;
      if (task.status === "booked") summary.booked += 1;
      return summary;
    },
    { active: 0, paused: 0, booked: 0, needsAction: 0 }
  );
}

function taskAlertCounts(taskId) {
  return state.alerts
    .filter((alert) => alert.watchTaskId === taskId)
    .reduce(
      (counts, alert) => {
        const status = alert.sendStatus || "preview";
        counts.total += 1;
        if (status === "handled") counts.handled += 1;
        else if (status === "ignored") counts.ignored += 1;
        else counts.needsAction += 1;
        return counts;
      },
      { total: 0, needsAction: 0, handled: 0, ignored: 0 }
    );
}

function nullableNumber(value) {
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function taskStatusLabel(status) {
  if (status === "booked") return "已购票";
  if (status === "paused") return "暂停";
  return "启用";
}

function renderTaskDetail() {
  const task = state.tasks.find((item) => item.id === state.selectedTaskId);
  if (!task) {
    return emptyState("没有找到任务", "返回任务列表重新选择一个监控任务。");
  }

  const destinations = task.destinationIds.map(destinationById).filter(Boolean);
  const snapshots = snapshotsForTask(task.id);
  const filteredSnapshots = filteredSnapshotsForTask(task, snapshots);
  const alerts = state.alerts.filter((alert) => alert.watchTaskId === task.id);
  const best = bestSnapshotForTask(task.id);
  const deal = evaluateDeal({ task, snapshots });

  return `
    <section class="detail-toolbar">
      <button class="ghost-button" data-view="tasks">返回任务列表</button>
      <div class="detail-toolbar-actions">
        <button class="ghost-button" data-action="clear-task-history" data-task-id="${task.id}">清空记录</button>
        ${task.status === "booked" ? "" : `<button class="ghost-button" data-action="mark-task-booked" data-task-id="${task.id}">标记已购票</button>`}
        <button class="ghost-button danger-button" data-action="delete-task" data-task-id="${task.id}">删除任务</button>
        ${task.status === "active" ? `<button class="primary-button" data-action="simulate-task" data-task-id="${task.id}">立即采集</button>` : ""}
      </div>
    </section>
    <section class="task-detail-grid">
      <article class="detail-panel main-detail">
        <span class="status ${task.status}">${taskStatusLabel(task.status)}</span>
        <h2>${escapeHtml(task.name)}</h2>
        <p>${destinations.map((destination) => destination.name).join(" · ")}</p>
        <div class="detail-kpis">
          ${detailKpi("日期", `${task.departDate} 至 ${task.returnDate}`)}
          ${detailKpi("日期浮动", flexText(task) || "不浮动")}
          ${detailKpi("出发", `${task.originCity} (${task.originAirportCodes.join(" / ")})`)}
          ${detailKpi("乘客", `${task.passengerCount || 1} 人`)}
          ${detailKpi("单人预算", formatMoney(task.budgetAmount, task.budgetCurrency))}
          ${detailKpi("当前最低", best ? formatMoney(best.priceAmount, best.priceCurrency) : "未采集")}
          ${detailKpi("预计总价", best ? formatMoney(totalPrice(best.priceAmount, task), best.priceCurrency) : "未采集")}
        </div>
      </article>
      <article class="detail-panel">
        <h2>策略对比</h2>
        ${renderStrategyComparison(task)}
      </article>
    </section>
    <section class="detail-panel decision-panel">
      <div>
        <span class="decision-pill ${deal.status}">${deal.label}</span>
        <h2>入手建议</h2>
        <p>${deal.reason}</p>
      </div>
      ${renderBestDeal(task, deal)}
    </section>
    <section class="detail-panel">
      <div class="table-header">
        <h2>编辑监控配置</h2>
        <span>影响后续采集</span>
      </div>
      ${renderTaskEditForm(task)}
    </section>
    <section class="detail-panel">
      <div class="table-header">
        <h2>价格趋势</h2>
        <span>${snapshots.length ? `${snapshots.length} 条快照` : "暂无数据"}</span>
      </div>
      ${renderPriceVisuals(task, snapshots)}
    </section>
    <section class="detail-panel">
      <div class="table-header">
        <h2>候选日期组合</h2>
        <span>${dateOptionsForTask(task).length} 组</span>
      </div>
      ${renderDateOptions(task)}
    </section>
    <section class="detail-panel">
      <div class="table-header">
        <h2>手动录入价格</h2>
        <span>真实查询结果</span>
      </div>
      ${renderManualPriceForm(task)}
    </section>
    <section class="detail-panel">
      <div class="table-header">
        <h2>最近价格快照</h2>
        <span>${filteredSnapshots.length} / ${snapshots.length} 条记录</span>
      </div>
      ${renderSnapshotFilters(task, filteredSnapshots)}
      ${renderSnapshotTable(filteredSnapshots)}
    </section>
    <section class="detail-panel">
      <div class="table-header">
        <h2>提醒记录</h2>
        <span>${alerts.length} 条提醒</span>
      </div>
      ${alerts.length ? alerts.slice().reverse().map(renderCompactAlert).join("") : "<p>暂无提醒记录。</p>"}
    </section>
  `;
}

function renderBestDeal(task, deal) {
  if (!deal.bestSnapshot) {
    return `<div class="best-deal empty">采集价格后会显示最佳候选方案。</div>`;
  }

  const snapshot = deal.bestSnapshot;
  const destination = destinationById(snapshot.destinationId);
  const strategy = snapshot.strategyType === "direct" ? "直飞" : "中转";
  const budgetDiff = task.budgetAmount - snapshot.priceAmount;
  const total = totalPrice(snapshot.priceAmount, task);
  return `
    <div class="best-deal">
      <div>
        <span>最佳候选</span>
        <strong>${destination?.name || "目的地"} · ${strategy}</strong>
      </div>
      <div>
        <span>日期</span>
        <strong>${snapshot.departDate} 至 ${snapshot.returnDate}</strong>
      </div>
      <div>
        <span>单人价格</span>
        <strong>${formatMoney(snapshot.priceAmount, snapshot.priceCurrency)}</strong>
      </div>
      <div>
        <span>预计总价</span>
        <strong>${formatMoney(total, snapshot.priceCurrency)}</strong>
      </div>
      <div>
        <span>预算差额</span>
        <strong>${budgetDiff >= 0 ? `低于预算 ${formatMoney(budgetDiff, task.budgetCurrency)}` : `超出预算 ${formatMoney(Math.abs(budgetDiff), task.budgetCurrency)}`}</strong>
      </div>
      <div>
        <span>历史参考</span>
        <strong>历史最低 ${formatMoney(deal.historicalLow, task.budgetCurrency)}</strong>
      </div>
      <div>
        <span>航班</span>
        <strong>${snapshot.airline} · ${minutesToText(snapshot.durationMinutes)}</strong>
      </div>
      <div>
        <span>来源</span>
        <strong>${snapshot.source || "未知来源"}</strong>
      </div>
      <div>
        <span>行李</span>
        <strong>${snapshot.includesCheckedBag ? "含托运行李" : "未含托运行李"}</strong>
      </div>
    </div>
  `;
}

function detailKpi(label, value) {
  return `
    <div>
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function renderTaskEditForm(task) {
  const selectedDestinationIds = new Set(task.destinationIds || []);
  const destinationCheckboxes = allDestinations()
    .map(
      (destination) => `
        <label class="checkbox destination-choice">
          <input type="checkbox" name="editDestinationIds" value="${destination.id}" ${selectedDestinationIds.has(destination.id) ? "checked" : ""} />
          <span>
            <strong>${escapeHtml(destination.name)}</strong>
            <small>${destination.isDomestic ? "国内" : "国际及港澳台"} · ${escapeHtml(destination.airportCodes.join(" / "))}</small>
          </span>
        </label>
      `
    )
    .join("");
  return `
    <form class="task-edit-form" data-form="task-edit" data-task-id="${task.id}">
      <label>
        任务名称
        <input name="name" value="${escapeHtml(task.name)}" required />
      </label>
      <label>
        出发日期
        <input name="departDate" type="date" value="${task.departDate}" required />
      </label>
      <label>
        返程日期
        <input name="returnDate" type="date" value="${task.returnDate}" required />
      </label>
      <label>
        前移天数
        <input name="dateFlexDaysBefore" type="number" min="0" max="7" value="${Number(task.dateFlexDaysBefore) || 0}" required />
      </label>
      <label>
        后移天数
        <input name="dateFlexDaysAfter" type="number" min="0" max="7" value="${Number(task.dateFlexDaysAfter) || 0}" required />
      </label>
      <label>
        乘客人数
        <input name="passengerCount" type="number" min="1" max="9" value="${Number(task.passengerCount) || 1}" required />
      </label>
      <label>
        单人预算
        <input name="budgetAmount" type="number" min="300" step="10" value="${Number(task.budgetAmount) || 2200}" required />
      </label>
      <fieldset>
        <legend>监控策略</legend>
        <label class="checkbox"><input type="checkbox" name="direct" ${task.monitorDirect ? "checked" : ""} /> 直飞</label>
        <label class="checkbox"><input type="checkbox" name="transfer" ${task.monitorTransfer ? "checked" : ""} /> 中转</label>
      </fieldset>
      <fieldset class="destination-picker">
        <legend>候选目的地</legend>
        <p>修改目的地后，后续采集会使用新的目的地池；已有快照默认保留。</p>
        <div>${destinationCheckboxes}</div>
      </fieldset>
      <label class="checkbox clear-history-option">
        <input type="checkbox" name="clearHistory" />
        保存时清空该任务已有价格快照和提醒
      </label>
      <button class="primary-button" type="submit">保存监控配置</button>
    </form>
  `;
}

function renderStrategyComparison(task) {
  const strategies = [
    task.monitorDirect ? "direct" : null,
    task.monitorTransfer ? "transfer" : null
  ].filter(Boolean);

  if (!strategies.length) return "<p>暂无启用策略。</p>";

  return `
    <div class="strategy-grid">
      ${strategies
        .map((strategyType) => {
          const summary = summarizeSnapshots(snapshotsForTask(task.id).filter((snapshot) => snapshot.strategyType === strategyType));
          const label = strategyType === "direct" ? "直飞" : "中转";
          return `
            <div class="strategy-card">
              <span>${label}</span>
              <strong>${summary.current ? formatMoney(summary.current.priceAmount, summary.current.priceCurrency) : "未采集"}</strong>
              <small>历史最低 ${summary.historicalLow ? formatMoney(summary.historicalLow, task.budgetCurrency) : "-"}</small>
              <small>近 30 次均价 ${summary.average30 ? formatMoney(Math.round(summary.average30), task.budgetCurrency) : "-"}</small>
              <small>${trendText(summary.trendPercent)}</small>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderSnapshotTable(snapshots) {
  if (!snapshots.length) return "<p>暂无价格快照。点击“立即采集”生成模拟数据。</p>";

  const rows = snapshots
    .slice()
    .reverse()
    .slice(0, 12)
    .map((snapshot) => {
      const destination = destinationById(snapshot.destinationId);
      const strategy = snapshot.strategyType === "direct" ? "直飞" : "中转";
      const transfer = snapshot.transferCities.length ? snapshot.transferCities.join(" / ") : "-";
      const lowPrice = bestSnapshotForSeries(
        snapshot.watchTaskId,
        snapshot.destinationId,
        snapshot.strategyType,
        snapshot.departDate,
        snapshot.returnDate
      )?.priceAmount;
      const barWidth = Math.max(18, Math.min(100, Math.round((snapshot.priceAmount / Math.max(lowPrice || snapshot.priceAmount, 1)) * 55)));
      return `
        <tr>
          <td>${formatDateTime(snapshot.searchedAt)}</td>
          <td>${destination?.name || "目的地"}</td>
          <td>${snapshot.departDate} 至 ${snapshot.returnDate}</td>
          <td>${strategy}</td>
          <td>${snapshot.airline}</td>
          <td>${minutesToText(snapshot.durationMinutes)}</td>
          <td>${transfer}</td>
          <td>${snapshot.source || "-"}</td>
          <td>${snapshot.includesCheckedBag ? "含" : "不含"}</td>
          <td>
            <div class="price-cell">
              <strong>${formatMoney(snapshot.priceAmount, snapshot.priceCurrency)}</strong>
              <span style="width: ${barWidth}%"></span>
            </div>
          </td>
          <td>${snapshot.bookingUrl ? `<a href="${escapeHtml(snapshot.bookingUrl)}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="data-table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>查询时间</th>
            <th>目的地</th>
            <th>日期</th>
            <th>策略</th>
            <th>航司</th>
            <th>耗时</th>
            <th>中转</th>
            <th>来源</th>
            <th>行李</th>
            <th>价格</th>
            <th>链接</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderSnapshotFilters(task, snapshots) {
  const filters = state.snapshotFilters || defaultState.snapshotFilters;
  const destinations = task.destinationIds.map(destinationById).filter(Boolean);
  const dateOptions = dateOptionsForTask(task);
  const csvHref = buildSnapshotCsvHref(snapshots);
  return `
    <form class="snapshot-filter-form" data-form="snapshot-filters">
      <label>
        目的地
        <select name="destinationId">
          <option value="all" ${filters.destinationId === "all" ? "selected" : ""}>全部目的地</option>
          ${destinations.map((destination) => `<option value="${destination.id}" ${filters.destinationId === destination.id ? "selected" : ""}>${escapeHtml(destination.name)}</option>`).join("")}
        </select>
      </label>
      <label>
        策略
        <select name="strategyType">
          <option value="all" ${filters.strategyType === "all" ? "selected" : ""}>全部策略</option>
          <option value="direct" ${filters.strategyType === "direct" ? "selected" : ""}>直飞</option>
          <option value="transfer" ${filters.strategyType === "transfer" ? "selected" : ""}>中转</option>
        </select>
      </label>
      <label>
        日期组合
        <select name="datePair">
          <option value="all" ${filters.datePair === "all" ? "selected" : ""}>全部日期</option>
          ${dateOptions.map((option) => {
            const value = `${option.departDate}|${option.returnDate}`;
            return `<option value="${value}" ${filters.datePair === value ? "selected" : ""}>${option.departDate} 至 ${option.returnDate} · ${option.label}</option>`;
          }).join("")}
        </select>
      </label>
      <div class="snapshot-filter-actions">
        <a class="ghost-button" href="${csvHref}" download="${safeFileName(task.name)}-snapshots.csv">导出 CSV</a>
        <button class="ghost-button" data-action="reset-snapshot-filters" type="button">重置</button>
        <button class="primary-button" type="submit">应用</button>
      </div>
    </form>
  `;
}

function filteredSnapshotsForTask(task, snapshots) {
  const filters = state.snapshotFilters || defaultState.snapshotFilters;
  return snapshots.filter((snapshot) => {
    if (filters.destinationId !== "all" && snapshot.destinationId !== filters.destinationId) return false;
    if (filters.strategyType !== "all" && snapshot.strategyType !== filters.strategyType) return false;
    if (filters.datePair !== "all" && `${snapshot.departDate}|${snapshot.returnDate}` !== filters.datePair) return false;
    return snapshot.watchTaskId === task.id;
  });
}

function renderManualPriceForm(task) {
  const destinationOptions = task.destinationIds
    .map(destinationById)
    .filter(Boolean)
    .map((destination) => `<option value="${destination.id}">${destination.name}</option>`)
    .join("");
  const dateOptions = dateOptionsForTask(task)
    .map((option) => `<option value="${option.departDate}|${option.returnDate}">${option.departDate} 至 ${option.returnDate} · ${option.label}</option>`)
    .join("");
  const strategyOptions = [
    task.monitorDirect ? `<option value="direct">直飞</option>` : "",
    task.monitorTransfer ? `<option value="transfer">中转</option>` : ""
  ].join("");

  return `
    <form class="manual-price-form" data-form="manual-price">
      <label>
        目的地
        <select name="destinationId">${destinationOptions}</select>
      </label>
      <label>
        日期组合
        <select name="datePair">${dateOptions}</select>
      </label>
      <label>
        策略
        <select name="strategyType">${strategyOptions}</select>
      </label>
      <label>
        价格
        <input name="priceAmount" type="number" min="1" step="1" placeholder="1680" required />
      </label>
      <label>
        航司
        <input name="airline" placeholder="例如：东方航空" />
      </label>
      <label>
        总耗时（分钟）
        <input name="durationMinutes" type="number" min="1" step="1" placeholder="460" />
      </label>
      <label>
        中转城市
        <input name="transferCities" placeholder="例如：首尔, 香港" />
      </label>
      <label>
        来源
        <input name="source" placeholder="例如：航司官网 / 携程" />
      </label>
      <label>
        购票链接
        <input name="bookingUrl" placeholder="https://..." />
      </label>
      <label class="checkbox">
        <input type="checkbox" name="includesCheckedBag" checked />
        含托运行李
      </label>
      <button class="primary-button" type="submit">保存价格快照</button>
    </form>
    <div class="csv-import-panel">
      <h3>批量导入 CSV</h3>
      <p>表头：destination,departDate,returnDate,strategyType,priceAmount,airline,durationMinutes,transferCities,source,bookingUrl,includesCheckedBag</p>
      <textarea data-field="csv-import" placeholder="destination,departDate,returnDate,strategyType,priceAmount,airline,durationMinutes,transferCities,source,bookingUrl,includesCheckedBag">${escapeHtml(state.csvImportText)}</textarea>
      <div class="backup-actions">
        <button class="ghost-button" data-action="load-csv-example" type="button">填入示例</button>
        <button class="primary-button" data-action="import-price-csv" type="button">导入 CSV</button>
      </div>
      ${state.csvImportMessage ? `<span class="backup-message">${escapeHtml(state.csvImportMessage)}</span>` : ""}
    </div>
  `;
}

function renderPriceVisuals(task, snapshots) {
  if (!snapshots.length) {
    return `<p>暂无价格趋势。点击“立即采集”后会显示价格走势和日期热力。</p>`;
  }

  const chart = buildTrendChart(snapshots);
  return `
    <div class="price-visual-grid">
      <div class="trend-card">
        <div class="trend-scale">
          <strong>${formatMoney(chart.maxPrice, task.budgetCurrency)}</strong>
          <span>${formatMoney(chart.minPrice, task.budgetCurrency)}</span>
        </div>
        <svg class="trend-chart" viewBox="0 0 320 120" role="img" aria-label="最近价格走势">
          <polyline points="${chart.areaPoints}" fill="rgba(15, 123, 108, 0.12)" stroke="none"></polyline>
          <polyline points="${chart.linePoints}" fill="none" stroke="#0f7b6c" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></polyline>
          ${chart.dots.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="4"></circle>`).join("")}
        </svg>
      </div>
      <div class="heat-grid">
        ${dateOptionsForTask(task)
          .map((option) => {
            const best = bestSnapshotForDateOption(task.id, option.departDate, option.returnDate);
            return `
              <div class="heat-cell ${heatClass(best, task)}">
                <strong>${option.departDate}</strong>
                <span>${option.returnDate}</span>
                <small>${best ? formatMoney(best.priceAmount, best.priceCurrency) : "未采集"}</small>
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderCompactAlert(alert) {
  const snapshot = state.snapshots.find((item) => item.id === alert.flightPriceSnapshotId);
  const destination = snapshot ? destinationById(snapshot.destinationId) : null;
  return `
    <div class="compact-alert">
      <strong>${destination ? destination.name : "目的地"} · ${snapshot?.strategyType === "direct" ? "直飞" : "中转"}</strong>
      <span>${formatDateTime(alert.sentAt)} · ${escapeHtml(alert.triggerReason)}</span>
    </div>
  `;
}

function buildTrendChart(snapshots) {
  const ordered = snapshots
    .slice()
    .sort((a, b) => new Date(a.searchedAt) - new Date(b.searchedAt))
    .slice(-24);
  const prices = ordered.map((snapshot) => snapshot.priceAmount);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const range = Math.max(maxPrice - minPrice, 1);
  const width = 300;
  const height = 88;
  const left = 10;
  const top = 14;
  const step = ordered.length > 1 ? width / (ordered.length - 1) : width;
  const dots = ordered.map((snapshot, index) => ({
    x: Math.round(left + index * step),
    y: Math.round(top + height - ((snapshot.priceAmount - minPrice) / range) * height)
  }));
  const linePoints = dots.map((point) => `${point.x},${point.y}`).join(" ");
  const areaPoints = `${left},${top + height} ${linePoints} ${left + width},${top + height}`;

  return { minPrice, maxPrice, dots, linePoints, areaPoints };
}

function heatClass(snapshot, task) {
  if (!snapshot) return "empty";
  const ratio = snapshot.priceAmount / task.budgetAmount;
  if (ratio <= 0.85) return "low";
  if (ratio <= 1) return "mid";
  return "high";
}

function renderDateOptions(task) {
  return `
    <div class="date-option-list">
      ${dateOptionsForTask(task)
        .map((option) => {
          const best = bestSnapshotForDateOption(task.id, option.departDate, option.returnDate);
          return `
            <div>
              <strong>${option.departDate} 至 ${option.returnDate}</strong>
              <span>${option.label}</span>
              <small>${best ? `当前最低 ${formatMoney(best.priceAmount, best.priceCurrency)}` : "尚未采集"}</small>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderDestinations() {
  const rows = filteredDestinations();
  return `
    <section class="section-header">
      <div>
        <h2>系统推荐与自定义目的地</h2>
        <p>内置目的地优先用于推荐；手动创建任务时输入的新目的地会保存到这里，后续可继续选择。</p>
      </div>
    </section>
    ${renderDestinationFilters(rows)}
    <section class="destination-grid">
      ${rows.length ? rows.map(renderDestination).join("") : emptyState("没有匹配的目的地", "调整关键词、地区或标签筛选后再试。")}
    </section>
  `;
}

function renderDestinationFilters(rows) {
  const filters = state.destinationFilters || defaultState.destinationFilters;
  const tags = destinationFilterTags();
  return `
    <section class="destination-filter-panel">
      <form class="destination-filter-form" data-form="destination-filters">
        <label>
          关键词
          <input name="query" value="${escapeHtml(filters.query)}" placeholder="目的地 / 国家地区 / 机场 / 标签" />
        </label>
        <label>
          地区
          <select name="region">
            <option value="all" ${filters.region === "all" ? "selected" : ""}>全部地区</option>
            <option value="domestic" ${filters.region === "domestic" ? "selected" : ""}>国内航线</option>
            <option value="international" ${filters.region === "international" ? "selected" : ""}>国际及港澳台</option>
          </select>
        </label>
        <label>
          标签
          <select name="tag">
            <option value="all" ${filters.tag === "all" ? "selected" : ""}>全部标签</option>
            ${tags.map((tag) => `<option value="${escapeHtml(tag)}" ${filters.tag === tag ? "selected" : ""}>${escapeHtml(tag)}</option>`).join("")}
          </select>
        </label>
        <div class="destination-filter-actions">
          <strong>${rows.length} / ${allDestinations().length}</strong>
          <span>当前匹配</span>
          <button class="ghost-button" data-action="reset-destination-filters" type="button">重置</button>
          <button class="primary-button" type="submit">应用筛选</button>
        </div>
      </form>
    </section>
  `;
}

function renderDestination(destination) {
  const score = scoreDestination(destination);
  return `
    <article class="destination-card">
      <div class="card-topline">
        <span>${destination.isSystemRecommended ? "系统推荐" : "自定义"} · ${destination.isDomestic ? "国内" : "国际及港澳台"}</span>
        <strong>${score}</strong>
      </div>
      <h3>${destination.name}</h3>
      <p>${destination.reason}</p>
      <div class="tags">${destination.tags.map((tag) => `<span class="tag">${tag}</span>`).join("")}</div>
      <dl>
        <div><dt>机场</dt><dd>${destination.airportCodes.join(" / ")}</dd></div>
        <div><dt>适合</dt><dd>${destination.recommendedHolidayTypes.join(" / ")}</dd></div>
        <div><dt>签证</dt><dd>${destination.visaNote}</dd></div>
      </dl>
    </article>
  `;
}

function filteredDestinations() {
  const filters = state.destinationFilters || defaultState.destinationFilters;
  const query = filters.query.trim().toLowerCase();
  return allDestinations()
    .filter((destination) => {
      if (filters.region === "domestic" && !destination.isDomestic) return false;
      if (filters.region === "international" && destination.isDomestic) return false;
      if (filters.tag !== "all" && !destination.tags.includes(filters.tag)) return false;
      if (!query) return true;
      return [
        destination.name,
        destination.countryOrRegion,
        destination.reason,
        destination.travelValueNote,
        destination.visaNote,
        ...destination.airportCodes,
        ...destination.tags
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .sort((a, b) => b.priority - a.priority);
}

function destinationFilterTags() {
  return Array.from(new Set(allDestinations().flatMap((destination) => destination.tags))).sort((a, b) =>
    a.localeCompare(b, "zh-CN")
  );
}

function renderAlerts() {
  if (!state.alerts.length) {
    return emptyState("暂无提醒", "当价格低于预算、刷新历史低价或显著低于近期均价时，这里会生成邮件提醒记录。");
  }
  return `
    <section class="alert-list">
      ${state.alerts
        .slice()
        .reverse()
        .map(renderAlert)
        .join("")}
    </section>
  `;
}

function renderSettings() {
  const profile = activeProfile();
  const profileOptions = state.profiles
    .map(
      (item) => `<option value="${item.id}" ${item.id === state.activeProfileId ? "selected" : ""}>${escapeHtml(item.displayName)} · ${escapeHtml(item.originCity)}</option>`
    )
    .join("");
  return `
    <section class="settings-grid">
      <article class="detail-panel profile-panel">
        <p class="eyebrow">Profile</p>
        <h2>旅客档案</h2>
        <p>v1 默认个人使用；本地档案会作为任务归属、收件邮箱和出发机场的来源，后续可迁移为多人账号。</p>
        <div class="profile-switcher">
          <label>
            当前档案
            <select name="activeProfileId" data-field="active-profile-id">
              ${profileOptions}
            </select>
          </label>
          <button class="ghost-button" data-action="switch-profile" type="button">切换</button>
          <button class="ghost-button" data-action="create-profile" type="button">新增档案</button>
        </div>
        <form class="settings-form" data-form="profile">
          <label>
            显示名称
            <input name="displayName" value="${escapeHtml(profile.displayName)}" required />
          </label>
          <label>
            档案邮箱
            <input name="profileEmail" type="email" value="${escapeHtml(profile.email)}" required />
          </label>
          <label>
            出发城市
            <input name="originCity" value="${escapeHtml(profile.originCity)}" required />
          </label>
          <label>
            出发机场代码
            <input name="originAirportCodes" value="${escapeHtml(profile.originAirportCodes.join(", "))}" required />
          </label>
          <label>
            偏好标签
            <input name="preferredDestinationTags" value="${escapeHtml(profile.preferredDestinationTags.join(", "))}" />
          </label>
          <button class="primary-button" type="submit">保存档案</button>
        </form>
      </article>
      <article class="detail-panel">
        <p class="eyebrow">Email</p>
        <h2>提醒设置</h2>
        <p>v1 仍然使用邮件预览，不会自动发送外部邮件；这里的邮箱会用于生成邮件草稿链接。</p>
        <form class="settings-form" data-form="settings">
          <label>
            收件邮箱
            <input name="email" type="email" value="${escapeHtml(state.settings.email)}" required />
          </label>
          <label>
            提醒冷却时间（小时）
            <input name="cooldownHours" type="number" min="1" max="168" value="${state.settings.cooldownHours}" required />
          </label>
          <label class="checkbox">
            <input type="checkbox" name="alertBudgetEnabled" ${state.settings.alertBudgetEnabled ? "checked" : ""} />
            价格低于预算时提醒
          </label>
          <label class="checkbox">
            <input type="checkbox" name="alertHistoricalLowEnabled" ${state.settings.alertHistoricalLowEnabled ? "checked" : ""} />
            刷新该任务历史最低价时提醒
          </label>
          <label class="checkbox">
            <input type="checkbox" name="alertAverageDropEnabled" ${state.settings.alertAverageDropEnabled ? "checked" : ""} />
            显著低于近期均价时提醒
          </label>
          <label>
            近期均价折扣阈值（%）
            <input name="alertAverageDropPercent" type="number" min="1" max="80" value="${state.settings.alertAverageDropPercent}" required />
          </label>
          <label>
            默认币种
            <select name="defaultCurrency">
              <option value="CNY" ${state.settings.defaultCurrency === "CNY" ? "selected" : ""}>CNY</option>
            </select>
          </label>
          <label>
            自动采集间隔（分钟）
            <input name="autoCollectIntervalMinutes" type="number" min="1" max="1440" value="${state.settings.autoCollectIntervalMinutes}" required />
          </label>
          <label class="checkbox">
            <input type="checkbox" name="autoCollectEnabled" ${state.settings.autoCollectEnabled ? "checked" : ""} />
            页面打开期间自动采集
          </label>
          <label class="checkbox">
            <input type="checkbox" name="autoPruneSnapshots" ${state.settings.autoPruneSnapshots ? "checked" : ""} />
            自动清理旧价格快照
          </label>
          <label>
            每个任务最多保留快照
            <input name="maxSnapshotsPerTask" type="number" min="50" max="5000" value="${state.settings.maxSnapshotsPerTask}" required />
          </label>
          <div class="maintenance-actions">
            <button class="ghost-button" data-action="prune-snapshots-now" type="button">立即清理旧快照</button>
            ${state.maintenanceMessage ? `<span class="backup-message">${escapeHtml(state.maintenanceMessage)}</span>` : ""}
          </div>
          <button class="primary-button" type="submit">保存设置</button>
        </form>
      </article>
      <article class="detail-panel">
        <p class="eyebrow">Custom</p>
        <h2>自定义节假日</h2>
        <p>手动创建任务时输入的新节假日会保存到本地，之后会出现在手动创建下拉框里。</p>
        <div class="custom-destination-list">
          ${
            state.customHolidays.length
              ? state.customHolidays.map(renderCustomHolidayRow).join("")
              : "<span>暂无自定义节假日。</span>"
          }
        </div>
      </article>
      <article class="detail-panel">
        <p class="eyebrow">Custom</p>
        <h2>自定义目的地</h2>
        <p>手动创建任务时输入的新目的地会保存到本地，之后会出现在目的地库和手动创建下拉框里。</p>
        <div class="custom-destination-list">
          ${
            state.customDestinations.length
              ? state.customDestinations.map(renderCustomDestinationRow).join("")
              : "<span>暂无自定义目的地。</span>"
          }
        </div>
      </article>
      <article class="detail-panel data-source-panel">
        <p class="eyebrow">Sources</p>
        <h2>价格来源</h2>
        <p>自动采集、手动录入和 CSV 导入现在使用统一价格快照结构；接入真实 API 时只需要新增价格来源适配器。</p>
        <div class="source-list">
          ${listPriceSources().map(renderPriceSource).join("")}
        </div>
      </article>
      <article class="detail-panel notification-panel">
        <p class="eyebrow">Notify</p>
        <h2>提醒通道</h2>
        <p>v1 在浏览器内生成邮件草稿；如果没有默认邮件客户端，可以下载 .eml 文件后再发送或归档。</p>
        <div class="source-list">
          ${listNotificationChannels().map(renderNotificationChannel).join("")}
        </div>
      </article>
      <article class="detail-panel backup-panel">
        <p class="eyebrow">Backup</p>
        <h2>数据备份</h2>
        <p>导出当前本地数据，或粘贴之前导出的 JSON 恢复数据。</p>
        <div class="backup-actions">
          <button class="ghost-button" data-action="export-backup" type="button">生成导出 JSON</button>
          <button class="primary-button" data-action="import-backup" type="button">导入 JSON</button>
        </div>
        <textarea name="backupText" data-field="backup-text" placeholder="点击生成导出 JSON，或在这里粘贴要导入的 JSON。">${escapeHtml(state.backupText)}</textarea>
        ${state.backupMessage ? `<span class="backup-message">${escapeHtml(state.backupMessage)}</span>` : ""}
      </article>
    </section>
  `;
}

function renderCustomHolidayRow(holiday) {
  return `
    <div>
      <strong>${escapeHtml(holiday.name)}</strong>
      <span>${holiday.startDate} 至 ${holiday.endDate} · ${escapeHtml(holiday.reason)}</span>
    </div>
  `;
}

function renderCustomDestinationRow(destination) {
  return `
    <div>
      <strong>${escapeHtml(destination.name)}</strong>
      <span>${escapeHtml(destination.countryOrRegion)} · ${destination.airportCodes.join(" / ")} · ${destination.tags.join(" / ")}</span>
    </div>
  `;
}

function renderPriceSource(source) {
  return `
    <div class="source-item">
      <div>
        <strong>${escapeHtml(source.name)}</strong>
        <span>${escapeHtml(source.note)}</span>
      </div>
      <small>${source.mode === "automatic" ? "自动采集" : "手动导入"} · ${source.status === "enabled" ? "已启用" : "未启用"}</small>
    </div>
  `;
}

function renderNotificationChannel(channel) {
  return `
    <div class="source-item">
      <div>
        <strong>${escapeHtml(channel.name)}</strong>
        <span>${escapeHtml(channel.note)}</span>
      </div>
      <small>${channel.status === "enabled" ? "已启用" : "计划中"}</small>
    </div>
  `;
}

function renderAlert(alert) {
  const snapshot = state.snapshots.find((item) => item.id === alert.flightPriceSnapshotId);
  const task = state.tasks.find((item) => item.id === alert.watchTaskId);
  const destination = snapshot ? destinationById(snapshot.destinationId) : null;
  const historyText = [
    alert.historicalLow ? `历史最低 ${formatMoney(alert.historicalLow, snapshot?.priceCurrency)}` : null,
    alert.average30 ? `近 30 次均价 ${formatMoney(Math.round(alert.average30), snapshot?.priceCurrency)}` : null,
    alert.cooldownHours ? `${alert.cooldownHours} 小时冷却` : null
  ]
    .filter(Boolean)
    .join(" · ");
  const emailDraft = buildEmailDraft({ alert, task, snapshot, destination });
  const mailto = buildMailtoLink(emailDraft);
  const emlHref = buildEmlDataHref(emailDraft);
  return `
    <article class="alert-card">
      <div>
        <span class="status ${alert.sendStatus || "preview"}">${alertStatusLabel(alert.sendStatus)}</span>
        <h3>${escapeHtml(alert.subject)}</h3>
        <p>${escapeHtml(alert.triggerReason)}</p>
        <small>${historyText}</small>
      </div>
      <div class="alert-meta">
        <span>${formatDateTime(alert.sentAt)}</span>
        <span>${destination ? destination.name : "目的地"}</span>
        <a class="primary-button" href="${mailto}">打开邮件</a>
        <a class="ghost-button" href="${emlHref}" download="${safeFileName(alert.id)}.eml">下载 .eml</a>
        <button class="ghost-button" data-action="mark-alert-handled" data-alert-id="${alert.id}" type="button">标记已处理</button>
        <button class="ghost-button" data-action="mark-alert-ignored" data-alert-id="${alert.id}" type="button">忽略</button>
      </div>
    </article>
  `;
}

function alertStatusLabel(status) {
  if (status === "handled") return "已处理";
  if (status === "ignored") return "已忽略";
  return "邮件预览";
}

function emptyState(title, body) {
  return `
    <section class="empty-state">
      <h2>${title}</h2>
      <p>${body}</p>
      <button class="primary-button" data-view="recommendations">查看系统推荐</button>
    </section>
  `;
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeView = button.dataset.view;
      render();
    });
  });

  document.querySelectorAll("[data-action='create-from-preset']").forEach((button) => {
    button.addEventListener("click", () => {
      const taskId = createTaskFromPreset(button.dataset.presetId);
      simulateTask(taskId);
      state.activeView = "tasks";
      render();
    });
  });

  document.querySelectorAll("[data-action='customize-preset']").forEach((button) => {
    button.addEventListener("click", () => {
      createManualDraftFromPreset(button.dataset.presetId);
      state.activeView = "recommendations";
      render();
      window.setTimeout(() => {
        document.querySelector("#manual-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    });
  });

  document.querySelectorAll("[data-action='preview-preset']").forEach((button) => {
    button.addEventListener("click", () => {
      const preset = RECOMMENDATION_PRESETS.find((item) => item.id === button.dataset.presetId);
      if (!preset) return;
      state.activeView = "destinations";
      render();
    });
  });

  document.querySelector("[data-action='clear-manual-draft']")?.addEventListener("click", () => {
    state.manualDraft = null;
    render();
  });

  document.querySelector("[data-form='destination-filters']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    applyDestinationFilters(new FormData(event.currentTarget));
    render();
  });

  document.querySelector("[data-action='reset-destination-filters']")?.addEventListener("click", () => {
    state.destinationFilters = { ...defaultState.destinationFilters };
    render();
  });

  document.querySelector("[data-form='task-filters']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    applyTaskFilters(new FormData(event.currentTarget));
    render();
  });

  document.querySelector("[data-action='reset-task-filters']")?.addEventListener("click", () => {
    state.taskFilters = { ...defaultState.taskFilters };
    render();
  });

  document.querySelector("[data-form='snapshot-filters']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    applySnapshotFilters(new FormData(event.currentTarget));
    render();
  });

  document.querySelector("[data-action='reset-snapshot-filters']")?.addEventListener("click", () => {
    state.snapshotFilters = { ...defaultState.snapshotFilters };
    render();
  });

  document.querySelectorAll("[data-action='simulate-task']").forEach((button) => {
    button.addEventListener("click", () => {
      simulateTask(button.dataset.taskId);
      render();
    });
  });

  document.querySelectorAll("[data-action='view-task']").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedTaskId = button.dataset.taskId;
      state.activeView = "taskDetail";
      render();
    });
  });

  document.querySelectorAll("[data-action='simulate-all']").forEach((button) => {
    button.addEventListener("click", () => {
      collectAllActiveTasks();
      render();
    });
  });

  document.querySelectorAll("[data-action='toggle-auto']").forEach((button) => {
    button.addEventListener("click", () => {
      state.settings.autoCollectEnabled = !state.settings.autoCollectEnabled;
      if (state.settings.autoCollectEnabled) {
        collectAllActiveTasks(true);
      }
      saveState();
      syncAutoCollector();
      render();
    });
  });

  document.querySelectorAll("[data-action='toggle-task']").forEach((button) => {
    button.addEventListener("click", () => {
      const task = state.tasks.find((item) => item.id === button.dataset.taskId);
      if (!task) return;
      task.status = task.status === "active" ? "paused" : "active";
      saveState();
      render();
    });
  });

  document.querySelectorAll("[data-action='mark-task-booked']").forEach((button) => {
    button.addEventListener("click", () => {
      markTaskBooked(button.dataset.taskId);
      render();
    });
  });

  document.querySelectorAll("[data-action='clear-task-history']").forEach((button) => {
    button.addEventListener("click", () => {
      clearTaskHistory(button.dataset.taskId);
      render();
    });
  });

  document.querySelectorAll("[data-action='delete-task']").forEach((button) => {
    button.addEventListener("click", () => {
      deleteTask(button.dataset.taskId);
      render();
    });
  });

  document.querySelectorAll("[data-action='mark-alert-handled']").forEach((button) => {
    button.addEventListener("click", () => {
      updateAlertStatus(button.dataset.alertId, "handled");
      render();
    });
  });

  document.querySelectorAll("[data-action='mark-alert-ignored']").forEach((button) => {
    button.addEventListener("click", () => {
      updateAlertStatus(button.dataset.alertId, "ignored");
      render();
    });
  });

  document.querySelector("[data-action='open-manual']")?.addEventListener("click", () => {
    state.activeView = "recommendations";
    render();
    window.setTimeout(() => {
      document.querySelector("#manual-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  });

  document.querySelector("[data-form='manual-task']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const taskId = createManualTask(formData);
    simulateTask(taskId);
    state.activeView = "tasks";
    render();
  });

  document.querySelector("[data-form='task-edit']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    updateTaskConfig(event.currentTarget.dataset.taskId, new FormData(event.currentTarget));
    render();
  });

  document.querySelector("[data-form='settings']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    state.settings = {
      email: String(formData.get("email")),
      cooldownHours: Number(formData.get("cooldownHours")),
      defaultCurrency: String(formData.get("defaultCurrency")),
      alertBudgetEnabled: formData.get("alertBudgetEnabled") === "on",
      alertHistoricalLowEnabled: formData.get("alertHistoricalLowEnabled") === "on",
      alertAverageDropEnabled: formData.get("alertAverageDropEnabled") === "on",
      alertAverageDropPercent: clampNumber(Number(formData.get("alertAverageDropPercent")), 1, 80),
      autoCollectEnabled: formData.get("autoCollectEnabled") === "on",
      autoCollectIntervalMinutes: clampNumber(Number(formData.get("autoCollectIntervalMinutes")), 1, 1440),
      autoPruneSnapshots: formData.get("autoPruneSnapshots") === "on",
      maxSnapshotsPerTask: clampNumber(Number(formData.get("maxSnapshotsPerTask")), 50, 5000),
      lastAutoRunAt: state.settings.lastAutoRunAt
    };
    state.maintenanceMessage = "";
    saveState();
    syncAutoCollector();
    render();
  });

  document.querySelector("[data-form='profile']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    updateActiveProfile(new FormData(event.currentTarget));
    render();
  });

  document.querySelector("[data-action='switch-profile']")?.addEventListener("click", () => {
    const profileId = document.querySelector("[data-field='active-profile-id']")?.value;
    if (!profileId || !state.profiles.some((profile) => profile.id === profileId)) return;
    state.activeProfileId = profileId;
    state.settings.email = activeProfile().email || state.settings.email;
    saveState();
    render();
  });

  document.querySelector("[data-action='create-profile']")?.addEventListener("click", () => {
    const profile = createLocalProfile();
    state.profiles.push(profile);
    state.activeProfileId = profile.id;
    state.settings.email = profile.email;
    saveState();
    render();
  });

  document.querySelector("[data-action='prune-snapshots-now']")?.addEventListener("click", () => {
    const removedCount = enforceSnapshotRetention(true);
    state.maintenanceMessage =
      removedCount > 0 ? `已清理 ${removedCount} 条旧价格快照。` : "没有需要清理的旧价格快照。";
    saveState();
    render();
  });

  document.querySelector("[data-action='export-backup']")?.addEventListener("click", () => {
    state.backupText = serializeBackup(state);
    state.backupMessage = "已生成导出 JSON。";
    render();
  });

  document.querySelector("[data-action='import-backup']")?.addEventListener("click", () => {
    const backupText = document.querySelector("[data-field='backup-text']")?.value || "";
    try {
      const imported = parseBackup(backupText, defaultSettings);
      state = {
        ...state,
        ...imported,
        activeView: "settings",
        selectedTaskId: null,
        backupText,
        backupMessage: "导入成功，数据已保存。"
      };
      saveState();
      syncAutoCollector();
    } catch {
      state.backupMessage = "导入失败，请检查 JSON 格式。";
    }
    render();
  });

  document.querySelector("[data-form='manual-price']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    addManualPriceSnapshot(new FormData(event.currentTarget));
    render();
  });

  document.querySelector("[data-action='load-csv-example']")?.addEventListener("click", () => {
    const task = state.tasks.find((item) => item.id === state.selectedTaskId);
    const destination = task?.destinationIds.map(destinationById).filter(Boolean)[0];
    const dateOption = task ? dateOptionsForTask(task)[0] : null;
    state.csvImportText = [
      "destination,departDate,returnDate,strategyType,priceAmount,airline,durationMinutes,transferCities,source,bookingUrl,includesCheckedBag",
      `${destination?.name || "目的地"},${dateOption?.departDate || "2027-01-01"},${dateOption?.returnDate || "2027-01-05"},direct,1680,示例航空,280,,航司官网,https://example.com,true`
    ].join("\n");
    state.csvImportMessage = "已填入示例 CSV。";
    render();
  });

  document.querySelector("[data-action='import-price-csv']")?.addEventListener("click", () => {
    const text = document.querySelector("[data-field='csv-import']")?.value || "";
    const count = addManualPriceSnapshotsFromCsv(text);
    state.csvImportText = text;
    state.csvImportMessage = count > 0 ? `已导入 ${count} 条价格快照。` : "未导入数据，请检查 CSV 表头和内容。";
    render();
  });
}

function createManualDraftFromPreset(presetId) {
  const preset = RECOMMENDATION_PRESETS.find((item) => item.id === presetId);
  if (!preset) return;
  const holiday = HOLIDAYS.find((item) => item.id === preset.holidayId);
  if (!holiday) return;
  state.manualDraft = {
    sourcePresetName: preset.name,
    name: `${holiday.name} · ${preset.name}`,
    holidayId: preset.holidayId,
    destinationIds: preset.destinationIds,
    departDate: holiday.startDate,
    returnDate: holiday.endDate,
    dateFlexDaysBefore: Number(holiday.flexBefore) || 0,
    dateFlexDaysAfter: Number(holiday.flexAfter) || 0,
    passengerCount: 1,
    budgetAmount: preset.recommendedBudgetAmount,
    monitorDirect: preset.recommendedStrategyTypes.includes("direct"),
    monitorTransfer: preset.recommendedStrategyTypes.includes("transfer")
  };
}

function createTaskFromPreset(presetId) {
  const preset = RECOMMENDATION_PRESETS.find((item) => item.id === presetId);
  const holiday = HOLIDAYS.find((item) => item.id === preset.holidayId);
  const profile = activeProfile();
  const task = {
    id: `task-${Date.now()}`,
    userId: profile.id,
    name: `${holiday.name} · ${preset.name}`,
    creationSource: "system_recommendation",
    originCity: profile.originCity || preset.originCity,
    originAirportCodes: profile.originAirportCodes.length ? profile.originAirportCodes : preset.originAirportCodes,
    destinationIds: preset.destinationIds,
    holidayId: preset.holidayId,
    departDate: holiday.startDate,
    returnDate: holiday.endDate,
    dateFlexDaysBefore: Number(holiday.flexBefore) || 0,
    dateFlexDaysAfter: Number(holiday.flexAfter) || 0,
    tripType: preset.tripType,
    passengerCount: 1,
    cabinClass: "economy",
    budgetAmount: preset.recommendedBudgetAmount,
    budgetCurrency: preset.recommendedBudgetCurrency,
    monitorDirect: preset.recommendedStrategyTypes.includes("direct"),
    monitorTransfer: preset.recommendedStrategyTypes.includes("transfer"),
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.tasks.push(task);
  saveState();
  return task.id;
}

function applyDestinationFilters(formData) {
  state.destinationFilters = {
    region: String(formData.get("region") || "all"),
    tag: String(formData.get("tag") || "all"),
    query: String(formData.get("query") || "").trim()
  };
}

function applyTaskFilters(formData) {
  state.taskFilters = {
    query: String(formData.get("query") || "").trim(),
    status: String(formData.get("status") || "all"),
    alertStatus: String(formData.get("alertStatus") || "all"),
    sortBy: String(formData.get("sortBy") || "deal")
  };
}

function alertRulesFromSettings() {
  return {
    budgetEnabled: Boolean(state.settings.alertBudgetEnabled),
    historicalLowEnabled: Boolean(state.settings.alertHistoricalLowEnabled),
    averageDropEnabled: Boolean(state.settings.alertAverageDropEnabled),
    averageDropPercent: clampNumber(Number(state.settings.alertAverageDropPercent), 1, 80)
  };
}

function applySnapshotFilters(formData) {
  state.snapshotFilters = {
    destinationId: String(formData.get("destinationId") || "all"),
    strategyType: String(formData.get("strategyType") || "all"),
    datePair: String(formData.get("datePair") || "all")
  };
}

function enforceSnapshotRetention(force = false) {
  if (!force && !state.settings.autoPruneSnapshots) return 0;
  const cleaned = pruneSnapshotsByTask(
    { snapshots: state.snapshots, alerts: state.alerts },
    state.settings.maxSnapshotsPerTask
  );
  const removedCount = cleaned.removedSnapshotIds.length;
  if (removedCount > 0) {
    state.snapshots = cleaned.snapshots;
    state.alerts = cleaned.alerts;
  }
  return removedCount;
}

function clearTaskHistory(taskId) {
  const cleaned = removeTaskData({ tasks: [], snapshots: state.snapshots, alerts: state.alerts }, taskId);
  state.snapshots = cleaned.snapshots;
  state.alerts = cleaned.alerts;
  saveState();
}

function updateAlertStatus(alertId, sendStatus) {
  const alert = state.alerts.find((item) => item.id === alertId);
  if (!alert) return;
  alert.sendStatus = sendStatus;
  alert.updatedAt = new Date().toISOString();
  saveState();
}

function markTaskBooked(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  task.status = "booked";
  task.bookedAt = new Date().toISOString();
  task.updatedAt = task.bookedAt;
  saveState();
}

function deleteTask(taskId) {
  const cleaned = removeTaskData(state, taskId);
  state.tasks = cleaned.tasks;
  state.snapshots = cleaned.snapshots;
  state.alerts = cleaned.alerts;
  if (state.selectedTaskId === taskId) {
    state.selectedTaskId = null;
    state.activeView = "tasks";
  }
  saveState();
}

function createManualTask(formData) {
  const profile = activeProfile();
  const holidayId = resolveManualHolidayId(formData);
  const holiday = holidayById(holidayId);
  const monitorDirect = formData.get("direct") === "on";
  const monitorTransfer = formData.get("transfer") === "on";
  const destinationIds = resolveManualDestinationIds(formData);
  const task = {
    id: `task-${Date.now()}`,
    userId: profile.id,
    name: String(formData.get("name")),
    creationSource: "manual",
    originCity: profile.originCity || "上海",
    originAirportCodes: profile.originAirportCodes.length ? profile.originAirportCodes : ["PVG", "SHA"],
    destinationIds,
    holidayId,
    departDate: String(formData.get("departDate")) || holiday?.startDate,
    returnDate: String(formData.get("returnDate")) || holiday?.endDate,
    dateFlexDaysBefore: clampNumber(Number(formData.get("dateFlexDaysBefore")), 0, 7),
    dateFlexDaysAfter: clampNumber(Number(formData.get("dateFlexDaysAfter")), 0, 7),
    tripType: "round",
    passengerCount: clampNumber(Number(formData.get("passengerCount")), 1, 9),
    cabinClass: "economy",
    budgetAmount: Number(formData.get("budgetAmount")),
    budgetCurrency: state.settings.defaultCurrency,
    monitorDirect: monitorDirect || !monitorTransfer,
    monitorTransfer,
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.tasks.push(task);
  state.manualDraft = null;
  saveState();
  return task.id;
}

function updateTaskConfig(taskId, formData) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const destinationIds = formData
    .getAll("editDestinationIds")
    .map((item) => String(item))
    .filter(Boolean);
  const monitorDirect = formData.get("direct") === "on";
  const monitorTransfer = formData.get("transfer") === "on";

  task.name = String(formData.get("name") || task.name).trim() || task.name;
  task.destinationIds = destinationIds.length ? destinationIds : task.destinationIds;
  task.departDate = String(formData.get("departDate") || task.departDate);
  task.returnDate = String(formData.get("returnDate") || task.returnDate);
  task.dateFlexDaysBefore = clampNumber(Number(formData.get("dateFlexDaysBefore")), 0, 7);
  task.dateFlexDaysAfter = clampNumber(Number(formData.get("dateFlexDaysAfter")), 0, 7);
  task.passengerCount = clampNumber(Number(formData.get("passengerCount")), 1, 9);
  task.budgetAmount = Math.max(300, Number(formData.get("budgetAmount")) || task.budgetAmount);
  task.monitorDirect = monitorDirect || !monitorTransfer;
  task.monitorTransfer = monitorTransfer;
  task.updatedAt = new Date().toISOString();

  if (formData.get("clearHistory") === "on") {
    clearTaskHistory(task.id);
  }
  state.snapshotFilters = { ...defaultState.snapshotFilters };
  saveState();
}

function resolveManualHolidayId(formData) {
  const customName = String(formData.get("customHolidayName") || "").trim();
  if (!customName && formData.get("holidayId") !== "__custom__") {
    return String(formData.get("holidayId"));
  }

  const departDate = String(formData.get("departDate"));
  const returnDate = String(formData.get("returnDate"));
  const existing = state.customHolidays.find(
    (holiday) => holiday.name === customName && holiday.startDate === departDate && holiday.endDate === returnDate
  );
  if (existing) return existing.id;

  const holiday = buildCustomHoliday({
    name: customName || "自定义节假日",
    startDate: departDate,
    endDate: returnDate
  });
  state.customHolidays.push(holiday);
  return holiday.id;
}

function simulateTask(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || task.status !== "active") return;

  const snapshots = collectPriceSnapshots({
    task,
    destinations: task.destinationIds.map(destinationById).filter(Boolean),
    dateOptions: dateOptionsForTask(task),
    sourceType: PRICE_SOURCE_TYPES.MOCK
  });

  snapshots.forEach((snapshot) => {
    const evaluation = evaluateAlert({
      task,
      snapshot,
      history: state.snapshots,
      rules: alertRulesFromSettings()
    });
    state.snapshots.push(snapshot);
    if (evaluation.shouldAlert && canSendAlert(task.id, snapshot.destinationId, snapshot.strategyType, snapshot.departDate, snapshot.returnDate)) {
      state.alerts.push(createAlertLog(task, snapshot, evaluation));
    }
  });

  task.updatedAt = new Date().toISOString();
  saveState();
}

function addManualPriceSnapshot(formData) {
  const task = state.tasks.find((item) => item.id === state.selectedTaskId);
  if (!task) return;
  const destination = destinationById(String(formData.get("destinationId")));
  if (!destination) return;

  const [departDate, returnDate] = String(formData.get("datePair")).split("|");
  const snapshot = buildManualPriceSnapshot({
    task,
    destination,
    departDate,
    returnDate,
    strategyType: String(formData.get("strategyType")),
    airline: String(formData.get("airline") || ""),
    durationMinutes: Number(formData.get("durationMinutes")),
    priceAmount: Number(formData.get("priceAmount")),
    priceCurrency: task.budgetCurrency,
    transferCities: String(formData.get("transferCities") || ""),
    includesCheckedBag: formData.get("includesCheckedBag") === "on",
    source: String(formData.get("source") || ""),
    bookingUrl: String(formData.get("bookingUrl") || "")
  });
  if (!Number.isFinite(snapshot.priceAmount) || snapshot.priceAmount <= 0) return;

  const evaluation = evaluateAlert({
    task,
    snapshot,
    history: state.snapshots,
    rules: alertRulesFromSettings()
  });
  state.snapshots.push(snapshot);
  if (evaluation.shouldAlert && canSendAlert(task.id, snapshot.destinationId, snapshot.strategyType, snapshot.departDate, snapshot.returnDate)) {
    state.alerts.push(createAlertLog(task, snapshot, evaluation));
  }
  task.updatedAt = new Date().toISOString();
  saveState();
}

function addManualPriceSnapshotsFromCsv(text) {
  const task = state.tasks.find((item) => item.id === state.selectedTaskId);
  if (!task) return 0;

  const destinations = task.destinationIds.map(destinationById).filter(Boolean);
  let importedCount = 0;
  parseCsvRows(text).forEach((row) => {
    const destination = resolveCsvDestination(row.destination, destinations);
    if (!destination || !row.departDate || !row.returnDate || !row.strategyType || !row.priceAmount) return;

    const snapshot = buildManualPriceSnapshot({
      task,
      destination,
      departDate: row.departDate,
      returnDate: row.returnDate,
      strategyType: normalizeStrategyType(row.strategyType),
      airline: row.airline,
      durationMinutes: Number(row.durationMinutes),
      priceAmount: Number(row.priceAmount),
      priceCurrency: task.budgetCurrency,
      transferCities: row.transferCities,
      includesCheckedBag: parseBoolean(row.includesCheckedBag),
      source: row.source,
      bookingUrl: row.bookingUrl
    });
    if (!Number.isFinite(snapshot.priceAmount) || snapshot.priceAmount <= 0) return;

    const evaluation = evaluateAlert({ task, snapshot, history: state.snapshots, rules: alertRulesFromSettings() });
    state.snapshots.push(snapshot);
    if (evaluation.shouldAlert && canSendAlert(task.id, snapshot.destinationId, snapshot.strategyType, snapshot.departDate, snapshot.returnDate)) {
      state.alerts.push(createAlertLog(task, snapshot, evaluation));
    }
    importedCount += 1;
  });

  if (importedCount > 0) {
    task.updatedAt = new Date().toISOString();
    saveState();
  }
  return importedCount;
}

function resolveCsvDestination(value, destinations) {
  const key = String(value || "").trim();
  return destinations.find((destination) => destination.id === key || destination.name === key);
}

function normalizeStrategyType(value) {
  const key = String(value || "").trim().toLowerCase();
  return key === "transfer" || key === "中转" ? "transfer" : "direct";
}

function parseBoolean(value) {
  return ["true", "1", "yes", "y", "是", "含"].includes(String(value || "").trim().toLowerCase());
}

function collectAllActiveTasks(markAsAuto = false) {
  const activeTasks = state.tasks.filter((task) => task.status === "active");
  activeTasks.forEach((task) => simulateTask(task.id));
  if (markAsAuto) {
    state.settings.lastAutoRunAt = new Date().toISOString();
    saveState();
  }
  return activeTasks.length;
}

function syncAutoCollector() {
  if (autoCollectTimer) {
    window.clearInterval(autoCollectTimer);
    autoCollectTimer = null;
  }
  if (!state.settings.autoCollectEnabled) return;

  const intervalMinutes = clampNumber(Number(state.settings.autoCollectIntervalMinutes), 1, 1440);
  autoCollectTimer = window.setInterval(() => {
    collectAllActiveTasks(true);
    render();
  }, intervalMinutes * 60 * 1000);
}

function resolveManualDestinationIds(formData) {
  const selectedIds = formData
    .getAll("destinationIds")
    .map((item) => String(item))
    .filter(Boolean);
  const customName = String(formData.get("customDestinationName") || "").trim();
  if (!customName) return selectedIds.length ? selectedIds : [allDestinations()[0]?.id].filter(Boolean);

  const existing = state.customDestinations.find((destination) => destination.name === customName);
  if (existing) return Array.from(new Set([...selectedIds, existing.id]));

  const destination = buildCustomDestinationFromForm(formData, customName || "自定义目的地");
  state.customDestinations.push(destination);
  return Array.from(new Set([...selectedIds, destination.id]));
}

function buildCustomDestinationFromForm(formData, name) {
  return buildCustomDestination({
    name,
    countryOrRegion: String(formData.get("customCountryOrRegion") || ""),
    airportCodes: String(formData.get("customAirportCodes") || ""),
    tags: String(formData.get("customTags") || ""),
    directPrice: Number(formData.get("customDirectPrice")),
    transferPrice: Number(formData.get("customTransferPrice")),
    isDomestic: formData.get("customIsDomestic") === "on"
  });
}

function createAlertLog(task, snapshot, evaluation) {
  const destination = destinationById(snapshot.destinationId);
  const strategy = snapshot.strategyType === "direct" ? "直飞" : "中转";
  const profile = profileForTask(task);
  return {
    id: `alert-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    watchTaskId: task.id,
    flightPriceSnapshotId: snapshot.id,
    alertRuleId: "default-low-price",
    recipientEmail: profile.email || state.settings.email,
    subject: `[机票提醒] ${task.name} ${destination.name} ${strategy} ${formatMoney(snapshot.priceAmount, snapshot.priceCurrency)}`,
    triggerReason: evaluation.reasons.join("，"),
    historicalLow: evaluation.historicalLow,
    average30: evaluation.average30,
    cooldownHours: Number(state.settings.cooldownHours) || defaultSettings.cooldownHours,
    sentAt: new Date().toISOString(),
    sendStatus: "preview"
  };
}

function canSendAlert(taskId, destinationId, strategyType, departDate, returnDate) {
  const cooldownMs = (Number(state.settings.cooldownHours) || defaultSettings.cooldownHours) * 60 * 60 * 1000;
  const latest = state.alerts
    .map((alert) => ({
      alert,
      snapshot: state.snapshots.find((snapshot) => snapshot.id === alert.flightPriceSnapshotId)
    }))
    .filter(
      ({ alert, snapshot }) =>
        alert.watchTaskId === taskId &&
        snapshot?.destinationId === destinationId &&
        snapshot?.strategyType === strategyType &&
        snapshot?.departDate === departDate &&
        snapshot?.returnDate === returnDate
    )
    .sort((a, b) => new Date(b.alert.sentAt) - new Date(a.alert.sentAt))[0];
  return !latest || Date.now() - new Date(latest.alert.sentAt).getTime() > cooldownMs;
}

function bestSnapshotForTask(taskId) {
  return state.snapshots
    .filter((snapshot) => snapshot.watchTaskId === taskId)
    .sort((a, b) => a.priceAmount - b.priceAmount)[0];
}

function bestSnapshotForSeries(taskId, destinationId, strategyType, departDate, returnDate) {
  return state.snapshots
    .filter(
      (snapshot) =>
        snapshot.watchTaskId === taskId &&
        snapshot.destinationId === destinationId &&
        snapshot.strategyType === strategyType &&
        snapshot.departDate === departDate &&
        snapshot.returnDate === returnDate
    )
    .sort((a, b) => a.priceAmount - b.priceAmount)[0];
}

function snapshotsForTask(taskId) {
  return state.snapshots.filter((snapshot) => snapshot.watchTaskId === taskId);
}

function allDestinations() {
  return [...DESTINATIONS, ...state.customDestinations];
}

function activeProfile() {
  return state.profiles.find((profile) => profile.id === state.activeProfileId) || state.profiles[0] || defaultProfiles[0];
}

function profileForTask(task) {
  return state.profiles.find((profile) => profile.id === task.userId) || activeProfile();
}

function normalizeProfiles(profiles, settings) {
  const source = Array.isArray(profiles) && profiles.length
    ? profiles
    : [{ ...defaultProfiles[0], email: settings.email || defaultSettings.email }];
  return source.map((profile, index) => normalizeProfile(profile, index, settings));
}

function normalizeProfile(profile, index = 0, settings = defaultSettings) {
  const originAirportCodes = normalizeTextList(profile.originAirportCodes, ["PVG", "SHA"]).map((code) => code.toUpperCase());
  return {
    id: String(profile.id || `local-user-${index + 1}`),
    displayName: String(profile.displayName || profile.name || `旅客 ${index + 1}`),
    email: String(profile.email || settings.email || defaultSettings.email),
    originCity: String(profile.originCity || "上海"),
    originAirportCodes,
    preferredDestinationTags: normalizeTextList(profile.preferredDestinationTags, ["自然风景", "历史人文"]),
    createdAt: profile.createdAt || null,
    updatedAt: profile.updatedAt || null
  };
}

function normalizeTextList(value, fallback) {
  if (Array.isArray(value)) {
    const parsed = value.map((item) => String(item).trim()).filter(Boolean);
    return parsed.length ? parsed : fallback;
  }
  const parsed = splitList(String(value || ""));
  return parsed.length ? parsed : fallback;
}

function updateActiveProfile(formData) {
  const profile = activeProfile();
  profile.displayName = String(formData.get("displayName") || profile.displayName).trim() || profile.displayName;
  profile.email = String(formData.get("profileEmail") || profile.email).trim() || profile.email;
  profile.originCity = String(formData.get("originCity") || profile.originCity).trim() || profile.originCity;
  profile.originAirportCodes = normalizeTextList(formData.get("originAirportCodes"), profile.originAirportCodes).map((code) => code.toUpperCase());
  profile.preferredDestinationTags = normalizeTextList(formData.get("preferredDestinationTags"), profile.preferredDestinationTags);
  profile.updatedAt = new Date().toISOString();
  state.settings.email = profile.email;
  saveState();
}

function createLocalProfile() {
  const now = new Date().toISOString();
  const nextNumber = state.profiles.length + 1;
  return {
    id: `local-user-${Date.now()}`,
    displayName: `旅客 ${nextNumber}`,
    email: state.settings.email,
    originCity: "上海",
    originAirportCodes: ["PVG", "SHA"],
    preferredDestinationTags: ["自然风景", "历史人文"],
    createdAt: now,
    updatedAt: now
  };
}

function destinationById(destinationId) {
  return allDestinations().find((destination) => destination.id === destinationId);
}

function allHolidays() {
  return [...HOLIDAYS, ...state.customHolidays];
}

function holidayById(holidayId) {
  return allHolidays().find((holiday) => holiday.id === holidayId);
}

function dateOptionsForTask(task) {
  return generateFlexibleDateOptions({
    departDate: task.departDate,
    returnDate: task.returnDate,
    flexBefore: task.dateFlexDaysBefore || 0,
    flexAfter: task.dateFlexDaysAfter || 0
  });
}

function bestSnapshotForDateOption(taskId, departDate, returnDate) {
  return state.snapshots
    .filter((snapshot) => snapshot.watchTaskId === taskId && snapshot.departDate === departDate && snapshot.returnDate === returnDate)
    .sort((a, b) => a.priceAmount - b.priceAmount)[0];
}

function flexText(task) {
  const before = Number(task.dateFlexDaysBefore) || 0;
  const after = Number(task.dateFlexDaysAfter) || 0;
  if (!before && !after) return "";
  return `（前移 ${before} 天 / 后移 ${after} 天）`;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function totalPrice(singlePrice, task) {
  return singlePrice * (Number(task.passengerCount) || 1);
}

function trendText(trendPercent) {
  if (trendPercent === null) return "暂无趋势";
  if (trendPercent === 0) return "较上次持平";
  return trendPercent > 0 ? `较上次上涨 ${trendPercent}%` : `较上次下降 ${Math.abs(trendPercent)}%`;
}

function minutesToText(minutes) {
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function safeFileName(value) {
  return String(value || "flight-alert").replace(/[^a-z0-9-_]+/gi, "-").slice(0, 80);
}

function buildSnapshotCsvHref(snapshots) {
  const rows = snapshots
    .slice()
    .sort((a, b) => new Date(a.searchedAt) - new Date(b.searchedAt))
    .map((snapshot) => {
      const destination = destinationById(snapshot.destinationId);
      return {
        searchedAt: snapshot.searchedAt,
        destination: destination?.name || snapshot.destinationId,
        originAirport: snapshot.originAirport,
        destinationAirport: snapshot.destinationAirport,
        departDate: snapshot.departDate,
        returnDate: snapshot.returnDate,
        strategyType: snapshot.strategyType,
        airline: snapshot.airline,
        flightIdentifier: snapshot.flightIdentifier,
        durationMinutes: snapshot.durationMinutes,
        transferCount: snapshot.transferCount,
        transferCities: snapshot.transferCities.join(" / "),
        priceAmount: snapshot.priceAmount,
        priceCurrency: snapshot.priceCurrency,
        includesTax: snapshot.includesTax ? "true" : "false",
        includesCheckedBag: snapshot.includesCheckedBag ? "true" : "false",
        source: snapshot.source,
        bookingUrl: snapshot.bookingUrl
      };
    });
  const csv = serializeCsv(rows, [
    { key: "searchedAt", label: "searchedAt" },
    { key: "destination", label: "destination" },
    { key: "originAirport", label: "originAirport" },
    { key: "destinationAirport", label: "destinationAirport" },
    { key: "departDate", label: "departDate" },
    { key: "returnDate", label: "returnDate" },
    { key: "strategyType", label: "strategyType" },
    { key: "airline", label: "airline" },
    { key: "flightIdentifier", label: "flightIdentifier" },
    { key: "durationMinutes", label: "durationMinutes" },
    { key: "transferCount", label: "transferCount" },
    { key: "transferCities", label: "transferCities" },
    { key: "priceAmount", label: "priceAmount" },
    { key: "priceCurrency", label: "priceCurrency" },
    { key: "includesTax", label: "includesTax" },
    { key: "includesCheckedBag", label: "includesCheckedBag" },
    { key: "source", label: "source" },
    { key: "bookingUrl", label: "bookingUrl" }
  ]);
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char];
  });
}

render();
syncAutoCollector();
