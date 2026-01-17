import fs from "fs/promises";

const KNOT_TO_MPS = 0.514444; // 1 knot = 0.514444 m/s

function parseCoordToken(token) {
  const m = token.trim().match(/^(-?\d+(?:\.\d+)?)([NSEW])$/i);
  if (!m) throw new Error("Bad coord token: " + token);
  let val = Number(m[1]);
  const hemi = m[2].toUpperCase();
  if (hemi === "S" || hemi === "W") val = -Math.abs(val);
  else val = Math.abs(val);
  return val;
}

function parseLatLonPair(pairStr) {
  const [latStr, lonStr] = pairStr.split("/");
  return { lat: parseCoordToken(latStr), lon: parseCoordToken(lonStr) };
}

function parseRoute(routeStr) {
  if (!routeStr || !routeStr.trim()) return [];
  return routeStr.trim().split(/\s+/).map(parseLatLonPair);
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function totalPathMeters(points) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += haversineMeters(points[i], points[i + 1]);
  }
  return total;
}

function positionAtFraction(points, frac) {
  frac = Math.max(0, Math.min(1, frac));
  if (points.length === 1) return { ...points[0] };
  if (points.length === 0) throw new Error("No points to interpolate");

  const segLens = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const L = haversineMeters(points[i], points[i + 1]);
    segLens.push(L);
    total += L;
  }
  if (total <= 0) return { ...points[0] };

  let target = frac * total;
  for (let i = 0; i < segLens.length; i++) {
    const L = segLens[i];
    if (target <= L) {
      const a = points[i], b = points[i + 1];
      const u = L === 0 ? 0 : target / L;
      return {
        lat: a.lat + (b.lat - a.lat) * u,
        lon: a.lon + (b.lon - a.lon) * u
      };
    }
    target -= L;
  }
  return { ...points[points.length - 1] };
}

// simple climb/cruise/descend profile
function altitudeAtFraction(cruiseAltFt, frac) {
  const climb = 0.15;
  const desc = 0.15;
  if (frac < climb) return cruiseAltFt * (frac / climb);
  if (frac > 1 - desc) return cruiseAltFt * ((1 - frac) / desc);
  return cruiseAltFt;
}

function buildTrajectory(points, depTimeSec, arrTimeSec, cruiseAltFt, stepSec = 60) {
  const out = [];
  const duration = arrTimeSec - depTimeSec;
  if (duration <= 0) return out;

  for (let t = depTimeSec; t <= arrTimeSec; t += stepSec) {
    const frac = (t - depTimeSec) / duration;
    const pos = positionAtFraction(points, frac);
    out.push({
      t,
      lat: pos.lat,
      lon: pos.lon,
      altFt: Math.round(altitudeAtFraction(cruiseAltFt, frac))
    });
  }
  // force exact final sample
  const last = positionAtFraction(points, 1);
  out.push({ t: arrTimeSec, lat: last.lat, lon: last.lon, altFt: 0 });
  return out;
}

async function main() {
  const flights = JSON.parse(await fs.readFile("./canadian_flights_250.json", "utf-8"));
  const airports = JSON.parse(await fs.readFile("./airport.json", "utf-8"));

  const enriched = flights.map((f) => {
    const depIcao = f["departure airport"];
    const arrIcao = f["arrival airport"];

    const dep = airports[depIcao];
    const arr = airports[arrIcao];
    if (!dep || !arr) throw new Error(`Missing airport in airports.json: ${depIcao} or ${arrIcao}`);

    const routePoints = parseRoute(f.route);

    // Build full path: DEP -> route -> ARR
    const waypoints = [
      { lat: dep.lat, lon: dep.lon },
      ...routePoints,
      { lat: arr.lat, lon: arr.lon }
    ];

    const distM = totalPathMeters(waypoints);

    const speedKts = Number(f["aircraft speed"]);
    const speedMps = speedKts * KNOT_TO_MPS;

    const durationSec = Math.round(distM / speedMps);
    const depTime = Number(f["departure time"]);
    const arrTime = depTime + durationSec;

    return {
      ACID: f.ACID,
      planeType: f["Plane type"],
      passengers: f.passengers,
      isCargo: Boolean(f.is_cargo),

      departure: { icao: depIcao, ...dep },
      arrival: { icao: arrIcao, ...arr },

      cruiseAltFt: Number(f.altitude),
      speedKts,

      depTime,
      arrTime,
      durationSec,
      distanceMeters: Math.round(distM),

      waypoints,
      trajectory: buildTrajectory(waypoints, depTime, arrTime, Number(f.altitude), 60)
    };
  });

  await fs.writeFile("./flights_4d.json", JSON.stringify(enriched, null, 2));
  console.log(`Wrote flights_4d.json (${enriched.length} flights)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
