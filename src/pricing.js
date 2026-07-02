import { DESTINATIONS } from "./data.js";

export function getDestination(destinationId) {
  return DESTINATIONS.find((destination) => destination.id === destinationId);
}

export function scoreDestination(destination) {
  const scores = destination.valueScores;
  return Math.round(
    scores.nature * 0.28 +
      scores.culture * 0.26 +
      scores.convenience * 0.24 +
      scores.visa * 0.12 +
      destination.priority * 0.1
  );
}

export function buildRecommendationScore(preset, holiday, destinations) {
  const destinationScore =
    destinations.reduce((sum, destination) => sum + scoreDestination(destination), 0) /
    Math.max(destinations.length, 1);
  return Math.round(preset.priority * 0.45 + holiday.priority * 0.3 + destinationScore * 0.25);
}

export const DEFAULT_ALERT_RULES = {
  budgetEnabled: true,
  historicalLowEnabled: true,
  averageDropEnabled: true,
  averageDropPercent: 15
};

export function createPriceSnapshot({ task, destination, strategyType, searchedAt = new Date() }) {
  const base = strategyType === "direct" ? destination.baseDirectPrice : destination.baseTransferPrice;
  const daySeed = Math.floor(searchedAt.getTime() / 86400000);
  const hash = hashString(`${task.id}-${destination.id}-${strategyType}-${task.departDate}-${task.returnDate}-${daySeed}`);
  const wave = 0.82 + (hash % 41) / 100;
  const urgency = holidayUrgencyFactor(task.departDate);
  const transferDiscount = strategyType === "transfer" ? 0.94 : 1;
  const priceAmount = Math.max(480, Math.round((base * wave * urgency * transferDiscount) / 10) * 10);

  return {
    id: `snap-${task.id}-${destination.id}-${strategyType}-${task.departDate}-${task.returnDate}-${searchedAt.getTime()}`,
    watchTaskId: task.id,
    destinationId: destination.id,
    originAirport: task.originAirportCodes[0],
    destinationAirport: destination.airportCodes[0],
    departDate: task.departDate,
    returnDate: task.returnDate,
    strategyType,
    airline: chooseAirline(destination, strategyType, hash),
    flightIdentifier: `${strategyType === "direct" ? "D" : "T"}-${destination.airportCodes[0]}-${hash % 900 + 100}`,
    transferCount: strategyType === "direct" ? 0 : 1,
    transferCities: strategyType === "direct" ? [] : chooseTransferCity(destination, hash),
    durationMinutes: estimateDuration(destination, strategyType, hash),
    priceAmount,
    priceCurrency: task.budgetCurrency,
    includesTax: true,
    includesCheckedBag: priceAmount >= base * 0.9,
    source: "模拟价格源",
    bookingUrl: "",
    searchedAt: searchedAt.toISOString()
  };
}

export function evaluateAlert({ task, snapshot, history, rules = DEFAULT_ALERT_RULES }) {
  const normalizedRules = {
    ...DEFAULT_ALERT_RULES,
    ...rules,
    averageDropPercent: clamp(Number(rules.averageDropPercent), 1, 80)
  };
  const sameSeries = history.filter(
    (item) =>
      item.watchTaskId === snapshot.watchTaskId &&
      item.destinationId === snapshot.destinationId &&
      item.strategyType === snapshot.strategyType &&
      item.departDate === snapshot.departDate &&
      item.returnDate === snapshot.returnDate
  );
  const previousPrices = sameSeries.map((item) => item.priceAmount);
  const historicalLow = previousPrices.length > 0 ? Math.min(...previousPrices) : null;
  const average30 = average(previousPrices.slice(-30));
  const reasons = [];

  if (normalizedRules.budgetEnabled && snapshot.priceAmount <= task.budgetAmount) {
    reasons.push(`低于预算 ${formatMoney(task.budgetAmount, task.budgetCurrency)}`);
  }
  if (normalizedRules.historicalLowEnabled && (historicalLow === null || snapshot.priceAmount < historicalLow)) {
    reasons.push("刷新该任务历史最低价");
  }
  const averageThreshold = 1 - normalizedRules.averageDropPercent / 100;
  if (normalizedRules.averageDropEnabled && average30 && snapshot.priceAmount <= average30 * averageThreshold) {
    reasons.push(`低于近期均价 ${Math.round((1 - snapshot.priceAmount / average30) * 100)}%`);
  }

  return {
    shouldAlert: reasons.length > 0,
    reasons,
    historicalLow: historicalLow === null ? snapshot.priceAmount : Math.min(historicalLow, snapshot.priceAmount),
    average30
  };
}

export function summarizeSnapshots(snapshots) {
  if (!snapshots.length) {
    return {
      count: 0,
      current: null,
      historicalLow: null,
      average7: null,
      average30: null,
      trendPercent: null,
      updatedAt: null
    };
  }

  const ordered = [...snapshots].sort((a, b) => new Date(a.searchedAt) - new Date(b.searchedAt));
  const prices = ordered.map((snapshot) => snapshot.priceAmount);
  const current = ordered[ordered.length - 1];
  const average7 = average(prices.slice(-7));
  const average30 = average(prices.slice(-30));
  const previous = ordered.length > 1 ? ordered[ordered.length - 2] : null;

  return {
    count: ordered.length,
    current,
    historicalLow: Math.min(...prices),
    average7,
    average30,
    trendPercent: previous ? Math.round(((current.priceAmount - previous.priceAmount) / previous.priceAmount) * 100) : null,
    updatedAt: current.searchedAt
  };
}

export function evaluateDeal({ task, snapshots }) {
  if (!snapshots.length) {
    return {
      status: "no-data",
      label: "暂无数据",
      score: 0,
      reason: "还没有价格快照，先采集一次价格。",
      bestSnapshot: null,
      historicalLow: null,
      average30: null
    };
  }

  const orderedByPrice = [...snapshots].sort((a, b) => a.priceAmount - b.priceAmount);
  const bestSnapshot = orderedByPrice[0];
  const summary = summarizeSnapshots(snapshots);
  const budgetRatio = bestSnapshot.priceAmount / task.budgetAmount;
  const averageRatio = summary.average30 ? bestSnapshot.priceAmount / summary.average30 : null;
  const lowRatio = summary.historicalLow ? bestSnapshot.priceAmount / summary.historicalLow : 1;

  if (budgetRatio <= 0.85 && (!averageRatio || averageRatio <= 0.9)) {
    return buildDeal("buy", "可以入手", 92, "当前最低价显著低于预算，并且处在近期价格低位。", bestSnapshot, summary);
  }

  if (budgetRatio <= 1 && lowRatio <= 1.03) {
    return buildDeal("good", "值得关注", 78, "当前最低价低于预算，且接近该任务历史低位。", bestSnapshot, summary);
  }

  if (budgetRatio <= 1) {
    return buildDeal("watch", "可以观望", 62, "当前最低价低于预算，但还没有明显低于近期价格。", bestSnapshot, summary);
  }

  return buildDeal("wait", "继续观望", 38, "当前最低价高于预算，建议继续监控或扩大日期浮动。", bestSnapshot, summary);
}

function buildDeal(status, label, score, reason, bestSnapshot, summary) {
  return {
    status,
    label,
    score,
    reason,
    bestSnapshot,
    historicalLow: summary.historicalLow,
    average30: summary.average30
  };
}

export function formatMoney(amount, currency = "CNY") {
  const symbol = currency === "CNY" ? "¥" : currency;
  return `${symbol}${Number(amount).toLocaleString("zh-CN")}`;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function holidayUrgencyFactor(departDate) {
  const days = Math.ceil((new Date(departDate).getTime() - Date.now()) / 86400000);
  if (days < 21) return 1.2;
  if (days < 60) return 1.08;
  if (days > 180) return 0.94;
  return 1;
}

function chooseAirline(destination, strategyType, hash) {
  const domestic = ["东方航空", "上海航空", "吉祥航空", "春秋航空"];
  const international = ["东方航空", "全日空", "大韩航空", "亚洲航空", "越捷航空"];
  const pool = destination.isDomestic ? domestic : international;
  const airline = pool[hash % pool.length];
  return strategyType === "transfer" ? `${airline} / 联运` : airline;
}

function chooseTransferCity(destination, hash) {
  const domestic = ["武汉", "西安", "昆明", "广州"];
  const international = ["首尔", "香港", "台北", "吉隆坡"];
  const pool = destination.isDomestic ? domestic : international;
  return [pool[hash % pool.length]];
}

function estimateDuration(destination, strategyType, hash) {
  const base = destination.isDomestic ? 150 : 260;
  const strategyExtra = strategyType === "transfer" ? 150 : 0;
  return base + strategyExtra + (hash % 90);
}
