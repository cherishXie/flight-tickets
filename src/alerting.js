import { DEFAULT_ALERT_RULES, formatMoney } from "./pricing.js";

export function alertRulesFromSettings(settings = {}) {
  return {
    budgetEnabled: Boolean(settings.alertBudgetEnabled ?? DEFAULT_ALERT_RULES.budgetEnabled),
    historicalLowEnabled: Boolean(settings.alertHistoricalLowEnabled ?? DEFAULT_ALERT_RULES.historicalLowEnabled),
    averageDropEnabled: Boolean(settings.alertAverageDropEnabled ?? DEFAULT_ALERT_RULES.averageDropEnabled),
    averageDropPercent: clampNumber(Number(settings.alertAverageDropPercent), 1, 80, DEFAULT_ALERT_RULES.averageDropPercent)
  };
}

export function createAlertLog({ task, snapshot, evaluation, destination, recipientEmail, cooldownHours, now = new Date() }) {
  const strategy = snapshot.strategyType === "direct" ? "直飞" : "中转";
  return {
    id: `alert-${now.getTime()}-${Math.random().toString(16).slice(2)}`,
    watchTaskId: task.id,
    flightPriceSnapshotId: snapshot.id,
    alertRuleId: "default-low-price",
    recipientEmail,
    subject: `[机票提醒] ${task.name} ${destination?.name || snapshot.destinationId} ${strategy} ${formatMoney(snapshot.priceAmount, snapshot.priceCurrency)}`,
    triggerReason: evaluation.reasons.join("，"),
    historicalLow: evaluation.historicalLow,
    average30: evaluation.average30,
    cooldownHours,
    sentAt: now.toISOString(),
    sendStatus: "preview"
  };
}

export function canSendAlert({ alerts, snapshots, settings, taskId, destinationId, strategyType, departDate, returnDate, now = new Date() }) {
  const cooldownMs = (Number(settings?.cooldownHours) || 12) * 60 * 60 * 1000;
  const latest = (alerts || [])
    .map((alert) => ({
      alert,
      snapshot: (snapshots || []).find((snapshot) => snapshot.id === alert.flightPriceSnapshotId)
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
  return !latest || now.getTime() - new Date(latest.alert.sentAt).getTime() > cooldownMs;
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
