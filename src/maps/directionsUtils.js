import { toLatLngLiteral } from "./googleUtils";
export { toLatLngLiteral };

export function placeToLatLng(place) {
  return toLatLngLiteral(place?.location);
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

function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "";
  const mins = Math.round(totalSeconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function coerceDate(v) {
  if (!v) return null;
  try {
    if (v instanceof Date) return v;
    if (typeof v === "number") return new Date(v);
    if (typeof v === "string") return new Date(v);
    if (typeof v === "object" && "value" in v) return coerceDate(v.value);
    if (typeof v === "object" && "time" in v) return coerceDate(v.time);
  } catch {
    // ignore
  }
  return null;
}

function fmtTime(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "" + d;
  }
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

    const firstLeg = legs?.[0] ?? null;
    const lastLeg = legs?.[legs.length - 1] ?? null;

    const departTime = coerceDate(firstLeg?.departure_time) ?? null;
    const arriveTime = coerceDate(lastLeg?.arrival_time) ?? null;

    const departTimeText = firstLeg?.departure_time?.text ?? (departTime ? fmtTime(departTime) : "");
    const arriveTimeText = lastLeg?.arrival_time?.text ?? (arriveTime ? fmtTime(arriveTime) : "");
    const timeRangeText =
      departTimeText && arriveTimeText ? `${departTimeText}–${arriveTimeText}` : "";

    return {
      index,
      summary: r?.summary || `Route ${index + 1}`,
      distanceText,
      durationText,
      departTime,
      arriveTime,
      departTimeText,
      arriveTimeText,
      timeRangeText,
    };
  });
}
