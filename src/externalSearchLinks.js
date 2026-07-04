export function buildExternalSearchLinks({ snapshot, task, destination }) {
  const origin = snapshot?.originAirport || task?.originAirportCodes?.[0] || "";
  const destinationAirport = snapshot?.destinationAirport || destination?.airportCodes?.[0] || "";
  const departDate = snapshot?.departDate || task?.departDate || "";
  const returnDate = snapshot?.returnDate || task?.returnDate || "";
  const passengerCount = Number(task?.passengerCount) || 1;
  const destinationName = destination?.name || destinationAirport || "目的地";
  const links = [
    {
      id: "google-flights",
      label: "Google Flights",
      type: "meta-search",
      url: buildGoogleFlightsUrl({ origin, destinationAirport, departDate, returnDate, passengerCount })
    },
    {
      id: "ctrip",
      label: "携程机票",
      type: "ota",
      url: `https://flights.ctrip.com/online/list/oneway-${encodeURIComponent(origin)}-${encodeURIComponent(destinationAirport)}?depdate=${encodeURIComponent(departDate)}`
    },
    {
      id: "trip",
      label: "Trip.com",
      type: "ota",
      url: "https://www.trip.com/flights/"
    },
    {
      id: "airline",
      label: `${airlineLabel(snapshot?.airline)}官网`,
      type: "airline",
      url: airlineWebsite(snapshot?.airline)
    }
  ];

  return links
    .filter((link) => link.url)
    .map((link) => ({
      ...link,
      note: `${origin || "出发地"} -> ${destinationName}${departDate ? ` · ${departDate}` : ""}`
    }));
}

export function buildPrimaryBookingUrl({ snapshot, task, destination }) {
  return buildExternalSearchLinks({ snapshot, task, destination })[0]?.url || "";
}

function buildGoogleFlightsUrl({ origin, destinationAirport, departDate, returnDate, passengerCount }) {
  const query = [
    "Google Flights",
    origin,
    destinationAirport,
    departDate,
    returnDate,
    `${passengerCount} passenger`
  ]
    .filter(Boolean)
    .join(" ");
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}`;
}

function airlineWebsite(airline) {
  const code = String(airline || "").trim().toUpperCase();
  const sites = {
    "MU": "https://www.ceair.com/",
    "FM": "https://www.ceair.com/",
    "HO": "https://www.juneyaoair.com/",
    "9C": "https://www.ch.com/",
    "CA": "https://www.airchina.com.cn/",
    "CZ": "https://www.csair.com/",
    "MF": "https://www.xiamenair.com/",
    "NH": "https://www.ana.co.jp/",
    "JL": "https://www.jal.co.jp/",
    "KE": "https://www.koreanair.com/",
    "OZ": "https://flyasiana.com/",
    "SQ": "https://www.singaporeair.com/",
    "TG": "https://www.thaiairways.com/",
    "VN": "https://www.vietnamairlines.com/",
    "CX": "https://www.cathaypacific.com/",
    "BR": "https://www.evaair.com/"
  };
  return sites[code] || "https://www.google.com/search?q=" + encodeURIComponent(`${airline || ""} airline official website`);
}

function airlineLabel(airline) {
  return String(airline || "航司").trim() || "航司";
}
