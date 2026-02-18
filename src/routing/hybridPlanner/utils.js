// src/routing/hybridPlanner.js
// Build hybrid itineraries (Transit + Bike/Skate) by:
// 1) requesting TRANSIT alternatives
// 2) replacing each WALKING step with the best micro-mobility route
// 3) inserting explicit WAIT segments using transit step schedule times
// 4) optionally adding direct (no-transit) options

import { ROUTE_COMBO } from "../routeCombos";


const GOOGLE_BLUE = "#1A73E8";
// Non-selected routes: lighter Google-ish blue
const ALT_GRAY = "#4285F4";

function getTransitDetailsFromStep(step) {
  return step?.transitDetails ?? step?.transit ?? step?.transit_details ?? null;
}

// Reference speeds (used only for skate time; bike/walk keep Google durations)
const WALK_MPH = 3;
const BIKE_MPH_ASSUMED = 10;
const SKATE_MPH_FLAT = 6;
const SKATE_MPH_DOWNHILL_CAP = 10;
const SKATE_UPHILL_COLLAPSE_DEG = 8;

const MPH_TO_MPS = 1609.344 / 3600;
const WALK_MPS = WALK_MPH * MPH_TO_MPS;
const SKATE_MPS_FLAT = SKATE_MPH_FLAT * MPH_TO_MPS;
const SKATE_MPS_CAP = SKATE_MPH_DOWNHILL_CAP * MPH_TO_MPS;

function fmtDurationSec(sec) {
  const s = Math.max(0, Math.round(sec ?? 0));
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  // If the duration is an exact hour, avoid a noisy "0 min" suffix.
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

function fmtTime(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "" + d;
  }
}

function fmtDistanceMeters(m) {
  if (!Number.isFinite(m)) return "";
  const miles = m / 1609.344;
  if (miles < 0.1) return `${Math.round(m)} m`;
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

function coerceDate(v) {
  if (!v) return null;
  try {
    if (v instanceof Date) return v;
    if (typeof v === "number") return new Date(v);
    if (typeof v === "string") return new Date(v);
    if (typeof v === "object" && "value" in v) return coerceDate(v.value);
  } catch {
    // ignore
  }
  return null;
}

function getLegDeparture(route, fallback) {
  const v = route?.legs?.[0]?.departure_time;
  return coerceDate(v) ?? fallback ?? null;
}

function getLegArrival(route, fallback) {
  const legs = route?.legs ?? [];
  const v = legs[legs.length - 1]?.arrival_time;
  return coerceDate(v) ?? fallback ?? null;
}

async function routeOnce(ds, req, opts = {}) {
  // Use callback-style with an explicit timeout.
  // This avoids rare hangs in the Promise wrapper and guarantees hybrid planning won't block indefinitely.
  const timeoutMs = Number.isFinite(opts?.timeoutMs) ? opts.timeoutMs : 15000;
  const label = opts?.label ? String(opts.label) : "";

  return await new Promise((resolve, reject) => {
    let settled = false;

    const t = setTimeout(() => {
      const msg = "DirectionsService.route timed out" + (label ? " (" + label + ")" : "") + " after " + timeoutMs + "ms";
      try { console.warn(msg, req); } catch (err) { void err; }
      if (settled) return;
      settled = true;
      reject(new Error(msg));
    }, timeoutMs);

    const done = (err, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      if (err) reject(err);
      else resolve(res);
    };

    try {
      ds.route(req, (result, status) => {
        const ok = status === "OK" || status === (window?.google?.maps?.DirectionsStatus?.OK ?? "OK");
        if (ok) return done(null, result);
        const msg = "DirectionsService.route failed" + (label ? " (" + label + ")" : "") + ": " + status;
        try { console.warn(msg, req); } catch (err) { void err; }
        return done(new Error(msg));
      });
    } catch (e) {
      done(e);
    }
  });
}

function latLngKey(ll) {
  try {
    const lat = typeof ll?.lat === "function" ? ll.lat() : ll?.lat;
    const lng = typeof ll?.lng === "function" ? ll.lng() : ll?.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
    return `${lat.toFixed(5)},${lng.toFixed(5)}`;
  } catch {
    return "";
  }
}

function locationKey(loc) {
  // Stable-ish key for caching DirectionsService legs.
  // Accepts strings (addresses), LatLng / LatLngLiteral, and Place-like objects.
  try {
    if (!loc) return "";
    if (typeof loc === "string") return `str:${loc}`;

    // PlaceId-like
    const placeId = loc?.placeId ?? loc?.place_id ?? null;
    if (placeId) return `place:${placeId}`;

    // LatLng / LatLngLiteral
    const llk = latLngKey(loc);
    if (llk) return `ll:${llk}`;

    // Fallback: try to serialize a tiny subset
    const name = loc?.name ? String(loc.name) : "";
    if (name) return `obj:${name}`;
    return "obj:" + JSON.stringify(loc).slice(0, 80);
  } catch {
    return "";
  }
}

async function microPairRoutes({ ds, origin, destination, cache }) {
  // Cache the pair of WALKING + BICYCLING routes for a given start/end.
  const key = `${locationKey(origin)}->${locationKey(destination)}`;
  if (key && cache?.has(key)) return cache.get(key);

  const pair = {
    walkRes: null,
    walkRoute: null,
    walkTot: { dist: 0, dur: Infinity },
    bikeRes: null,
    bikeRoute: null,
    bikeTot: { dist: 0, dur: Infinity },
  };

  const [walkRes, bikeRes] = await Promise.all([
    routeOnce(ds, { origin, destination, travelMode: "WALKING", provideRouteAlternatives: false }).catch(() => null),
    routeOnce(ds, { origin, destination, travelMode: "BICYCLING", provideRouteAlternatives: false }).catch(() => null),
  ]);

  pair.walkRes = walkRes;
  pair.bikeRes = bikeRes;

  pair.walkRoute = walkRes?.routes?.[0] ?? null;
  pair.bikeRoute = bikeRes?.routes?.[0] ?? null;
  if (pair.walkRoute) pair.walkTot = routeTotals(pair.walkRoute);
  if (pair.bikeRoute) pair.bikeTot = routeTotals(pair.bikeRoute);

  if (key && cache) cache.set(key, pair);
  return pair;
}

function microSegmentForCombo({ combo, pair }) {
  const w = pair?.walkTot ?? { dist: 0, dur: Infinity };
  const b = pair?.bikeTot ?? { dist: 0, dur: Infinity };
  const wRoute = pair?.walkRoute ?? null;
  const bRoute = pair?.bikeRoute ?? null;
  const wRes = pair?.walkRes ?? null;
  const bRes = pair?.bikeRes ?? null;

  if (combo === ROUTE_COMBO.TRANSIT_BIKE) {
    const useBike = b.dur <= w.dur;
    const chosen = useBike ? bRoute : wRoute;
    const chosenRes = useBike ? bRes : wRes;
    const chosenDur = useBike ? b.dur : w.dur;
    const chosenDist = useBike ? b.dist : w.dist;
    return {
      mode: useBike ? "BIKE" : "WALK",
      seconds: chosenDur,
      distanceMeters: chosenDist,
      route: chosen,
      directionsResult: chosenRes,
    };
  }

  // TRANSIT_SKATE
  const wSkate = skateSecondsFromWalkSeconds(w.dur);
  const bSkate = skateSecondsFromGoogleBikeSeconds(b.dur);
  const useBike = bSkate <= wSkate;
  const chosen = useBike ? bRoute : wRoute;
  const chosenRes = useBike ? bRes : wRes;
  const chosenSec = useBike ? bSkate : wSkate;
  const chosenDist = useBike ? b.dist : w.dist;

  return {
    mode: "SKATE",
    seconds: chosenSec,
    distanceMeters: chosenDist,
    route: chosen,
    directionsResult: chosenRes,
    skateGeometryMode: useBike ? "BICYCLING" : "WALKING",
  };
}

function firstTransitStep(route) {
  const steps = route?.legs?.[0]?.steps ?? [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]?.travel_mode === "TRANSIT") return { step: steps[i], index: i, steps };
  }
  return { step: null, index: -1, steps };
}

function walkAccessSecondsToFirstTransit(route) {
  const { index, steps } = firstTransitStep(route);
  if (index <= 0) return 0;
  let sec = 0;
  for (let i = 0; i < index; i++) {
    const st = steps[i];
    // Usually WALKING, but be tolerant.
    sec += st?.duration?.value ?? 0;
  }
  return sec;
}

function routeSignature(route) {
  const steps = route?.legs?.[0]?.steps ?? [];
  const parts = [];
  for (const st of steps) {
    if (st?.travel_mode !== "TRANSIT") continue;
    const td = getTransitDetailsFromStep(st);
    const line = td?.line;
    const lineName = line?.short_name || line?.name || "";
    const depStop = td?.departure_stop?.name || "";
    const depMs = coerceDate(td?.departure_time)?.getTime?.() ?? "";
    parts.push(`${lineName}|${depStop}|${depMs}`);
  }
  return parts.join(">") || (route?.summary ?? "");
}

async function microAccessSecondsToStop({ ds, origin, stopLoc, combo, cache }) {
  const key = `${combo}:${latLngKey(stopLoc)}`;
  if (key && cache?.has(key)) return cache.get(key);

  // Prefer bicycling geometry for both TRANSIT_BIKE and TRANSIT_SKATE (skate derives time from bike).
  let bikeSec = Infinity;
  try {
    const bikeRes = await routeOnce(ds, {
      origin,
      destination: stopLoc,
      travelMode: "BICYCLING",
      provideRouteAlternatives: false,
    });
    const r = bikeRes?.routes?.[0];
    const tot = r ? routeTotals(r) : { dur: Infinity };
    bikeSec = tot.dur;
  } catch {
    // ignore
  }

  // If biking fails, fall back to walking.
  let walkSec = Infinity;
  if (!Number.isFinite(bikeSec) || bikeSec === Infinity) {
    try {
      const walkRes = await routeOnce(ds, {
        origin,
        destination: stopLoc,
        travelMode: "WALKING",
        provideRouteAlternatives: false,
      });
      const r = walkRes?.routes?.[0];
      const tot = r ? routeTotals(r) : { dur: Infinity };
      walkSec = tot.dur;
    } catch {
      // ignore
    }
  }

  let sec = bikeSec;
  if (!Number.isFinite(sec) || sec === Infinity) sec = walkSec;
  if (combo === ROUTE_COMBO.TRANSIT_SKATE) sec = skateSecondsFromGoogleBikeSeconds(sec);

  if (key && cache) cache.set(key, sec);
  return sec;
}

function insertWaitsAndRecompute({ departTime, segments }) {
  const segs = (segments ?? []).filter((s) => s && s.mode !== "WAIT");
  const out = [];
  let totalSec = 0;
  let totalDist = 0;
  let currentTime = departTime instanceof Date ? new Date(departTime) : null;

  for (const seg of segs) {
    if (seg.mode === "TRANSIT") {
      const dep =
        coerceDate(seg.transitDetails?.departure_time) ??
        coerceDate(getTransitDetailsFromStep(seg.step)?.departure_time);

      if (currentTime && dep && currentTime < dep) {
        const waitSec = (dep.getTime() - currentTime.getTime()) / 1000;
        if (waitSec > 20) {
          out.push({
            mode: "WAIT",
            seconds: waitSec,
            distanceMeters: 0,
            atStop: seg.transitDetails?.departure_stop,
          });
          totalSec += waitSec;
        }
        currentTime = dep;
      }

      out.push(seg);
      totalSec += seg.seconds ?? 0;
      totalDist += seg.distanceMeters ?? 0;
      if (currentTime)
        currentTime = new Date(currentTime.getTime() + (seg.seconds ?? 0) * 1000);
      continue;
    }

    out.push(seg);
    totalSec += seg.seconds ?? 0;
    totalDist += seg.distanceMeters ?? 0;
    if (currentTime)
      currentTime = new Date(currentTime.getTime() + (seg.seconds ?? 0) * 1000);
  }

  return {
    segments: out,
    durationSec: totalSec,
    distanceMeters: totalDist,
    arriveTime: currentTime,
  };
}

function compressFirstStopWait({ option, transitTime, now }) {
  const segs = option?.segments ?? [];
  const firstTransit = segs.find((s) => s?.mode === "TRANSIT") ?? null;
  const dep =
    coerceDate(firstTransit?.transitDetails?.departure_time) ??
    coerceDate(getTransitDetailsFromStep(firstTransit?.step)?.departure_time);
  if (!dep) return option;

  // Access time excludes waits.
  let accessSec = 0;
  for (const s of segs) {
    if (!s || s.mode === "WAIT") continue;
    if (s.mode === "TRANSIT") break;
    accessSec += s.seconds ?? 0;
  }

  const kind = transitTime?.kind ?? "NOW";
  const dt =
    transitTime?.date instanceof Date &&
    !Number.isNaN(transitTime.date.getTime())
      ? transitTime.date
      : null;
  const minAllowed = kind === "DEPART_AT" && dt ? dt : now;
  const recommended = new Date(dep.getTime() - accessSec * 1000);
  const departTime = recommended < minAllowed ? minAllowed : recommended;

  const rebuilt = insertWaitsAndRecompute({ departTime, segments: segs });
  return {
    ...option,
    ...rebuilt,
    departTime,
    arriveTime: rebuilt.arriveTime ?? option.arriveTime,
  };
}

function routeTotals(route) {
  const legs = route?.legs ?? [];
  const dist = legs.reduce((s, l) => s + (l?.distance?.value ?? 0), 0);
  const dur = legs.reduce((s, l) => s + (l?.duration?.value ?? 0), 0);
  return { dist, dur };
}

function isTaxingDirect(distMeters, durSec) {
  // Heuristic: > 90 min OR > 12 miles
  return durSec > 90 * 60 || distMeters > 12 * 1609.344;
}

function skateSecondsFromGoogleBikeSeconds(bikeSec) {
  // Convert bike-time estimate to skate-time using assumed speeds.
  // (Keep bike estimate itself for BIKE mode; only used for SKATE.)
  if (!Number.isFinite(bikeSec)) return bikeSec;
  return bikeSec * (BIKE_MPH_ASSUMED / SKATE_MPH_FLAT);
}

function skateSecondsFromWalkSeconds(walkSec) {
  if (!Number.isFinite(walkSec)) return walkSec;
  return walkSec * (WALK_MPH / SKATE_MPH_FLAT);
}

// --- Transit glyph support -------------------------------------------------
// In hybrid modes we keep a DirectionsRenderer around for Google's transit
// route shields/labels. If we synthesize hybrid variants that REMOVE some
// transit legs, we must also provide a baseRoute that no longer contains those
// removed TRANSIT steps; otherwise the renderer will still draw shields for the
// cut lines.
function cloneWithDescriptors(obj) {
  if (!obj) return obj;
  try {
    return Object.create(
      Object.getPrototypeOf(obj),
      Object.getOwnPropertyDescriptors(obj)
    );
  } catch {
    try {
      return Object.assign(Object.create(Object.getPrototypeOf(obj)), obj);
    } catch {
      return obj;
    }
  }
}

function buildBaseRouteForTransitSteps(templateRoute, transitSteps) {
  try {
    if (!templateRoute) return null;
    const route = templateRoute;
    const legs = route?.legs ?? [];
    if (!legs.length) return route;

    const leg0 = legs[0];
    const steps = Array.isArray(transitSteps) ? transitSteps.filter(Boolean) : [];
    if (!steps.length) return null;

    const newLeg0 = cloneWithDescriptors(leg0);
    newLeg0.steps = steps;

    // Keep leg start/end coherent so the renderer doesn't try to connect gaps.
    const firstT = steps[0];
    const lastT = steps[steps.length - 1];
    if (firstT?.start_location) newLeg0.start_location = firstT.start_location;
    if (lastT?.end_location) newLeg0.end_location = lastT.end_location;

    // Aggregate duration/distance (not strictly needed for glyphs, but avoids odd UI).
    const dist = steps.reduce((sum, s) => sum + (s?.distance?.value ?? 0), 0);
    const dur = steps.reduce((sum, s) => sum + (s?.duration?.value ?? 0), 0);
    if (Number.isFinite(dist)) newLeg0.distance = { ...(newLeg0.distance ?? {}), value: dist };
    if (Number.isFinite(dur)) newLeg0.duration = { ...(newLeg0.duration ?? {}), value: dur };

    const newRoute = cloneWithDescriptors(route);
    newRoute.legs = [newLeg0, ...legs.slice(1)];

    // Keep original bounds to avoid unexpected viewport jumps.
    newRoute.bounds = route.bounds;
    return newRoute;
  } catch {
    return templateRoute;
  }
}


// Export shared helpers/constants for split modules
export { ALT_GRAY, BIKE_MPH_ASSUMED, GOOGLE_BLUE, MPH_TO_MPS, SKATE_MPH_DOWNHILL_CAP, SKATE_MPH_FLAT, SKATE_MPS_CAP, SKATE_MPS_FLAT, SKATE_UPHILL_COLLAPSE_DEG, WALK_MPH, WALK_MPS, buildBaseRouteForTransitSteps, coerceDate, compressFirstStopWait, firstTransitStep, fmtDistanceMeters, fmtDurationSec, fmtTime, getLegArrival, getLegDeparture, getTransitDetailsFromStep, insertWaitsAndRecompute, isTaxingDirect, latLngKey, locationKey, microAccessSecondsToStop, microPairRoutes, microSegmentForCombo, routeOnce, routeSignature, routeTotals, skateSecondsFromGoogleBikeSeconds, skateSecondsFromWalkSeconds, walkAccessSecondsToFirstTransit };
