(() => {
    function loadPlaneIcon(map) {
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


function bearingDegrees(lon1, lat1, lon2, lat2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}


  const statusEl = document.getElementById("status");
  const timeLabel = document.getElementById("timeLabel");
  const timeSlider = document.getElementById("timeSlider");
  const playBox = document.getElementById("play");
  const speedSel = document.getElementById("speed");
  const countEl = document.getElementById("count");

  if (!window.mapboxgl) {
    statusEl.textContent = "ERROR: Mapbox GL JS not loaded";
    return;
  }
  if (!window.MAPBOX_TOKEN || window.MAPBOX_TOKEN.includes("PASTE_")) {
    statusEl.textContent = "ERROR: Set window.MAPBOX_TOKEN in /public/config.js";
    return;
  }

  mapboxgl.accessToken = window.MAPBOX_TOKEN;

  const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/satellite-streets-v12",
    center: [-95, 56], // Canada-ish
    zoom: 3.2,
    pitch: 55,         // 3D feel
    bearing: -10,
    antialias: true
  });

  // ----- State -----
  let flights = [];
  let simStart = 0;
  let simEnd = 1;
  let simNow = 0;

  function formatUtc(sec) {
    return new Date(sec * 1000).toISOString().replace(".000Z", "Z");
  }
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

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
    const a = traj[lo], b = traj[hi];
    const span = b.t - a.t;
    const u = span === 0 ? 0 : (tSec - a.t) / span;

    return {
      t: tSec,
      lat: a.lat + (b.lat - a.lat) * u,
      lon: a.lon + (b.lon - a.lon) * u,
      altFt: a.altFt + (b.altFt - a.altFt) * u
    };
  }

  function buildRoutesGeoJSON() {
    return {
      type: "FeatureCollection",
      features: flights.map(f => ({
        type: "Feature",
        properties: { id: f.ACID, planeType: f.planeType || "" },
        geometry: {
          type: "LineString",
          coordinates: (f.trajectory || []).map(p => [p.lon, p.lat])
        }
      }))
    };
  }

  function buildPlanesGeoJSON(tSec) {
  return {
    type: "FeatureCollection",
    features: flights.map(f => {
      const traj = f.trajectory || [];
      const p = sampleTrajectory(traj, tSec) || traj[0];

      // find a "next" point 60s ahead for heading
      const p2 = sampleTrajectory(traj, tSec + 60) || traj[traj.length - 1];
      const heading = bearingDegrees(p.lon, p.lat, p2.lon, p2.lat);

      const active = tSec >= f.depTime && tSec <= f.arrTime;

      return {
        type: "Feature",
        properties: {
          id: f.ACID,
          active: active ? 1 : 0,
          heading
        },
        geometry: {
          type: "Point",
          coordinates: [p.lon, p.lat]
        }
      };
    })
  };
}


  function setSimTime(sec) {
    simNow = sec;
    const frac = clamp01((simNow - simStart) / (simEnd - simStart));
    timeSlider.value = String(frac);
    timeLabel.textContent = formatUtc(simNow);

    const planes = buildPlanesGeoJSON(simNow);
    const src = map.getSource("planes");
    if (src) src.setData(planes);
  }

  async function loadFlights() {
    statusEl.textContent = "loading flights.4d.json…";
    const res = await fetch("./flights_4d.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

    const json = await res.json();
    if (!Array.isArray(json)) throw new Error("flights.4d.json must be an array");

    flights = json;
    countEl.textContent = String(flights.length);

    simStart = Math.min(...flights.map(f => f.depTime).filter(Number.isFinite));
    simEnd   = Math.max(...flights.map(f => f.arrTime).filter(Number.isFinite));
    if (!Number.isFinite(simStart) || !Number.isFinite(simEnd) || simEnd <= simStart) {
      throw new Error("Bad depTime/arrTime in flights.4d.json");
    }

    statusEl.textContent = "ok";
    return flights;
  }

  map.on("load", async () => {
    try {
      await loadFlights();

      // Add sources
      map.addSource("routes", { type: "geojson", data: buildRoutesGeoJSON() });
      map.addSource("planes", { type: "geojson", data: buildPlanesGeoJSON(simStart) });

      // Route layer
      map.addLayer({
        id: "routes-line",
        type: "line",
        source: "routes",
        paint: {
        "line-color": "#007BFF",
          "line-width": 2,
          "line-opacity": 0.6
        }
      });
await loadPlaneIcon(map);
    map.addLayer({
  id: "planes-icon",
  type: "symbol",
  source: "planes",
  layout: {
    "icon-image": "plane-icon",
    "icon-size": 0.05,
    "icon-allow-overlap": true,
    "icon-ignore-placement": true,
    "icon-rotate": ["get", "heading"],
    "icon-rotation-alignment": "map"
  },
  paint: {
    "icon-opacity": [
      "case",
      ["==", ["get", "active"], 1], 1.0,
      0.25
    ]
  }
});

      setSimTime(simStart);

      // Slider
      timeSlider.addEventListener("input", (e) => {
        const frac = Number(e.target.value);
        setSimTime(simStart + frac * (simEnd - simStart));
      });

      // Animation loop
      let last = performance.now();
      function tick(now) {
        const dt = (now - last) / 1000;
        last = now;

        if (playBox.checked) {
          const speed = Number(speedSel.value);
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
