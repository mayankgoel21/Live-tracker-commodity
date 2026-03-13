// netlify/functions/fetch-prices.mjs
// Runs on cron: 1st and 15th of every month at 06:00 UTC
// Fetches LME benchmark prices from IMF PCPS API (free, no key)
// Stores result in Netlify Blobs so the frontend can read it instantly

import { getStore } from "@netlify/blobs";

const IMF_BASE = "https://dataservices.imf.org/REST/SDMX_JSON.svc/CompactData/PCPS/M.W00";

// IMF PCPS indicator codes → commodity IDs
const IMF_INDICATORS = {
  PCOPP: "copper",
  PALUM: "aluminium",
  PNICK: "nickel",
  PTIN:  "tin",
  PZINC: "zinc",
};

// Verified seed data (Feb'24→Mar'26, 26 monthly values)
// Used as fallback if IMF fetch fails for a commodity
const SEED = {
  copper:     [8800,9500,10100,10200,9800,9100,9200,9150,9200,9300,9400,9100,8800,9200,9300,8900,9000,9400,9500,9600,9600,9800,10200,11000,10200,9800],
  aluminium:  [2350,2400,2450,2460,2420,2380,2380,2390,2390,2420,2450,2500,2550,2560,2520,2350,2400,2600,2680,2700,2750,2800,2850,2900,2950,2850],
  nickel:     [16800,16500,16200,16000,15800,15500,15400,15200,15000,14800,14900,15000,15100,15000,14900,14800,15000,15100,15200,15300,15100,15080,15100,19000,17173,17343],
  tin:        [29500,30000,31000,32745,31000,30000,30500,31000,31500,32000,32500,33000,33500,34000,34500,35000,36000,37000,38000,39000,40000,42000,52000,47000,44000,41000],
  zinc:       [2700,2720,2750,2780,2700,2650,2700,2750,2780,2800,2750,2800,2850,2900,2900,2850,3000,3100,3150,3200,3250,3300,3350,3400,3300,3250],
  steel:      [580,570,560,550,540,520,510,505,500,490,490,485,480,470,460,450,455,460,465,470,475,480,480,485,490,485],
  stainless:  [2200,2180,2150,2120,2100,2080,2060,2050,2040,2020,2010,2000,1980,1970,1960,1950,1960,1970,1980,2000,2010,2020,2030,2040,2050,2050],
  copper_wire:[10560,11400,12120,12240,11760,10920,11040,10980,11040,11160,11280,10920,10560,11040,11160,10680,10800,11280,11400,11520,11520,11760,12240,13200,12240,11760],
  ndpr:       [62,60,58,57,56,55,54,55,56,57,56,57,58,59,60,60,62,63,64,65,66,68,67,65,63,62],
  lithium:    [13,12,11,10,10,9,9,9,9,9,10,10,10,10,10,10,10,10,10,11,11,11,11,11,11,11],
  cobalt:     [27,26,25,25,24,24,23,23,23,23,24,24,24,24,24,23,23,24,24,25,25,25,24,24,24,24],
  abs:        [1580,1600,1620,1640,1620,1600,1580,1570,1560,1570,1580,1600,1610,1620,1630,1600,1600,1620,1640,1650,1650,1660,1660,1650,1640,1640],
  pvc:        [870,860,850,840,830,820,810,800,790,780,780,780,780,780,790,780,790,800,810,820,820,830,830,825,820,820],
  pp:         [1060,1070,1080,1090,1080,1070,1060,1060,1070,1080,1080,1070,1070,1080,1090,1080,1080,1090,1100,1110,1110,1110,1110,1100,1100,1100],
  hips:       [1300,1310,1320,1330,1320,1310,1305,1300,1300,1305,1310,1315,1320,1330,1340,1330,1330,1340,1350,1360,1360,1360,1360,1355,1350,1350],
  pur_foam:   [1950,1960,1970,1980,1990,1990,1990,2000,2000,2010,2010,2020,2030,2040,2050,2050,2060,2080,2100,2110,2120,2130,2150,2160,2150,2150],
};

async function fetchIMFSeries(indicator) {
  const now = new Date();
  const startYear = now.getFullYear() - 2;
  const start = `${startYear}-02`;
  const end = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const url = `${IMF_BASE}.${indicator}.USD?startPeriod=${start}&endPeriod=${end}&format=json`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`IMF HTTP ${res.status}`);
  const json = await res.json();

  const series = json?.CompactData?.DataSet?.Series;
  if (!series) throw new Error("No series in response");

  const obs = Array.isArray(series.Obs) ? series.Obs : [series.Obs];
  const sorted = obs
    .filter((o) => o?.["@OBS_VALUE"])
    .sort((a, b) => a["@TIME_PERIOD"].localeCompare(b["@TIME_PERIOD"]));

  return sorted.map((o) => Math.round(parseFloat(o["@OBS_VALUE"])));
}

export default async function handler() {
  console.log("[fetch-prices] Starting scheduled price fetch…");

  const store = getStore("commodity-prices");
  const prices = {};
  const fetchLog = {};

  // Fetch all IMF indicators in parallel
  const fetchResults = await Promise.allSettled(
    Object.entries(IMF_INDICATORS).map(async ([indicator, id]) => {
      const values = await fetchIMFSeries(indicator);
      return { id, values };
    })
  );

  for (const result of fetchResults) {
    if (result.status === "fulfilled") {
      const { id, values } = result.value;
      const seed = SEED[id];
      // Pad with seed at start if API returns fewer than 26 months
      const history = values.length >= 26
        ? values.slice(-26)
        : [...seed.slice(0, 26 - values.length), ...values];
      prices[id] = {
        current: history[history.length - 1],
        history,
        source: "live",
      };
      fetchLog[id] = `✓ live (${values.length} months from IMF)`;
    } else {
      // Fallback to seed
      const id = Object.values(IMF_INDICATORS)[fetchResults.indexOf(result)];
      prices[id] = {
        current: SEED[id][SEED[id].length - 1],
        history: SEED[id],
        source: "seed",
      };
      fetchLog[id] = `✗ failed, using seed — ${result.reason?.message}`;
    }
  }

  // Derive copper_wire from live copper (copper × 1.20)
  if (prices.copper?.source === "live") {
    const hist = prices.copper.history.map((v) => Math.round(v * 1.2));
    prices.copper_wire = { current: hist[hist.length - 1], history: hist, source: "live" };
    fetchLog.copper_wire = "✓ derived from live copper × 1.20";
  } else {
    prices.copper_wire = { current: SEED.copper_wire[SEED.copper_wire.length - 1], history: SEED.copper_wire, source: "seed" };
  }

  // Derive stainless 304 from live nickel
  if (prices.nickel?.source === "live") {
    const hist = prices.nickel.history.map((v) => Math.round(v * 0.075 + 1250));
    prices.stainless = { current: hist[hist.length - 1], history: hist, source: "live" };
    fetchLog.stainless = "✓ derived from live nickel";
  } else {
    prices.stainless = { current: SEED.stainless[SEED.stainless.length - 1], history: SEED.stainless, source: "seed" };
  }

  // Seed-only commodities
  for (const id of ["steel", "ndpr", "lithium", "cobalt", "abs", "pvc", "pp", "hips", "pur_foam"]) {
    prices[id] = { current: SEED[id][SEED[id].length - 1], history: SEED[id], source: "seed" };
    fetchLog[id] = "— seed data";
  }

  const payload = {
    prices,
    fetchedAt: new Date().toISOString(),
    nextFetch: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    log: fetchLog,
  };

  await store.setJSON("latest", payload);
  console.log("[fetch-prices] Stored prices:", fetchLog);

  return new Response(JSON.stringify({ ok: true, log: fetchLog }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export const config = {
  schedule: "0 6 1,15 * *",
};
