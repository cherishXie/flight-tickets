import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { buildPrimaryBookingUrl } from "../src/externalSearchLinks.js";

const DEFAULT_TEST_BASE_URL = "https://test.api.amadeus.com";
const DEFAULT_PROD_BASE_URL = "https://api.amadeus.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_RETRY_COUNT = 1;

let tokenCache = null;
const flightOfferCache = new Map();

export function getAmadeusConfig(env = process.env) {
  const clientId = env.AMADEUS_CLIENT_ID || "";
  const clientSecret = env.AMADEUS_CLIENT_SECRET || "";
  const environment = (env.AMADEUS_ENV || "test").toLowerCase();
  const baseUrl = env.AMADEUS_BASE_URL || (environment === "production" ? DEFAULT_PROD_BASE_URL : DEFAULT_TEST_BASE_URL);
  return {
    provider: "amadeus",
    configured: Boolean(clientId && clientSecret),
    environment,
    baseUrl,
    requestTimeoutMs: clampNumber(env.AMADEUS_REQUEST_TIMEOUT_MS, 1000, 120000, DEFAULT_REQUEST_TIMEOUT_MS),
    retryCount: clampNumber(env.AMADEUS_RETRY_COUNT, 0, 3, DEFAULT_RETRY_COUNT),
    clientId,
    clientSecret
  };
}

export async function collectAmadeusSnapshots(
  { task, destinations, dateOptions, maxOffersPerSearch = 8, maxQueriesPerRun },
  env = process.env
) {
  const config = getAmadeusConfig(env);
  if (!config.configured) {
    throw new Error("Amadeus API 未配置。请设置 AMADEUS_CLIENT_ID 和 AMADEUS_CLIENT_SECRET。");
  }

  const queryBudget = {
    limit: clampNumber(maxQueriesPerRun, 1, 100, clampNumber(env.AMADEUS_MAX_QUERIES_PER_RUN, 1, 100, 24)),
    executed: 0,
    skipped: 0,
    cacheHits: 0,
    cacheMisses: 0
  };
  const cacheTtlMinutes = clampNumber(env.AMADEUS_CACHE_TTL_MINUTES, 0, 1440, 30);
  const estimatedSearches = estimateAmadeusSearchCount({ task, destinations, dateOptions });
  const strategies = [
    task.monitorDirect ? "direct" : null,
    task.monitorTransfer ? "transfer" : null
  ].filter(Boolean);
  const snapshots = [];
  const warnings = [];
  const searchedAt = new Date();

  for (const destination of destinations) {
    for (const dateOption of dateOptions) {
      for (const strategyType of strategies) {
        const searchResult = await searchBestOffersForSeries({
          config,
          task,
          destination,
          dateOption,
          strategyType,
          maxOffersPerSearch,
          queryBudget,
          cacheTtlMinutes,
          searchedAt
        });
        snapshots.push(...searchResult.snapshots);
        warnings.push(...searchResult.warnings);
      }
    }
  }

  return {
    provider: "amadeus",
    environment: config.environment,
    searchedAt: searchedAt.toISOString(),
    snapshots,
    warnings,
    estimatedSearches,
    executedSearches: queryBudget.executed,
    skippedSearches: queryBudget.skipped,
    cacheHits: queryBudget.cacheHits,
    cacheMisses: queryBudget.cacheMisses,
    cacheTtlMinutes
  };
}

export function estimateAmadeusSearchCount({ task, destinations, dateOptions }) {
  const strategies = [
    task?.monitorDirect ? "direct" : null,
    task?.monitorTransfer ? "transfer" : null
  ].filter(Boolean);
  const originCount = normalizeAirportCodes(task?.originAirportCodes).slice(0, 2).length;
  const destinationPairCount = (destinations || []).reduce(
    (sum, destination) => sum + normalizeAirportCodes(destination.airportCodes).slice(0, 2).length,
    0
  );
  return originCount * destinationPairCount * (dateOptions || []).length * strategies.length;
}

export async function checkAmadeusHealth(env = process.env) {
  const config = getAmadeusConfig(env);
  const checkedAt = new Date().toISOString();
  if (!config.configured) {
    return {
      provider: "amadeus",
      configured: false,
      ok: false,
      environment: config.environment,
      baseUrl: config.baseUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      retryCount: config.retryCount,
      checkedAt,
      message: "Amadeus API 未配置。请设置 AMADEUS_CLIENT_ID 和 AMADEUS_CLIENT_SECRET。"
    };
  }

  try {
    await getAccessToken(config);
    return {
      provider: "amadeus",
      configured: true,
      ok: true,
      environment: config.environment,
      baseUrl: config.baseUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      retryCount: config.retryCount,
      checkedAt,
      message: "Amadeus OAuth 连接验证成功。"
    };
  } catch (error) {
    return {
      provider: "amadeus",
      configured: true,
      ok: false,
      environment: config.environment,
      baseUrl: config.baseUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      retryCount: config.retryCount,
      checkedAt,
      message: error.message
    };
  }
}

export function resetAmadeusTokenCache() {
  tokenCache = null;
}

export function resetAmadeusFlightOfferCache() {
  flightOfferCache.clear();
}

export function buildAmadeusFlightOfferCacheKey({
  config,
  originAirport,
  destinationAirport,
  departureDate,
  returnDate,
  adults,
  currencyCode,
  nonStop,
  max
}) {
  return [
    config.baseUrl,
    originAirport,
    destinationAirport,
    departureDate,
    returnDate || "",
    Math.min(Math.max(Number(adults) || 1, 1), 9),
    currencyCode,
    Boolean(nonStop),
    Number(max) || 8
  ].join("|");
}

export function transformAmadeusOfferToSnapshot({ offer, task, destination, strategyType, originAirport, destinationAirport, dateOption, searchedAt }) {
  const outbound = offer.itineraries?.[0];
  const outboundSegments = outbound?.segments || [];
  const returnSegments = offer.itineraries?.[1]?.segments || [];
  const allSegments = [...outboundSegments, ...returnSegments];
  const firstSegment = outboundSegments[0] || allSegments[0] || {};
  const transferCities = outboundSegments.slice(0, -1).map((segment) => segment.arrival?.iataCode).filter(Boolean);
  const airlineCode = firstSegment.carrierCode || offer.validatingAirlineCodes?.[0] || "航空公司";
  const flightIdentifier = allSegments
    .map((segment) => `${segment.carrierCode || ""}${segment.number || ""}`)
    .filter(Boolean)
    .join(" / ");

  const snapshot = {
    id: `live-amadeus-${task.id}-${destination.id}-${strategyType}-${dateOption.departDate}-${dateOption.returnDate}-${offer.id || Date.now()}-${Math.random().toString(16).slice(2)}`,
    watchTaskId: task.id,
    destinationId: destination.id,
    originAirport,
    destinationAirport,
    departDate: dateOption.departDate,
    returnDate: dateOption.returnDate,
    strategyType,
    airline: airlineCode,
    flightIdentifier: flightIdentifier || `AMADEUS-${offer.id || ""}`,
    transferCount: strategyType === "transfer" ? Math.max(1, outboundSegments.length - 1) : 0,
    transferCities: strategyType === "transfer" ? transferCities : [],
    durationMinutes: offer.itineraries?.reduce((sum, itinerary) => sum + parseIsoDurationMinutes(itinerary.duration), 0) || 0,
    priceAmount: Math.round(Number(offer.price?.grandTotal || offer.price?.total || 0)),
    priceCurrency: offer.price?.currency || task.budgetCurrency || "CNY",
    includesTax: true,
    includesCheckedBag: hasIncludedCheckedBag(offer),
    source: "Amadeus Flight Offers Search",
    sourceType: "live_api",
    sourceProvider: "amadeus",
    sourceCategory: "live_api",
    sourceVerifiedAt: searchedAt.toISOString(),
    bookingUrl: "",
    rawProviderOfferId: offer.id || "",
    searchedAt: searchedAt.toISOString()
  };
  snapshot.bookingUrl = buildPrimaryBookingUrl({ snapshot, task, destination });
  return snapshot;
}

async function searchBestOffersForSeries({
  config,
  task,
  destination,
  dateOption,
  strategyType,
  maxOffersPerSearch,
  queryBudget,
  cacheTtlMinutes,
  searchedAt
}) {
  const snapshots = [];
  const warnings = [];
  const originCodes = normalizeAirportCodes(task.originAirportCodes).slice(0, 2);
  const destinationCodes = normalizeAirportCodes(destination.airportCodes).slice(0, 2);

  for (const originAirport of originCodes) {
    for (const destinationAirport of destinationCodes) {
      try {
        const offers = await requestFlightOffers({
          config,
          originAirport,
          destinationAirport,
          departureDate: dateOption.departDate,
          returnDate: dateOption.returnDate,
          adults: Number(task.passengerCount) || 1,
          currencyCode: task.budgetCurrency || "CNY",
          nonStop: strategyType === "direct",
          max: maxOffersPerSearch,
          queryBudget,
          cacheTtlMinutes
        });
        const matchingOffers = offers.filter((offer) => offerMatchesStrategy(offer, strategyType)).slice(0, 2);
        matchingOffers.forEach((offer) => {
          const snapshot = transformAmadeusOfferToSnapshot({
            offer,
            task,
            destination,
            strategyType,
            originAirport,
            destinationAirport,
            dateOption,
            searchedAt
          });
          if (Number.isFinite(snapshot.priceAmount) && snapshot.priceAmount > 0) {
            snapshots.push(snapshot);
          }
        });
      } catch (error) {
        warnings.push(`${originAirport}-${destinationAirport} ${dateOption.departDate} ${strategyType}: ${error.message}`);
      }
    }
  }

  snapshots.sort((a, b) => a.priceAmount - b.priceAmount);
  return { snapshots: snapshots.slice(0, 2), warnings };
}

async function requestFlightOffers({
  config,
  originAirport,
  destinationAirport,
  departureDate,
  returnDate,
  adults,
  currencyCode,
  nonStop,
  max,
  queryBudget,
  cacheTtlMinutes
}) {
  const cacheKey = buildAmadeusFlightOfferCacheKey({
    config,
    originAirport,
    destinationAirport,
    departureDate,
    returnDate,
    adults,
    currencyCode,
    nonStop,
    max
  });
  const cached = getCachedFlightOffers(cacheKey, cacheTtlMinutes);
  if (cached) {
    queryBudget.cacheHits += 1;
    return cached;
  }

  if (queryBudget.executed >= queryBudget.limit) {
    queryBudget.skipped += 1;
    throw new Error(`已达到本次真实查询上限 ${queryBudget.limit}，跳过。`);
  }

  queryBudget.executed += 1;
  queryBudget.cacheMisses += 1;
  const token = await getAccessToken(config);
  const query = new URLSearchParams({
    originLocationCode: originAirport,
    destinationLocationCode: destinationAirport,
    departureDate,
    adults: String(Math.min(Math.max(adults, 1), 9)),
    currencyCode,
    nonStop: String(Boolean(nonStop)),
    max: String(max)
  });
  if (returnDate) {
    query.set("returnDate", returnDate);
  }

  const response = await httpJson(`${config.baseUrl}/v2/shopping/flight-offers?${query.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    },
    timeoutMs: config.requestTimeoutMs,
    retryCount: config.retryCount
  });

  const offers = Array.isArray(response.data) ? response.data : [];
  setCachedFlightOffers(cacheKey, offers, cacheTtlMinutes);
  return offers;
}

async function getAccessToken(config) {
  const now = Date.now();
  if (tokenCache?.baseUrl === config.baseUrl && tokenCache?.clientId === config.clientId && tokenCache.expiresAt > now + 60000) {
    return tokenCache.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret
  }).toString();
  const response = await httpJson(`${config.baseUrl}/v1/security/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body,
    timeoutMs: config.requestTimeoutMs,
    retryCount: config.retryCount
  });

  tokenCache = {
    baseUrl: config.baseUrl,
    clientId: config.clientId,
    accessToken: response.access_token,
    expiresAt: Date.now() + Math.max(1, Number(response.expires_in) || 1) * 1000
  };
  return tokenCache.accessToken;
}

async function httpJson(url, { method, headers = {}, body, timeoutMs, retryCount = 0 } = {}) {
  const attempts = clampNumber(retryCount, 0, 3, 0) + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await httpJsonOnce(url, { method, headers, body, timeoutMs });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableError(error)) {
        throw error;
      }
      await delay(250 * attempt);
    }
  }

  throw lastError;
}

function httpJsonOnce(url, { method, headers = {}, body, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "http:" ? httpRequest : httpsRequest;
    const timeout = clampNumber(timeoutMs, 1000, 120000, DEFAULT_REQUEST_TIMEOUT_MS);
    const request = transport(
      {
        method: method || "GET",
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        headers: {
          Accept: "application/json",
          ...headers
        }
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            reject(new Error(`接口返回非 JSON 内容：HTTP ${response.statusCode}`));
            return;
          }

          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(parsed);
            return;
          }

          const providerMessage = parsed.errors?.[0]?.detail || parsed.errors?.[0]?.title || parsed.error_description || parsed.error || text;
          const error = new Error(`Amadeus HTTP ${response.statusCode}: ${providerMessage}`);
          error.statusCode = response.statusCode;
          error.retryable = response.statusCode === 429 || response.statusCode >= 500;
          reject(error);
        });
      }
    );
    request.setTimeout(timeout, () => {
      const error = new Error(`Amadeus 请求超时（${timeout}ms）。`);
      error.retryable = true;
      request.destroy(error);
    });
    request.on("error", (error) => {
      if (error.retryable === undefined) {
        error.retryable = true;
      }
      reject(error);
    });
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function isRetryableError(error) {
  return Boolean(error?.retryable);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function offerMatchesStrategy(offer, strategyType) {
  const outboundSegments = offer.itineraries?.[0]?.segments || [];
  const returnSegments = offer.itineraries?.[1]?.segments || [];
  const hasTransfer = outboundSegments.length > 1 || returnSegments.length > 1;
  return strategyType === "transfer" ? hasTransfer : !hasTransfer;
}

function parseIsoDurationMinutes(value) {
  const match = String(value || "").match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/);
  if (!match) return 0;
  return (Number(match[1]) || 0) * 60 + (Number(match[2]) || 0);
}

function hasIncludedCheckedBag(offer) {
  return (offer.travelerPricings || []).some((pricing) =>
    (pricing.fareDetailsBySegment || []).some((segment) => Number(segment.includedCheckedBags?.quantity) > 0)
  );
}

function normalizeAirportCodes(value) {
  return (Array.isArray(value) ? value : [])
    .map((code) => String(code).trim().toUpperCase())
    .filter((code) => /^[A-Z]{3}$/.test(code));
}

function getCachedFlightOffers(cacheKey, cacheTtlMinutes) {
  if (!cacheTtlMinutes) return null;
  const cached = flightOfferCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    flightOfferCache.delete(cacheKey);
    return null;
  }
  return cached.offers;
}

function setCachedFlightOffers(cacheKey, offers, cacheTtlMinutes) {
  if (!cacheTtlMinutes) return;
  flightOfferCache.set(cacheKey, {
    offers,
    expiresAt: Date.now() + cacheTtlMinutes * 60 * 1000
  });
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}
