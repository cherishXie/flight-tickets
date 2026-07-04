export const SOURCE_CATEGORIES = {
  LIVE_API: "live_api",
  OFFICIAL_AIRLINE: "official_airline",
  OTA: "ota",
  META_SEARCH: "meta_search",
  MANUAL: "manual",
  CSV_IMPORT: "csv_import",
  SIMULATION: "simulation"
};

export const MANUAL_SOURCE_OPTIONS = [
  {
    label: "航司官网",
    source: "航司官网",
    sourceCategory: SOURCE_CATEGORIES.OFFICIAL_AIRLINE,
    sourceProvider: "official-airline"
  },
  {
    label: "携程",
    source: "携程机票",
    sourceCategory: SOURCE_CATEGORIES.OTA,
    sourceProvider: "ctrip"
  },
  {
    label: "Trip.com",
    source: "Trip.com",
    sourceCategory: SOURCE_CATEGORIES.OTA,
    sourceProvider: "trip.com"
  },
  {
    label: "Google Flights",
    source: "Google Flights",
    sourceCategory: SOURCE_CATEGORIES.META_SEARCH,
    sourceProvider: "google-flights"
  },
  {
    label: "其他来源",
    source: "手动录入",
    sourceCategory: SOURCE_CATEGORIES.MANUAL,
    sourceProvider: "manual-entry"
  }
];

export function manualSourceOptionByProvider(sourceProvider) {
  return MANUAL_SOURCE_OPTIONS.find((option) => option.sourceProvider === sourceProvider) || MANUAL_SOURCE_OPTIONS[0];
}
