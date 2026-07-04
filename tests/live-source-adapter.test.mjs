import assert from "assert";
import { createServer } from "http";
import {
  checkAmadeusHealth,
  collectAmadeusSnapshots,
  resetAmadeusFlightOfferCache,
  resetAmadeusTokenCache
} from "../scripts/amadeusFlightSource.mjs";

resetAmadeusTokenCache();
resetAmadeusFlightOfferCache();

const requests = {
  token: 0,
  offers: 0,
  offerQueries: [],
  authorizationHeaders: []
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (request.method === "POST" && url.pathname === "/v1/security/oauth2/token") {
    requests.token += 1;
    const body = await readBody(request);
    assert.ok(body.includes("grant_type=client_credentials"));
    assert.ok(body.includes("client_id=test-client"));
    sendJson(response, 200, {
      access_token: "local-test-token",
      expires_in: 3600
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v2/shopping/flight-offers") {
    requests.offers += 1;
    requests.authorizationHeaders.push(request.headers.authorization);
    requests.offerQueries.push(Object.fromEntries(url.searchParams.entries()));
    const nonStop = url.searchParams.get("nonStop") === "true";
    sendJson(response, 200, {
      data: [nonStop ? directOffer() : transferOffer()]
    });
    return;
  }

  sendJson(response, 404, {
    errors: [{ title: "Not Found" }]
  });
});

await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const env = {
  AMADEUS_CLIENT_ID: "test-client",
  AMADEUS_CLIENT_SECRET: "test-secret",
  AMADEUS_BASE_URL: baseUrl,
  AMADEUS_ENV: "test",
  AMADEUS_CACHE_TTL_MINUTES: "30",
  AMADEUS_REQUEST_TIMEOUT_MS: "5000",
  AMADEUS_RETRY_COUNT: "0"
};

try {
  const health = await checkAmadeusHealth(env);
  assert.equal(health.ok, true);
  assert.equal(health.baseUrl, baseUrl);
  assert.equal(requests.token, 1);

  resetAmadeusTokenCache();
  const task = {
    id: "task-live-adapter",
    name: "Live Adapter",
    originCity: "上海",
    originAirportCodes: ["PVG"],
    passengerCount: 1,
    budgetCurrency: "CNY",
    monitorDirect: true,
    monitorTransfer: true
  };
  const destination = {
    id: "osaka-kyoto",
    name: "大阪 / 京都",
    airportCodes: ["KIX"]
  };
  const dateOptions = [{ departDate: "2026-10-01", returnDate: "2026-10-07" }];

  const firstResult = await collectAmadeusSnapshots({
    task,
    destinations: [destination],
    dateOptions,
    maxOffersPerSearch: 3,
    maxQueriesPerRun: 10
  }, env);

  assert.equal(firstResult.provider, "amadeus");
  assert.equal(firstResult.estimatedSearches, 2);
  assert.equal(firstResult.executedSearches, 2);
  assert.equal(firstResult.cacheHits, 0);
  assert.equal(firstResult.snapshots.length, 2);
  assert.deepEqual(new Set(firstResult.snapshots.map((snapshot) => snapshot.strategyType)), new Set(["direct", "transfer"]));
  assert.ok(firstResult.snapshots.every((snapshot) => snapshot.sourceType === "live_api"));
  assert.ok(firstResult.snapshots.every((snapshot) => snapshot.sourceProvider === "amadeus"));
  assert.ok(firstResult.snapshots.every((snapshot) => snapshot.bookingUrl.startsWith("https://www.google.com/travel/flights")));
  assert.equal(firstResult.snapshots.find((snapshot) => snapshot.strategyType === "transfer").transferCities[0], "ICN");
  assert.ok(requests.authorizationHeaders.every((header) => header === "Bearer local-test-token"));
  assert.deepEqual(new Set(requests.offerQueries.map((query) => query.nonStop)), new Set(["true", "false"]));

  const offerRequestsAfterFirstRun = requests.offers;
  const secondResult = await collectAmadeusSnapshots({
    task,
    destinations: [destination],
    dateOptions,
    maxOffersPerSearch: 3,
    maxQueriesPerRun: 10
  }, env);

  assert.equal(secondResult.executedSearches, 0);
  assert.equal(secondResult.cacheHits, 2);
  assert.equal(secondResult.snapshots.length, 2);
  assert.equal(requests.offers, offerRequestsAfterFirstRun);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  resetAmadeusTokenCache();
  resetAmadeusFlightOfferCache();
}

console.log("live source adapter tests passed");

function directOffer() {
  return {
    id: "direct-1",
    itineraries: [
      {
        duration: "PT2H50M",
        segments: [
          {
            departure: { iataCode: "PVG" },
            arrival: { iataCode: "KIX" },
            carrierCode: "MU",
            number: "515",
            duration: "PT2H50M"
          }
        ]
      },
      {
        duration: "PT3H10M",
        segments: [
          {
            departure: { iataCode: "KIX" },
            arrival: { iataCode: "PVG" },
            carrierCode: "MU",
            number: "516",
            duration: "PT3H10M"
          }
        ]
      }
    ],
    price: { currency: "CNY", grandTotal: "1880.00" },
    travelerPricings: [{ fareDetailsBySegment: [{ includedCheckedBags: { quantity: 1 } }] }]
  };
}

function transferOffer() {
  return {
    id: "transfer-1",
    itineraries: [
      {
        duration: "PT5H20M",
        segments: [
          {
            departure: { iataCode: "PVG" },
            arrival: { iataCode: "ICN" },
            carrierCode: "OZ",
            number: "366",
            duration: "PT2H00M"
          },
          {
            departure: { iataCode: "ICN" },
            arrival: { iataCode: "KIX" },
            carrierCode: "OZ",
            number: "112",
            duration: "PT1H45M"
          }
        ]
      },
      {
        duration: "PT4H45M",
        segments: [
          {
            departure: { iataCode: "KIX" },
            arrival: { iataCode: "PVG" },
            carrierCode: "MU",
            number: "730",
            duration: "PT2H45M"
          }
        ]
      }
    ],
    price: { currency: "CNY", grandTotal: "1680.00" },
    travelerPricings: [{ fareDetailsBySegment: [{ includedCheckedBags: { quantity: 0 } }] }]
  };
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolveBody(body));
    request.on("error", rejectBody);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}
