import assert from "assert";
import { DESTINATIONS, HOLIDAYS, RECOMMENDATION_PRESETS } from "../src/data.js";
import {
  buildCustomDestination,
  buildCustomHoliday,
  buildManualPriceSnapshot,
  generateFlexibleDateOptions,
  parseCsvRows,
  splitList
} from "../src/domain.js";
import { parseBackup, pruneSnapshotsByTask, removeTaskData, serializeBackup, serializeCsv } from "../src/storage.js";
import { collectPriceSnapshots, listPriceSources, PRICE_SOURCE_TYPES } from "../src/priceSources.js";
import { buildEmailDraft, buildEmlContent, buildMailtoLink, listNotificationChannels, NOTIFICATION_CHANNELS } from "../src/notifications.js";
import {
  buildRecommendationScore,
  createPriceSnapshot,
  evaluateDeal,
  evaluateAlert,
  getDestination,
  summarizeSnapshots
} from "../src/pricing.js";

const recommendedHolidays = HOLIDAYS.filter((holiday) => holiday.isRecommended);
assert.ok(recommendedHolidays.length >= 7, "should seed at least 7 recommended holidays");
for (const holidayName of ["元旦", "春节", "清明", "劳动节", "端午", "中秋", "国庆"]) {
  assert.ok(HOLIDAYS.some((holiday) => holiday.name.includes(holidayName)), `should seed ${holidayName}`);
}

const recommendedDestinations = DESTINATIONS.filter((destination) => destination.isSystemRecommended);
assert.ok(DESTINATIONS.length >= 20, "should seed at least 20 candidate destinations");
assert.ok(recommendedDestinations.length >= 20, "should seed at least 20 recommended destinations");
assert.ok(recommendedDestinations.some((destination) => destination.isDomestic), "should include domestic destinations");
assert.ok(recommendedDestinations.some((destination) => !destination.isDomestic), "should include international destinations");

const presets = RECOMMENDATION_PRESETS.filter((preset) => preset.enabled);
assert.ok(presets.length >= 11, "should seed at least 11 recommendation presets");

for (const preset of presets) {
  const holiday = HOLIDAYS.find((item) => item.id === preset.holidayId);
  const destinations = preset.destinationIds.map(getDestination).filter(Boolean);
  assert.ok(holiday, `preset ${preset.id} should reference a holiday`);
  assert.equal(destinations.length, preset.destinationIds.length, `preset ${preset.id} should reference valid destinations`);
  assert.ok(buildRecommendationScore(preset, holiday, destinations) > 0, "recommendation score should be positive");
}

const task = {
  id: "task-test",
  destinationIds: ["osaka-kyoto"],
  originCity: "上海",
  originAirportCodes: ["PVG", "SHA"],
  departDate: "2026-10-01",
  returnDate: "2026-10-07",
  budgetAmount: 5000,
  budgetCurrency: "CNY"
};
const destination = getDestination("osaka-kyoto");
const snapshot = createPriceSnapshot({
  task,
  destination,
  strategyType: "transfer",
  searchedAt: new Date("2026-07-02T00:00:00Z")
});
assert.equal(snapshot.strategyType, "transfer");
assert.equal(snapshot.transferCount, 1);
assert.ok(snapshot.priceAmount > 0, "snapshot should have a positive price");

const sourceSnapshots = collectPriceSnapshots({
  task: { ...task, monitorDirect: true, monitorTransfer: true },
  destinations: [destination],
  dateOptions: [
    { departDate: "2026-10-01", returnDate: "2026-10-07" },
    { departDate: "2026-10-02", returnDate: "2026-10-08" }
  ],
  sourceType: PRICE_SOURCE_TYPES.MOCK,
  searchedAt: new Date("2026-07-02T00:00:00Z")
});
assert.equal(sourceSnapshots.length, 4);
assert.deepEqual(new Set(sourceSnapshots.map((item) => item.strategyType)), new Set(["direct", "transfer"]));
assert.ok(listPriceSources().some((source) => source.id === PRICE_SOURCE_TYPES.MOCK), "should expose mock price source");

const alert = evaluateAlert({ task, snapshot, history: [] });
assert.equal(alert.shouldAlert, true);
assert.ok(alert.reasons.includes("刷新该任务历史最低价"), "first snapshot should be historical low");

const otherDateSnapshot = {
  ...snapshot,
  id: "other-date",
  departDate: "2026-10-02",
  returnDate: "2026-10-08",
  priceAmount: 1000
};
const sameDateAlert = evaluateAlert({ task, snapshot: { ...snapshot, priceAmount: 1800 }, history: [otherDateSnapshot] });
assert.ok(sameDateAlert.reasons.includes("刷新该任务历史最低价"), "date-specific series should not use other dates");

const disabledRulesAlert = evaluateAlert({
  task,
  snapshot: { ...snapshot, priceAmount: 1200 },
  history: [],
  rules: {
    budgetEnabled: false,
    historicalLowEnabled: false,
    averageDropEnabled: false,
    averageDropPercent: 15
  }
});
assert.equal(disabledRulesAlert.shouldAlert, false);

const averageDropAlert = evaluateAlert({
  task,
  snapshot: { ...snapshot, priceAmount: 800 },
  history: [
    { ...snapshot, id: "avg-1", priceAmount: 1200 },
    { ...snapshot, id: "avg-2", priceAmount: 1200 }
  ],
  rules: {
    budgetEnabled: false,
    historicalLowEnabled: false,
    averageDropEnabled: true,
    averageDropPercent: 20
  }
});
assert.equal(averageDropAlert.shouldAlert, true);
assert.ok(averageDropAlert.reasons.some((reason) => reason.includes("低于近期均价")));

const summary = summarizeSnapshots([
  { ...snapshot, priceAmount: 2400, searchedAt: "2026-07-01T00:00:00.000Z" },
  { ...snapshot, priceAmount: 2000, searchedAt: "2026-07-02T00:00:00.000Z" }
]);
assert.equal(summary.count, 2);
assert.equal(summary.historicalLow, 2000);
assert.equal(summary.current.priceAmount, 2000);
assert.equal(summary.trendPercent, -17);

const buyDecision = evaluateDeal({
  task: { ...task, budgetAmount: 3000 },
  snapshots: [
    { ...snapshot, priceAmount: 2800, searchedAt: "2026-07-01T00:00:00.000Z" },
    { ...snapshot, priceAmount: 2200, searchedAt: "2026-07-02T00:00:00.000Z" }
  ]
});
assert.equal(buyDecision.status, "buy");
assert.equal(buyDecision.bestSnapshot.priceAmount, 2200);

const waitDecision = evaluateDeal({
  task: { ...task, budgetAmount: 1000 },
  snapshots: [{ ...snapshot, priceAmount: 2200, searchedAt: "2026-07-02T00:00:00.000Z" }]
});
assert.equal(waitDecision.status, "wait");

const customDestination = {
  id: "custom-fukuoka",
  name: "福冈",
  countryOrRegion: "日本",
  isDomestic: false,
  airportCodes: ["FUK"],
  tags: ["历史人文", "美食"],
  baseDirectPrice: 2100,
  baseTransferPrice: 1700
};
const customSnapshot = createPriceSnapshot({
  task: { ...task, destinationIds: ["custom-fukuoka"] },
  destination: customDestination,
  strategyType: "direct",
  searchedAt: new Date("2026-07-02T00:00:00Z")
});
assert.equal(customSnapshot.destinationAirport, "FUK");
assert.equal(customSnapshot.strategyType, "direct");
assert.ok(customSnapshot.priceAmount > 0, "custom destination snapshot should have a price");

const customHoliday = buildCustomHoliday({
  name: "公司年假",
  startDate: "2027-06-01",
  endDate: "2027-06-08"
});
assert.equal(customHoliday.name, "公司年假");
assert.equal(customHoliday.type, "custom");
assert.equal(customHoliday.startDate, "2027-06-01");

const builtDestination = buildCustomDestination({
  name: "福冈",
  countryOrRegion: "日本",
  airportCodes: "fuk",
  tags: "历史人文, 美食",
  directPrice: 2100,
  transferPrice: 1700,
  isDomestic: false
});
assert.equal(builtDestination.airportCodes[0], "FUK");
assert.equal(builtDestination.baseTransferPrice, 1700);
assert.deepEqual(splitList("自然风景,历史人文/美食"), ["自然风景", "历史人文", "美食"]);

const flexibleDates = generateFlexibleDateOptions({
  departDate: "2027-06-10",
  returnDate: "2027-06-15",
  flexBefore: 1,
  flexAfter: 1
});
assert.deepEqual(
  flexibleDates.map((option) => `${option.departDate}/${option.returnDate}`),
  ["2027-06-09/2027-06-14", "2027-06-10/2027-06-15", "2027-06-11/2027-06-16"]
);

const manualSnapshot = buildManualPriceSnapshot({
  task,
  destination,
  departDate: "2026-10-01",
  returnDate: "2026-10-07",
  strategyType: "transfer",
  airline: "手动航空",
  durationMinutes: 480,
  priceAmount: 1680,
  priceCurrency: "CNY",
  transferCities: "首尔, 香港",
  includesCheckedBag: true,
  source: "航司官网",
  bookingUrl: "https://example.com",
  searchedAt: new Date("2026-07-03T00:00:00Z")
});
assert.equal(manualSnapshot.priceAmount, 1680);
assert.equal(manualSnapshot.transferCount, 2);
const csvRows = parseCsvRows([
  "destination,departDate,returnDate,strategyType,priceAmount,airline,durationMinutes,transferCities,source,bookingUrl,includesCheckedBag",
  "fukuoka,2027-02-10,2027-02-15,transfer,1680,Demo Air,430,\"Seoul, Hong Kong\",official,https://example.com,true",
  "osaka-kyoto,2027-02-10,2027-02-15,direct,2100,Demo Air,180,,ota,,false"
].join("\n"));
assert.equal(csvRows.length, 2);
assert.equal(csvRows[0].transferCities, "Seoul, Hong Kong");
assert.equal(csvRows[1].bookingUrl, "");
assert.deepEqual(manualSnapshot.transferCities, ["首尔", "香港"]);
assert.equal(manualSnapshot.includesCheckedBag, true);
assert.equal(manualSnapshot.source, "航司官网");

const emailDraft = buildEmailDraft({
  alert: {
    recipientEmail: "traveler@example.com",
    subject: "[机票提醒] 测试",
    triggerReason: "低于预算",
    historicalLow: 1680,
    average30: 2300
  },
  task: { ...task, name: "国庆测试", passengerCount: 2 },
  snapshot: manualSnapshot,
  destination
});
assert.equal(emailDraft.to, "traveler@example.com");
assert.ok(emailDraft.body.includes("国庆测试"));
assert.ok(emailDraft.body.includes("航线：上海 (PVG / SHA) -> 大阪 / 京都"));
assert.ok(emailDraft.body.includes("中转：首尔 / 香港，2 次中转"));
assert.ok(buildMailtoLink(emailDraft).startsWith("mailto:traveler%40example.com"));
const emlContent = buildEmlContent(emailDraft, new Date("2026-07-03T00:00:00Z"));
assert.ok(emlContent.includes("Content-Type: text/plain; charset=utf-8"));
assert.ok(emlContent.includes("Subject: [机票提醒] 测试"));
assert.ok(listNotificationChannels().some((channel) => channel.id === NOTIFICATION_CHANNELS.EML));

const alternateOriginDraft = buildEmailDraft({
  alert: {
    recipientEmail: "traveler@example.com",
    subject: "[机票提醒] 非上海测试",
    triggerReason: "低于预算"
  },
  task: { ...task, originCity: "杭州", originAirportCodes: ["HGH"], name: "杭州出发测试" },
  snapshot: manualSnapshot,
  destination
});
assert.ok(alternateOriginDraft.body.includes("航线：杭州 (HGH) -> 大阪 / 京都"));

const csvText = serializeCsv(
  [{ destination: "大阪, 京都", note: "quote \"inside\"", priceAmount: 1680 }],
  [
    { key: "destination", label: "destination" },
    { key: "note", label: "note" },
    { key: "priceAmount", label: "priceAmount" }
  ]
);
assert.ok(csvText.includes("\"大阪, 京都\""));
assert.ok(csvText.includes("\"quote \"\"inside\"\"\""));

const backupText = serializeBackup({
  tasks: [task],
  snapshots: [snapshot],
  alerts: [],
  settings: { email: "traveler@example.com" },
  profiles: [
    {
      id: "local-user",
      displayName: "我",
      email: "traveler@example.com",
      originCity: "上海",
      originAirportCodes: ["PVG", "SHA"],
      preferredDestinationTags: ["自然风景", "历史人文"]
    }
  ],
  activeProfileId: "local-user",
  customHolidays: [customHoliday],
  customDestinations: [builtDestination]
});
const restored = parseBackup(backupText, { email: "default@example.com", cooldownHours: 12 });
assert.equal(restored.tasks.length, 1);
assert.equal(restored.snapshots.length, 1);
assert.equal(restored.settings.email, "traveler@example.com");
assert.equal(restored.settings.cooldownHours, 12);
assert.equal(restored.profiles[0].originCity, "上海");
assert.equal(restored.activeProfileId, "local-user");
assert.equal(restored.customHolidays[0].name, "公司年假");

const removed = removeTaskData(
  {
    tasks: [{ id: "task-test" }, { id: "task-keep" }],
    snapshots: [{ id: "snap-remove", watchTaskId: "task-test" }, { id: "snap-keep", watchTaskId: "task-keep" }],
    alerts: [
      { id: "alert-remove", watchTaskId: "task-test", flightPriceSnapshotId: "snap-remove" },
      { id: "alert-keep", watchTaskId: "task-keep", flightPriceSnapshotId: "snap-keep" }
    ]
  },
  "task-test"
);
assert.deepEqual(removed.tasks.map((item) => item.id), ["task-keep"]);
assert.deepEqual(removed.snapshots.map((item) => item.id), ["snap-keep"]);
assert.deepEqual(removed.alerts.map((item) => item.id), ["alert-keep"]);

const pruned = pruneSnapshotsByTask(
  {
    snapshots: [
      { id: "task-a-old", watchTaskId: "task-a", searchedAt: "2026-07-01T00:00:00.000Z" },
      { id: "task-a-mid", watchTaskId: "task-a", searchedAt: "2026-07-02T00:00:00.000Z" },
      { id: "task-a-new", watchTaskId: "task-a", searchedAt: "2026-07-03T00:00:00.000Z" },
      { id: "task-b-old", watchTaskId: "task-b", searchedAt: "2026-07-01T00:00:00.000Z" },
      { id: "task-b-new", watchTaskId: "task-b", searchedAt: "2026-07-03T00:00:00.000Z" }
    ],
    alerts: [
      { id: "alert-pruned", flightPriceSnapshotId: "task-a-old" },
      { id: "alert-kept", flightPriceSnapshotId: "task-b-new" }
    ]
  },
  2
);
assert.deepEqual(pruned.removedSnapshotIds, ["task-a-old"]);
assert.deepEqual(pruned.snapshots.map((item) => item.id), ["task-a-mid", "task-a-new", "task-b-old", "task-b-new"]);
assert.deepEqual(pruned.alerts.map((item) => item.id), ["alert-kept"]);

console.log("recommendation tests passed");
