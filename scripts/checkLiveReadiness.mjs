import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { parseBackup } from "../src/storage.js";
import { checkAmadeusHealth } from "./amadeusFlightSource.mjs";
import { loadLocalEnv } from "./localEnv.mjs";
import { checkSmtpHealth } from "./smtpMailer.mjs";

loadLocalEnv();

const args = parseArgs(process.argv.slice(2));
const inputPath = resolve(args.input || "flight-tickets-backup.json");
const reportOutputPath = args.reportOutput ? resolve(args.reportOutput) : "";

const report = {
  inputPath,
  reportOutputPath: reportOutputPath || undefined,
  ready: false,
  checkedAt: new Date().toISOString(),
  warnings: [],
  items: []
};

if (!existsSync(inputPath)) {
  report.warnings.push(`找不到输入备份文件：${inputPath}`);
  report.items.push(readinessItem("backup", false, true, "备份文件", "请先在设置页导出 JSON 备份，或使用 --input 指定文件。"));
  finish(report, 1);
}

const defaultSettings = {
  email: "your-email@example.com",
  priceSourceType: "mock",
  autoCollectEnabled: false,
  autoCollectIntervalMinutes: 60
};

const state = parseBackup(readFileSync(inputPath, "utf8"), defaultSettings);
const activeTasks = state.tasks.filter((task) => task.status === "active");
const activeProfile = state.profiles.find((profile) => profile.id === state.activeProfileId) || state.profiles[0] || {};
const email = activeProfile.email || state.settings.email || "";
const hasRealEmail = Boolean(email && email !== "your-email@example.com");
const health = await checkAmadeusHealth();
const smtpHealth = args.smtp ? await checkSmtpHealth() : null;

report.priceSourceHealth = health;
if (smtpHealth) {
  report.smtpHealth = smtpHealth;
}
report.summary = {
  activeTasks: activeTasks.length,
  email: hasRealEmail ? email : "",
  autoCollectEnabled: Boolean(state.settings.autoCollectEnabled),
  autoCollectIntervalMinutes: Number(state.settings.autoCollectIntervalMinutes) || 60,
  smtpRequired: Boolean(args.smtp)
};
report.items.push(
  readinessItem(
    "source",
    state.settings.priceSourceType === "amadeus",
    true,
    "真实价格源",
    state.settings.priceSourceType === "amadeus"
      ? "备份设置已选择 Amadeus 真实价格。"
      : "备份设置仍是模拟价格源，请在设置页切换到 Amadeus 真实价格后重新导出。"
  ),
  readinessItem(
    "connection",
    Boolean(health.ok),
    true,
    "连接验证",
    health.ok ? `Amadeus ${health.environment} 环境已验证。` : health.message
  ),
  readinessItem(
    "tasks",
    activeTasks.length > 0,
    true,
    "启用任务",
    activeTasks.length > 0 ? `备份中有 ${activeTasks.length} 个启用任务。` : "备份中没有启用的监控任务。"
  ),
  readinessItem(
    "email",
    hasRealEmail,
    true,
    "提醒邮箱",
    hasRealEmail ? `提醒邮箱：${email}` : "请在旅客档案或设置中填写真实收件邮箱后重新导出。"
  ),
  readinessItem(
    "runner",
    Boolean(state.settings.autoCollectEnabled || args.collectCommand),
    false,
    "运行方式",
    state.settings.autoCollectEnabled
      ? `页面自动采集已开启，每 ${Number(state.settings.autoCollectIntervalMinutes) || 60} 分钟一次。`
      : args.collectCommand
      ? "已声明将使用 collect:live 或系统定时任务。"
      : "页面自动采集未开启；后台运行请配置 collect:live 和系统定时任务。"
  )
);

if (args.smtp) {
  report.items.push(
    readinessItem(
      "smtp",
      Boolean(smtpHealth?.ok),
      true,
      "SMTP 自动邮件",
      smtpHealth?.ok ? `SMTP ${smtpHealth.host}:${smtpHealth.port} 已验证。` : smtpHealth?.message || "SMTP 检查失败。"
    )
  );
}

report.ready = report.items.filter((item) => item.required).every((item) => item.ok);
report.warnings.push(...report.items.filter((item) => item.required && !item.ok).map((item) => `${item.label}: ${item.detail}`));
finish(report, report.ready ? 0 : 2);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      parsed.input = argv[index + 1];
      index += 1;
    } else if (arg === "--collect-command") {
      parsed.collectCommand = true;
    } else if (arg === "--smtp") {
      parsed.smtp = true;
    } else if (arg === "--report-output") {
      parsed.reportOutput = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function readinessItem(key, ok, required, label, detail) {
  return { key, ok, required, label, detail };
}

function finish(payload, exitCode) {
  payload.status = exitCode === 0 ? "ok" : "error";
  payload.exitCode = exitCode;
  const text = JSON.stringify(payload, null, 2);
  if (reportOutputPath) {
    mkdirSync(dirname(reportOutputPath), { recursive: true });
    writeFileSync(reportOutputPath, text, "utf8");
  }
  console.log(text);
  process.exit(exitCode);
}
