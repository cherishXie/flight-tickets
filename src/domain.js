export function splitList(value) {
  return value
    .split(/[,，/]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildCustomHoliday({ name, startDate, endDate }) {
  return {
    id: `custom-holiday-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    type: "custom",
    countryOrRegion: "自定义",
    startDate,
    endDate,
    isBuiltin: false,
    isRecommended: false,
    priority: 50,
    reason: "用户手动输入的节假日或出行窗口。",
    flexBefore: 0,
    flexAfter: 0
  };
}

export function buildCustomDestination({
  name,
  countryOrRegion,
  airportCodes,
  tags,
  directPrice,
  transferPrice,
  isDomestic
}) {
  const parsedTags = splitList(tags || "自然风景, 历史人文");
  const parsedAirportCodes = splitList(airportCodes || "TBD").map((item) => item.toUpperCase());
  const parsedDirectPrice = Number(directPrice) || 2200;
  const parsedTransferPrice = Number(transferPrice) || Math.max(800, parsedDirectPrice - 300);

  return {
    id: `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    countryOrRegion: countryOrRegion || (isDomestic ? "中国大陆" : "待确认"),
    isDomestic,
    airportCodes: parsedAirportCodes,
    tags: parsedTags,
    bestSeasons: ["待确认"],
    travelValueNote: "用户手动输入的目的地。",
    visaNote: isDomestic ? "无需签证" : "需按当期政策确认入境要求",
    isSystemRecommended: false,
    priority: 65,
    reason: "用户自定义目的地，优先按输入预算和模拟价格监控。",
    recommendedHolidayTypes: ["custom"],
    recommendedStrategyTypes: ["direct", "transfer"],
    baseDirectPrice: parsedDirectPrice,
    baseTransferPrice: parsedTransferPrice,
    valueScores: {
      nature: parsedTags.includes("自然风景") ? 80 : 60,
      culture: parsedTags.includes("历史人文") ? 80 : 60,
      convenience: 65,
      visa: isDomestic ? 100 : 65
    }
  };
}

export function generateFlexibleDateOptions({ departDate, returnDate, flexBefore = 0, flexAfter = 0 }) {
  const before = Math.max(0, Number(flexBefore) || 0);
  const after = Math.max(0, Number(flexAfter) || 0);
  const options = [];

  for (let offset = -before; offset <= after; offset += 1) {
    options.push({
      id: offset === 0 ? "base" : `shift-${offset}`,
      label: offsetLabel(offset),
      departDate: addDays(departDate, offset),
      returnDate: addDays(returnDate, offset),
      offsetDays: offset
    });
  }

  return options;
}

export function buildManualPriceSnapshot({
  task,
  destination,
  departDate,
  returnDate,
  strategyType,
  airline,
  durationMinutes,
  priceAmount,
  priceCurrency,
  transferCities,
  includesCheckedBag,
  source,
  bookingUrl,
  searchedAt = new Date()
}) {
  const transfers = splitList(transferCities || "");
  return {
    id: `manual-${task.id}-${destination.id}-${strategyType}-${departDate}-${returnDate}-${searchedAt.getTime()}`,
    watchTaskId: task.id,
    destinationId: destination.id,
    originAirport: task.originAirportCodes[0],
    destinationAirport: destination.airportCodes[0],
    departDate,
    returnDate,
    strategyType,
    airline: airline || "手动录入航司",
    flightIdentifier: `MANUAL-${destination.airportCodes[0]}-${searchedAt.getTime()}`,
    transferCount: strategyType === "transfer" ? Math.max(1, transfers.length) : 0,
    transferCities: strategyType === "transfer" ? transfers : [],
    durationMinutes: Number(durationMinutes) || 0,
    priceAmount: Number(priceAmount),
    priceCurrency: priceCurrency || task.budgetCurrency,
    includesTax: true,
    includesCheckedBag: Boolean(includesCheckedBag),
    source: source || "手动录入",
    bookingUrl: bookingUrl || "",
    searchedAt: searchedAt.toISOString()
  };
}

export function parseCsvRows(text) {
  const rows = text
    .trim()
    .split(/\r?\n/)
    .map(parseCsvLine)
    .filter((row) => row.some((cell) => cell !== ""));
  if (rows.length < 2) return [];

  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((row) => {
    const item = {};
    headers.forEach((header, index) => {
      item[header] = row[index] || "";
    });
    return item;
  });
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current.trim());
  return cells;
}

function addDays(dateText, offset) {
  const date = new Date(`${dateText}T00:00:00`);
  date.setDate(date.getDate() + offset);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function offsetLabel(offset) {
  if (offset === 0) return "原始日期";
  return offset > 0 ? `整体后移 ${offset} 天` : `整体前移 ${Math.abs(offset)} 天`;
}
