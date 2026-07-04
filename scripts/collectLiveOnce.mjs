import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { DESTINATIONS } from "../src/data.js";
import { alertRulesFromSettings, canSendAlert, createAlertLog } from "../src/alerting.js";
import { generateFlexibleDateOptions } from "../src/domain.js";
import { buildEmailDraft, buildEmlContent } from "../src/notifications.js";
import { evaluateAlert } from "../src/pricing.js";
import { parseBackup, pruneSnapshotsByTask, serializeBackup } from "../src/storage.js";
import { checkAmadeusHealth, collectAmadeusSnapshots } from "./amadeusFlightSource.mjs";
import { loadLocalEnv } from "./localEnv.mjs";
import { getSmtpConfig, publicSmtpStatus, sendEmailViaSmtp } from "./smtpMailer.mjs";

loadLocalEnv();

const args = parseArgs(process.argv.slice(2));
const inputPath = resolve(args.input || "flight-tickets-backup.json");
const outputPath = resolve(args.output || inputPath);
const emlOutboxPath = args.emlOutbox ? resolve(args.emlOutbox) : "";
const reportOutputPath = args.reportOutput ? resolve(args.reportOutput) : "";
const dryRun = Boolean(args.dryRun);
const smtpEnabled = Boolean(args.smtp);
const smtpConfig = getSmtpConfig();

if (!existsSync(inputPath)) {
  finishReport({
    inputPath,
    outputPath,
    dryRun,
    error: "找不到输入备份文件。请先在设置页导出 JSON 备份，或使用 --input 指定文件。",
    warnings: [`找不到输入备份文件：${inputPath}`],
    tasks: []
  }, 1);
  process.exit(1);
}

const defaultSettings = {
  cooldownHours: 12,
  defaultCurrency: "CNY",
  alertBudgetEnabled: true,
  alertHistoricalLowEnabled: true,
  alertAverageDropEnabled: true,
  alertAverageDropPercent: 15,
  maxSnapshotsPerTask: 600,
  priceSourceType: "mock",
  livePriceMaxOffersPerSearch: 8,
  livePriceMaxQueriesPerRun: 24
};

const state = parseBackup(readFileSync(inputPath, "utf8"), defaultSettings);
const destinations = [...DESTINATIONS, ...state.customDestinations];
const activeTasks = state.tasks.filter((task) => task.status === "active");
const report = {
  inputPath,
  outputPath,
  dryRun,
  activeTasks: activeTasks.length,
  snapshotsAdded: 0,
  alertsAdded: 0,
  emlFilesPrepared: 0,
  emlFilesWritten: 0,
  smtpEnabled,
  smtpEmailsPrepared: 0,
  smtpEmailsSent: 0,
  smtpEmailErrors: 0,
  forceAmadeus: Boolean(args.forceAmadeus),
  warnings: [],
  tasks: []
};
if (emlOutboxPath) {
  report.emlOutboxPath = emlOutboxPath;
}
if (reportOutputPath) {
  report.reportOutputPath = reportOutputPath;
}
if (smtpEnabled) {
  report.smtp = publicSmtpStatus(smtpConfig);
  if (!smtpConfig.configured) {
    report.warnings.push("已启用 --smtp，但 SMTP 未配置。请设置 SMTP_HOST 和 SMTP_FROM，或设置 SMTP_USER 作为发件人。");
  }
}

if (activeTasks.length) {
  if (state.settings.priceSourceType !== "amadeus" && !args.forceAmadeus) {
    report.warnings.push("备份设置仍是模拟价格源。请在设置页切换到 Amadeus 真实价格后重新导出，或显式传入 --force-amadeus。");
    finishReport(report, 2);
    process.exit(2);
  }
  if (state.settings.priceSourceType !== "amadeus" && args.forceAmadeus) {
    report.warnings.push("已使用 --force-amadeus 覆盖备份中的价格源设置，本次将强制使用 Amadeus。");
  }
  report.priceSourceHealth = await checkAmadeusHealth();
  if (!report.priceSourceHealth.ok) {
    report.warnings.push(report.priceSourceHealth.message);
    finishReport(report, 2);
    process.exit(2);
  }
}

for (const task of activeTasks) {
  const taskDestinations = task.destinationIds.map((destinationId) => destinations.find((destination) => destination.id === destinationId)).filter(Boolean);
  const dateOptions = generateFlexibleDateOptions({
    departDate: task.departDate,
    returnDate: task.returnDate,
    flexBefore: task.dateFlexDaysBefore || 0,
    flexAfter: task.dateFlexDaysAfter || 0
  });
  const result = await collectAmadeusSnapshots({
    task,
    destinations: taskDestinations,
    dateOptions,
    maxOffersPerSearch: state.settings.livePriceMaxOffersPerSearch || defaultSettings.livePriceMaxOffersPerSearch,
    maxQueriesPerRun: state.settings.livePriceMaxQueriesPerRun || defaultSettings.livePriceMaxQueriesPerRun
  });
  const taskReport = {
    taskId: task.id,
    taskName: task.name,
    snapshots: result.snapshots.length,
    estimatedSearches: result.estimatedSearches,
    executedSearches: result.executedSearches,
    skippedSearches: result.skippedSearches,
    cacheHits: result.cacheHits,
    warnings: result.warnings
  };
  report.tasks.push(taskReport);
  report.warnings.push(...result.warnings.map((warning) => `${task.name}: ${warning}`));

  for (const snapshot of result.snapshots) {
    const evaluation = evaluateAlert({
      task,
      snapshot,
      history: state.snapshots,
      rules: alertRulesFromSettings(state.settings)
    });
    state.snapshots.push(snapshot);
    report.snapshotsAdded += 1;
    if (
      evaluation.shouldAlert &&
      canSendAlert({
        alerts: state.alerts,
        snapshots: state.snapshots,
        settings: state.settings,
        taskId: task.id,
        destinationId: snapshot.destinationId,
        strategyType: snapshot.strategyType,
        departDate: snapshot.departDate,
        returnDate: snapshot.returnDate
      })
    ) {
      const destination = destinations.find((item) => item.id === snapshot.destinationId);
      const profile = state.profiles.find((item) => item.id === task.userId) || state.profiles[0] || {};
      const alertLog = createAlertLog({
        task,
        snapshot,
        evaluation,
        destination,
        recipientEmail: profile.email || state.settings.email,
        cooldownHours: Number(state.settings.cooldownHours) || defaultSettings.cooldownHours
      });
      state.alerts.push(alertLog);
      report.alertsAdded += 1;
      const draft = buildEmailDraft({ alert: alertLog, task, snapshot, destination });
      writeEmlIfRequested({ draft, alert: alertLog, task, snapshot, destination });
      await sendSmtpIfRequested({ draft, alert: alertLog });
    }
  }
  task.updatedAt = new Date().toISOString();
}

const cleaned = pruneSnapshotsByTask(
  { snapshots: state.snapshots, alerts: state.alerts },
  state.settings.maxSnapshotsPerTask || defaultSettings.maxSnapshotsPerTask
);
state.snapshots = cleaned.snapshots;
state.alerts = cleaned.alerts;
report.prunedSnapshots = cleaned.removedSnapshotIds.length;

if (!dryRun) {
  writeFileSync(outputPath, serializeBackup(state), "utf8");
}

finishReport(report, 0);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--force-amadeus") {
      parsed.forceAmadeus = true;
    } else if (arg === "--smtp") {
      parsed.smtp = true;
    } else if (arg === "--input") {
      parsed.input = argv[index + 1];
      index += 1;
    } else if (arg === "--output") {
      parsed.output = argv[index + 1];
      index += 1;
    } else if (arg === "--eml-outbox") {
      parsed.emlOutbox = argv[index + 1];
      index += 1;
    } else if (arg === "--report-output") {
      parsed.reportOutput = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function finishReport(payload, exitCode = 0) {
  payload.status = exitCode === 0 ? "ok" : "error";
  payload.exitCode = exitCode;
  const text = JSON.stringify(payload, null, 2);
  if (reportOutputPath) {
    mkdirSync(dirname(reportOutputPath), { recursive: true });
    writeFileSync(reportOutputPath, text, "utf8");
  }
  console.log(text);
}

function writeEmlIfRequested({ draft, alert, task, snapshot, destination }) {
  if (!emlOutboxPath) return;
  report.emlFilesPrepared += 1;
  if (dryRun) return;

  mkdirSync(emlOutboxPath, { recursive: true });
  const fileName = [
    alert.sentAt,
    task.name,
    destination?.name || snapshot.destinationId,
    snapshot.strategyType,
    snapshot.priceAmount
  ]
    .filter(Boolean)
    .map(safeFileNamePart)
    .join("-");
  writeFileSync(resolve(emlOutboxPath, `${fileName}.eml`), buildEmlContent(draft, new Date(alert.sentAt)), "utf8");
  report.emlFilesWritten += 1;
}

async function sendSmtpIfRequested({ draft, alert }) {
  if (!smtpEnabled) return;
  report.smtpEmailsPrepared += 1;
  if (dryRun || !smtpConfig.configured) return;

  try {
    await sendEmailViaSmtp(draft, smtpConfig);
    alert.sendStatus = "sent";
    report.smtpEmailsSent += 1;
  } catch (error) {
    alert.sendStatus = "error";
    alert.errorMessage = error.message;
    report.smtpEmailErrors += 1;
    report.warnings.push(`SMTP 发送失败：${error.message}`);
  }
}

function safeFileNamePart(value) {
  return String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}
