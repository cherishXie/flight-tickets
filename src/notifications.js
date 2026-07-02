import { formatMoney } from "./pricing.js";

export const NOTIFICATION_CHANNELS = {
  MAILTO: "mailto",
  EML: "eml",
  SMTP: "smtp"
};

export function listNotificationChannels() {
  return [
    {
      id: NOTIFICATION_CHANNELS.MAILTO,
      name: "本机邮件客户端",
      status: "enabled",
      note: "通过 mailto 链接打开本机默认邮件客户端。"
    },
    {
      id: NOTIFICATION_CHANNELS.EML,
      name: "邮件文件导出",
      status: "enabled",
      note: "下载 .eml 文件，适合没有默认邮件客户端或需要归档时使用。"
    },
    {
      id: NOTIFICATION_CHANNELS.SMTP,
      name: "SMTP / 第三方邮件 API",
      status: "planned",
      note: "后续迁移到后端服务后接入，用于真正自动发送邮件。"
    }
  ];
}

export function buildEmailDraft({ alert, task, snapshot, destination }) {
  const passengerCount = Number(task?.passengerCount) || 1;
  const total = snapshot ? snapshot.priceAmount * passengerCount : 0;
  const origin = task?.originAirportCodes?.length
    ? `${task.originCity || "出发地"} (${task.originAirportCodes.join(" / ")})`
    : task?.originCity || "出发地";
  const transferText = snapshot?.strategyType === "transfer"
    ? `${snapshot.transferCities?.length ? snapshot.transferCities.join(" / ") : "待确认"}，${Number(snapshot.transferCount) || 1} 次中转`
    : "无中转";
  return {
    to: alert.recipientEmail,
    subject: alert.subject,
    body: [
      `任务：${task?.name || ""}`,
      `航线：${origin} -> ${destination?.name || ""}`,
      `日期：${snapshot?.departDate || ""} 出发，${snapshot?.returnDate || ""} 返回`,
      `策略：${snapshot?.strategyType === "direct" ? "直飞" : "中转"}`,
      `当前价格：${snapshot ? formatMoney(snapshot.priceAmount, snapshot.priceCurrency) : ""}`,
      `乘客人数：${passengerCount}`,
      `预计总价：${snapshot ? formatMoney(total, snapshot.priceCurrency) : ""}`,
      `历史最低：${alert.historicalLow ? formatMoney(alert.historicalLow, snapshot?.priceCurrency) : ""}`,
      `近 30 次均价：${alert.average30 ? formatMoney(Math.round(alert.average30), snapshot?.priceCurrency) : ""}`,
      `触发原因：${alert.triggerReason}`,
      `航司：${snapshot?.airline || ""}`,
      `耗时：${snapshot ? minutesToText(snapshot.durationMinutes) : ""}`,
      `中转：${transferText}`,
      `行李：${snapshot?.includesCheckedBag ? "含托运行李" : "未含托运行李"}`,
      `来源：${snapshot?.source || ""}`,
      `购票链接：${snapshot?.bookingUrl || ""}`
    ].join("\n")
  };
}

export function buildMailtoLink(draft) {
  return `mailto:${encodeURIComponent(draft.to)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
}

export function buildEmlContent(draft, createdAt = new Date()) {
  return [
    `To: ${sanitizeHeader(draft.to)}`,
    `Subject: ${sanitizeHeader(draft.subject)}`,
    `Date: ${createdAt.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    draft.body
  ].join("\r\n");
}

export function buildEmlDataHref(draft) {
  return `data:message/rfc822;charset=utf-8,${encodeURIComponent(buildEmlContent(draft))}`;
}

function sanitizeHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function minutesToText(minutes) {
  return `${Math.floor((Number(minutes) || 0) / 60)} 小时 ${(Number(minutes) || 0) % 60} 分钟`;
}
