// src/maps/directionsUtils.js

export function toLatLngLiteral(ll) {
  if (!ll) return null;
  if (typeof ll.lat === "function") return { lat: ll.lat(), lng: ll.lng() };
  if (Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) return ll;
  return null;
}

export function extractViaPointsFromRoute(route) {
  const legs = route?.legs ?? [];
  const pts = [];

  for (const leg of legs) {
    const v = leg?.via_waypoints ?? [];
    for (const ll of v) {
      const p = toLatLngLiteral(ll);
      if (p) pts.push(p);
    }
  }

  // de-dupe
  const seen = new Set();
  const out = [];
  for (const p of pts) {
    const key = `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function disposeMarker(m) {
  if (!m) return;
  try {
    window.google.maps.event.clearInstanceListeners(m);
  } catch {
    // ignore
  }
  if (typeof m.setMap === "function") m.setMap(null);
}

function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "";
  const mins = Math.round(totalSeconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export function summarizeDirectionsRoutes(directions) {
  const routes = directions?.routes ?? [];
  return routes.map((r, index) => {
    const legs = r?.legs ?? [];
    const distMeters = legs.reduce((s, l) => s + (l?.distance?.value ?? 0), 0);
    const durSeconds = legs.reduce((s, l) => s + (l?.duration?.value ?? 0), 0);

    const durationText =
      legs.length === 1 ? legs?.[0]?.duration?.text ?? "" : formatDuration(durSeconds);

    // use API-provided text if single-leg; else estimate in miles
    let distanceText = legs?.[0]?.distance?.text ?? "";
    if (legs.length !== 1) {
      const mi = distMeters / 1609.344;
      distanceText = mi >= 10 ? `${mi.toFixed(0)} mi` : `${mi.toFixed(1)} mi`;
    }

    return {
      index,
      summary: r?.summary || `Route ${index + 1}`,
      distanceText,
      durationText,
    };
  });
}
