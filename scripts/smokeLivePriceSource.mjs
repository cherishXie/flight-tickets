import { DESTINATIONS } from "../src/data.js";
import { checkAmadeusHealth, collectAmadeusSnapshots } from "./amadeusFlightSource.mjs";
import { loadLocalEnv } from "./localEnv.mjs";

loadLocalEnv();

const args = parseArgs(process.argv.slice(2));
const originAirport = normalizeAirport(args.origin || "PVG");
const destination = resolveDestination(args.destination || "osaka-kyoto");
const departDate = args.depart || addDays(new Date(), 90);
const returnDate = args.return || addDays(new Date(`${departDate}T00:00:00`), Number(args.tripDays || 5));
const strategy = args.strategy || "direct";
const passengerCount = clampNumber(args.adults, 1, 9, 1);
const budgetCurrency = String(args.currency || "CNY").toUpperCase();
const maxOffersPerSearch = clampNumber(args.maxOffers, 1, 20, 5);

const report = {
  route: `${originAirport}-${destination.airportCodes[0]}`,
  destination: {
    id: destination.id,
    name: destination.name,
    airportCodes: destination.airportCodes
  },
  departDate,
  returnDate,
  strategy,
  passengerCount,
  budgetCurrency,
  snapshots: [],
  warnings: []
};

report.priceSourceHealth = await checkAmadeusHealth();
if (!report.priceSourceHealth.ok) {
  report.warnings.push(report.priceSourceHealth.message);
  console.log(JSON.stringify(report, null, 2));
  process.exit(2);
}

const task = {
  id: `smoke-live-${Date.now()}`,
  name: "Live price source smoke test",
  status: "active",
  originCity: "Shanghai",
  originAirportCodes: [originAirport],
  destinationIds: [destination.id],
  departDate,
  returnDate,
  passengerCount,
  budgetAmount: 999999,
  budgetCurrency,
  monitorDirect: strategy === "direct" || strategy === "both",
  monitorTransfer: strategy === "transfer" || strategy === "both"
};

const result = await collectAmadeusSnapshots({
  task,
  destinations: [destination],
  dateOptions: [{ departDate, returnDate }],
  maxOffersPerSearch,
  maxQueriesPerRun: 4
});

report.provider = result.provider;
report.environment = result.environment;
report.executedSearches = result.executedSearches;
report.skippedSearches = result.skippedSearches;
report.cacheHits = result.cacheHits;
report.cacheMisses = result.cacheMisses;
report.warnings.push(...result.warnings);
report.snapshots = result.snapshots.map((snapshot) => ({
  sourceType: snapshot.sourceType,
  sourceProvider: snapshot.sourceProvider,
  sourceCategory: snapshot.sourceCategory,
  sourceVerifiedAt: snapshot.sourceVerifiedAt,
  rawProviderOfferId: snapshot.rawProviderOfferId,
  originAirport: snapshot.originAirport,
  destinationAirport: snapshot.destinationAirport,
  departDate: snapshot.departDate,
  returnDate: snapshot.returnDate,
  strategyType: snapshot.strategyType,
  airline: snapshot.airline,
  flightIdentifier: snapshot.flightIdentifier,
  durationMinutes: snapshot.durationMinutes,
  transferCount: snapshot.transferCount,
  transferCities: snapshot.transferCities,
  priceAmount: snapshot.priceAmount,
  priceCurrency: snapshot.priceCurrency,
  includesTax: snapshot.includesTax,
  includesCheckedBag: snapshot.includesCheckedBag,
  bookingUrl: snapshot.bookingUrl
}));

console.log(JSON.stringify(report, null, 2));

if (!report.snapshots.length) {
  process.exit(3);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    parsed[key] = argv[index + 1];
    index += 1;
  }
  return parsed;
}

function resolveDestination(value) {
  const key = String(value || "").trim().toLowerCase();
  const destination = DESTINATIONS.find((item) => {
    const airportCodes = item.airportCodes || [];
    return (
      item.id.toLowerCase() === key ||
      item.name.toLowerCase() === key ||
      airportCodes.some((code) => code.toLowerCase() === key)
    );
  });
  if (destination) return destination;

  const airportCode = normalizeAirport(value);
  return {
    id: `custom-${airportCode.toLowerCase()}`,
    name: airportCode,
    countryOrRegion: "",
    airportCodes: [airportCode],
    isDomestic: false,
    baseDirectPrice: 0,
    baseTransferPrice: 0
  };
}

function normalizeAirport(value) {
  const airport = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(airport)) {
    throw new Error(`Invalid airport code: ${value}`);
  }
  return airport;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + Number(days));
  return [
    copy.getFullYear(),
    String(copy.getMonth() + 1).padStart(2, "0"),
    String(copy.getDate()).padStart(2, "0")
  ].join("-");
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
