(() => {
  // ---------------- DOM ----------------
  const statusEl = document.getElementById("status");
  const timeLabel = document.getElementById("timeLabel");
  const timeSlider = document.getElementById("timeSlider");
  const playBox = document.getElementById("play");
  const speedSel = document.getElementById("speed");
  const countEl = document.getElementById("count");

  const conflictsCountEl = document.getElementById("conflictsCount");
  const scanBtn = document.getElementById("scanBtn");
  const scanStepSel = document.getElementById("scanStep");
  const scanResultEl = document.getElementById("scanResult");
  const closestResultEl = document.getElementById("closestResult");

  if (!window.mapboxgl) {
    statusEl.textContent = "ERROR: Mapbox GL JS not loaded";
    return;
  }
  if (!window.MAPBOX_TOKEN || window.MAPBOX_TOKEN.includes("PASTE_")) {
    statusEl.textContent = "ERROR: Set window.MAPBOX_TOKEN in /public/config.js";
    return;
  }

  mapboxgl.accessToken = window.MAPBOX_TOKEN;

  // ---------------- Map init ----------------
  const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/satellite-streets-v12",
    center: [-95, 56], // Canada-ish
    zoom: 3.2,
    pitch: 55,
    bearing: -10,
    antialias: true
  });

  // ---------------- Constants / helpers ----------------
  const NM_TO_METERS = 1852;

  function formatUtc(sec) {
    return new Date(sec * 1000).toISOString().replace(".000Z", "Z");
  }
  function clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }

  // Great-circle distance (Haversine) in meters
  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function bearingDegrees(lon1, lat1, lon2, lat2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;

    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x =
      Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));

    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  // Linear sample between trajectory points (expects traj sorted by t)
  function sampleTrajectory(traj, tSec) {
    if (!traj || traj.length === 0) return null;
    if (tSec <= traj[0].t) return traj[0];
    if (tSec >= traj[traj.length - 1].t) return traj[traj.length - 1];

    let lo = 0, hi = traj.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (traj[mid].t <= tSec) lo = mid;
      else hi = mid;
    }

    const a = traj[lo];
    const b = traj[hi];
    const span = b.t - a.t;
    const u = span === 0 ? 0 : (tSec - a.t) / span;

    return {
      t: tSec,
      lat: a.lat + (b.lat - a.lat) * u,
      lon: a.lon + (b.lon - a.lon) * u,
      altFt: (a.altFt ?? 0) + ((b.altFt ?? 0) - (a.altFt ?? 0)) * u
    };
  }

  // Loss-of-separation detection: horiz < 5 NM AND vert < 2000 ft
  function detectLossOfSeparation(planesAtT, horizNm = 5, vertFt = 2000) {
    const conflictIds = new Set();

    for (let i = 0; i < planesAtT.length; i++) {
      for (let j = i + 1; j < planesAtT.length; j++) {
        const A = planesAtT[i];
        const B = planesAtT[j];

        const horizontalMeters = haversineMeters(A.lat, A.lon, B.lat, B.lon);
        const horizontalNm = horizontalMeters / NM_TO_METERS;

        const verticalFt = Math.abs((A.altFt ?? 0) - (B.altFt ?? 0));

        if (horizontalNm < horizNm && verticalFt < vertFt) {
          conflictIds.add(A.id);
          conflictIds.add(B.id);
        }
      }
    }

    return conflictIds;
  }

  function closestApproachAtT(planesAtT) {
    let best = { a: null, b: null, horizNm: Infinity, vertFt: Infinity };

    for (let i = 0; i < planesAtT.length; i++) {
      for (let j = i + 1; j < planesAtT.length; j++) {
        const A = planesAtT[i], B = planesAtT[j];
        const horizNm = haversineMeters(A.lat, A.lon, B.lat, B.lon) / NM_TO_METERS;
        const vertFt = Math.abs((A.altFt ?? 0) - (B.altFt ?? 0));

        if (horizNm < best.horizNm || (horizNm === best.horizNm && vertFt < best.vertFt)) {
          best = { a: A.id, b: B.id, horizNm, vertFt };
        }
      }
    }
    return best;
  }

  function loadPlaneIcon(map) {
    // Put your icon at: /public/plane.png
    return new Promise((resolve, reject) => {
      map.loadImage("/public/plane.png", (err, image) => {
        if (err) return reject(err);
        if (!map.hasImage("plane-icon")) {
          map.addImage("plane-icon", image);
        }
        resolve();
      });
    });
  }

  // ---------------- State ----------------
  let flights = [];         // normalized flights
  let simStart = 0;
  let simEnd = 1;
  let simNow = 0;

  let lastConflictCount = 0;

  // ---------------- Normalize input ----------------
  function normalizeFlight(r) {
    const ACID = r.ACID ?? r.id ?? r.callsign ?? "";
    const planeType = r["Plane type"] ?? r.planeType ?? r.type ?? "";
    const from = r["departure airport"] ?? r.departureAirport ?? r.from ?? "";
    const to = r["arrival airport"] ?? r.arrivalAirport ?? r.to ?? "";

    const depTime = Number(r.depTime ?? r["departure time"] ?? r.departure_time ?? r.departureTime);
    const arrTime = Number(r.arrTime ?? r["arrival time"] ?? r.arrival_time ?? r.arrivalTime);

    const aircraftSpeed = Number(r["aircraft speed"] ?? r.aircraftSpeed ?? r.speed ?? 0);
    const passengers = Number(r.passengers ?? 0);
    const isCargo = Boolean(r.is_cargo ?? r.isCargo ?? false);

    const trajectory = r.trajectory;

    return {
      ACID,
      planeType,
      from,
      to,
      depTime,
      arrTime,
      aircraftSpeed,
      passengers,
      isCargo,
      trajectory
    };
  }

  // ---------------- GeoJSON builders ----------------
  function buildRoutesGeoJSON() {
    return {
      type: "FeatureCollection",
      features: flights.map(f => ({
        type: "Feature",
        properties: {
          id: f.ACID,
          planeType: f.planeType
        },
        geometry: {
          type: "LineString",
          coordinates: (f.trajectory || []).map(p => [p.lon, p.lat])
        }
      }))
    };
  }

  function buildPlanesGeoJSON(tSec) {
    // Sample active flights at time t
    const sampled = [];
    for (const f of flights) {
      const active = tSec >= f.depTime && tSec <= f.arrTime;
      if (!active) continue;

      const traj = f.trajectory || [];
      const p = sampleTrajectory(traj, tSec) || traj[0];
      if (!p) continue;

      const p2 = sampleTrajectory(traj, tSec + 60) || traj[traj.length - 1] || p;
      const heading = bearingDegrees(p.lon, p.lat, p2.lon, p2.lat);

      sampled.push({
        id: f.ACID,
        lat: p.lat,
        lon: p.lon,
        altFt: p.altFt ?? 0,
        heading,
        speedKts: f.aircraftSpeed,
        from: f.from,
        to: f.to,
        planeType: f.planeType,
        pax: f.passengers,
        isCargo: f.isCargo ? 1 : 0
      });
    }

    // Detect conflicts among active flights
    const conflictIds = detectLossOfSeparation(sampled, 5, 2000);
    lastConflictCount = conflictIds.size;

    return {
      type: "FeatureCollection",
      features: sampled.map(p => ({
        type: "Feature",
        properties: {
          id: p.id,
          active: 1,
          heading: p.heading,
          conflict: conflictIds.has(p.id) ? 1 : 0,

          altFt: Math.round(p.altFt),
          speedKts: Math.round(p.speedKts),
          from: p.from,
          to: p.to,
          planeType: p.planeType,
          pax: p.pax,
          isCargo: p.isCargo
        },
        geometry: {
          type: "Point",
          coordinates: [p.lon, p.lat]
        }
      }))
    };
  }

  // ---------------- Render updates ----------------
  function setSimTime(sec) {
    simNow = sec;

    const frac = clamp01((simNow - simStart) / (simEnd - simStart));
    timeSlider.value = String(frac);
    timeLabel.textContent = formatUtc(simNow);

    const planes = buildPlanesGeoJSON(simNow);
    const src = map.getSource("planes");
    if (src) src.setData(planes);

    if (conflictsCountEl) conflictsCountEl.textContent = String(lastConflictCount);
  }

  // ---------------- Load flights ----------------
  async function loadFlights() {
    statusEl.textContent = "loading flights_4d.json…";

    // ✅ If your file is flights.4d.json, change this to "./flights.4d.json"
    const res = await fetch("./flights_4d.json", { cache: "no-store" });

    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

    const raw = await res.json();
    if (!Array.isArray(raw)) throw new Error("flights file must be a JSON array: [ {...}, {...} ]");

    flights = raw.map(normalizeFlight);

    // Validate trajectories
    for (const f of flights) {
      if (!Array.isArray(f.trajectory) || f.trajectory.length < 2) {
        throw new Error(`Flight ${f.ACID} missing valid trajectory[] (needs at least 2 points)`);
      }
      if (!Number.isFinite(f.depTime) || !Number.isFinite(f.arrTime)) {
        throw new Error(`Flight ${f.ACID} missing depTime/arrTime (or departure/arrival time fields)`);
      }
    }

    countEl.textContent = String(flights.length);

    simStart = Math.min(...flights.map(f => f.depTime));
    simEnd = Math.max(...flights.map(f => f.arrTime));
    if (!Number.isFinite(simStart) || !Number.isFinite(simEnd) || simEnd <= simStart) {
      throw new Error("Bad simulation time range (check depTime/arrTime)");
    }

    statusEl.textContent = "ok";
  }

  // ---------------- Safety scan ----------------
  async function runSafetyScan(stepSec = 10) {
    if (!flights.length) return;

    scanBtn.disabled = true;
    scanResultEl.textContent = "scanning…";
    closestResultEl.textContent = "scanning…";

    let firstConflict = null; // {t, ids:[...]}
    let globalClosest = { a: null, b: null, horizNm: Infinity, vertFt: Infinity, t: null };

    for (let t = simStart; t <= simEnd; t += stepSec) {
      const planesAtT = [];
      for (const f of flights) {
        if (!(t >= f.depTime && t <= f.arrTime)) continue;

        const traj = f.trajectory || [];
        const p = sampleTrajectory(traj, t) || traj[0];
        if (!p) continue;

        planesAtT.push({
          id: f.ACID,
          lat: p.lat,
          lon: p.lon,
          altFt: p.altFt ?? 0
        });
      }

      if (planesAtT.length < 2) continue;

      const conflictIds = detectLossOfSeparation(planesAtT, 5, 2000);
      if (conflictIds.size > 0 && !firstConflict) {
        firstConflict = { t, ids: [...conflictIds] };
        // keep scanning to still report closest approach
      }

      const ca = closestApproachAtT(planesAtT);
      if (ca.a && (ca.horizNm < globalClosest.horizNm ||
          (ca.horizNm === globalClosest.horizNm && ca.vertFt < globalClosest.vertFt))) {
        globalClosest = { ...ca, t };
      }
    }

    if (!firstConflict) {
      scanResultEl.textContent = `✅ No conflicts (step=${stepSec}s)`;
    } else {
      scanResultEl.textContent =
        `⚠️ Conflict (step=${stepSec}s) @ ${formatUtc(firstConflict.t)}: ` +
        `${firstConflict.ids.slice(0, 4).join(", ")}${firstConflict.ids.length > 4 ? "…" : ""}`;
    }

    if (globalClosest.a) {
      closestResultEl.textContent =
        `${globalClosest.a} ↔ ${globalClosest.b} @ ${formatUtc(globalClosest.t)} | ` +
        `H=${globalClosest.horizNm.toFixed(2)} NM, V=${Math.round(globalClosest.vertFt)} ft`;
    } else {
      closestResultEl.textContent = "—";
    }

    scanBtn.disabled = false;
  }

  // ---------------- Main ----------------
  map.on("load", async () => {
    try {
      await loadFlights();

      // Sources
      map.addSource("routes", { type: "geojson", data: buildRoutesGeoJSON() });
      map.addSource("planes", { type: "geojson", data: buildPlanesGeoJSON(simStart) });

      // Routes (blue)
      map.addLayer({
        id: "routes-line",
        type: "line",
        source: "routes",
        paint: {
          "line-color": "#007BFF",
          "line-width": 3,
          "line-opacity": 0.85
        }
      });

      // Conflict halo (red behind plane icons)
      map.addLayer({
        id: "conflict-halo",
        type: "circle",
        source: "planes",
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            3, 8,
            8, 14
          ],
          "circle-color": "#FF3333",
          "circle-opacity": [
            "case",
            ["==", ["get", "conflict"], 1], 0.55,
            0
          ]
        }
      });

      // Load plane icon (PNG)
      await loadPlaneIcon(map);

      // Planes as icons
      map.addLayer({
        id: "planes-icon",
        type: "symbol",
        source: "planes",
        layout: {
          "icon-image": "plane-icon",
          "icon-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            3, 0.06,
            6, 0.08,
            10, 0.10
          ],
          "icon-anchor": "center",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-rotate": ["get", "heading"],
          "icon-rotation-alignment": "map"
        },
        paint: {
          "icon-opacity": 1.0
        }
      });

      // Hover popup
      const popup = new mapboxgl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 18
      });

      map.on("mouseenter", "planes-icon", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "planes-icon", () => {
        map.getCanvas().style.cursor = "";
        popup.remove();
      });

      map.on("mousemove", "planes-icon", (e) => {
        const feat = e.features && e.features[0];
        if (!feat) return;

        const p = feat.properties;

        const html = `
          <div style="font-family: system-ui; font-size: 12px; line-height: 1.25;">
            <div style="font-weight:700; margin-bottom:6px;">
              ${p.id} ${Number(p.conflict) === 1 ? "⚠️" : ""}
            </div>
            <div><b>From:</b> ${p.from} → <b>To:</b> ${p.to}</div>
            <div><b>Type:</b> ${p.planeType}</div>
            <div><b>Alt:</b> ${p.altFt} ft</div>
            <div><b>Speed:</b> ${p.speedKts} kts</div>
            <div><b>PAX:</b> ${p.pax} ${Number(p.isCargo) === 1 ? "(cargo)" : ""}</div>
            <div style="opacity:0.8; margin-top:6px;"><b>t:</b> ${timeLabel.textContent}</div>
          </div>
        `;

        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
      });

      // Set initial time
      setSimTime(simStart);

      // Slider control
      timeSlider.addEventListener("input", (e) => {
        const frac = Number(e.target.value);
        setSimTime(simStart + frac * (simEnd - simStart));
      });

      // Scan button
      scanBtn.addEventListener("click", () => {
        const step = Number(scanStepSel.value || 10);
        runSafetyScan(step);
      });

      // Animation loop
      let last = performance.now();
      function tick(now) {
        const dt = (now - last) / 1000;
        last = now;

        if (playBox.checked) {
          const speed = Number(speedSel.value || 5);
          setSimTime(simNow + dt * speed);
          if (simNow > simEnd) setSimTime(simStart);
        }

        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);

    } catch (err) {
      console.error(err);
      statusEl.textContent = "ERROR: " + err.message;
    }
  });
})();
