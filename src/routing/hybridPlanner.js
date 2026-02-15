// src/routing/hybridPlanner.js
// Build hybrid itineraries (Transit + Bike/Skate) by:
// 1) requesting TRANSIT alternatives
// 2) replacing each WALKING step with the best micro-mobility route
// 3) inserting explicit WAIT segments using transit step schedule times
// 4) optionally adding direct (no-transit) options

import { ROUTE_COMBO } from "./routeCombos";

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
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
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

async function routeOnce(ds, req) {
  // Maps JS DirectionsService.route() returns a Promise in modern versions.
  return await ds.route(req);
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

export function polylineStyleForMode(mode, { isAlt = false } = {}) {
  const strokeColor = isAlt ? ALT_GRAY : GOOGLE_BLUE;
  const strokeWeight = isAlt ? 6 : 8;
  // Alternates should stay in the background, but still be readable.
  const strokeOpacity = isAlt ? 0.6 : 1;

  // NOTE: dotted is done via icons so we can match Google-like walking patterns.
  if (mode === "WALK") {
    return {
      strokeOpacity: 0,
      strokeColor,
      strokeWeight,
      icons: [
        {
          icon: {
            path: window.google.maps.SymbolPath.CIRCLE,
            scale: 2,
            fillColor: strokeColor,
            fillOpacity: 1,
            strokeColor,
            strokeOpacity: 0,
            strokeWeight: 0,
          },
          offset: "0",
          repeat: "10px",
        },
      ],
    };
  }

  // BIKE + SKATE are solid (same visual treatment).
  return { strokeColor, strokeOpacity, strokeWeight };
}

export async function buildHybridOptions({
  ds,
  origin,
  destination,
  transitTime,
  combo,
  maxOptions = 6,
}) {
  const kind = transitTime?.kind ?? "NOW";
  const tDate = transitTime?.date instanceof Date && !Number.isNaN(transitTime.date.getTime()) ? transitTime.date : null;
  const now = new Date();

  const accessCache = new Map();

  // Transit alternatives
  const transitReq = {
    origin,
    destination,
    travelMode: "TRANSIT",
    provideRouteAlternatives: true,
  };

  if (kind === "ARRIVE_BY" && tDate) transitReq.transitOptions = { arrivalTime: tDate };
  else if (kind === "DEPART_AT" && tDate) transitReq.transitOptions = { departureTime: tDate };

  // --- Transit alternatives (optionally 2-pass in DEPART_AT to surface earlier vehicles
  //     that become reachable when the access leg is BIKE/SKATE instead of WALK).
  const transitResult1 = await routeOnce(ds, transitReq);
  const transitRoutes1 = transitResult1?.routes ?? [];
  let transitCandidates = transitRoutes1.map((r) => ({ route: r, result: transitResult1 }));

  if (kind === "DEPART_AT" && tDate && (combo === ROUTE_COMBO.TRANSIT_BIKE || combo === ROUTE_COMBO.TRANSIT_SKATE) && transitCandidates.length) {
    // Compute how much faster micro-mobility is vs Google's walking-to-first-stop,
    // then back-shift the query by that delta to surface earlier departures.
    let maxDeltaSec = 0;
    const sample = transitCandidates.slice(0, Math.min(4, transitCandidates.length));

    for (const cand of sample) {
      const tr = cand.route;
      const walkAccessSec = walkAccessSecondsToFirstTransit(tr);
      const ft = firstTransitStep(tr);
      const stopLoc = ft?.step?.start_location ?? null;
      if (!stopLoc || !Number.isFinite(walkAccessSec) || walkAccessSec <= 0) continue;

      const microSec = await microAccessSecondsToStop({
        ds,
        origin,
        stopLoc,
        combo,
        cache: accessCache,
      });

      if (!Number.isFinite(microSec) || microSec <= 0) continue;
      const delta = walkAccessSec - microSec;
      if (delta > maxDeltaSec) maxDeltaSec = delta;
    }

    // Only worth a second query if micro access materially beats walking.
    if (maxDeltaSec >= 60) {
      const BUFFER_SEC = 60;
      const CAP_SEC = 25 * 60;
      const shiftSec = Math.min(CAP_SEC, Math.ceil(maxDeltaSec + BUFFER_SEC));

      const earlier = new Date(tDate.getTime() - shiftSec * 1000);
      const clampedEarlier = earlier < now ? now : earlier;

      const transitReq2 = {
        ...transitReq,
        transitOptions: { departureTime: clampedEarlier },
      };

      try {
        const transitResult2 = await routeOnce(ds, transitReq2);
        const transitRoutes2 = transitResult2?.routes ?? [];

        const seen = new Set(transitCandidates.map((c) => routeSignature(c.route)));
        // Put earlier-query routes first so they have a chance to be expanded.
        const merged = [];
        for (const r of transitRoutes2) {
          const sig = routeSignature(r);
          if (seen.has(sig)) continue;
          seen.add(sig);
          merged.push({ route: r, result: transitResult2 });
        }
        transitCandidates = [...merged, ...transitCandidates];
      } catch {
        // ignore (fallback to 1-pass)
      }
    }
  }

  // Direct bike alternatives (for BIKE and TRANSIT_BIKE) and as an input to direct skate.
  const bikeReq = {
    origin,
    destination,
    travelMode: "BICYCLING",
    provideRouteAlternatives: true,
  };
  const bikeResult = await routeOnce(ds, bikeReq);
  const bikeRoutes = bikeResult?.routes ?? [];

  // Direct walk (for direct skate candidate)
  const walkReq = {
    origin,
    destination,
    travelMode: "WALKING",
    provideRouteAlternatives: false,
  };
  const walkResult = await routeOnce(ds, walkReq);
  const walkRoute = walkResult?.routes?.[0] ?? null;

  const options = [];

  // Helper to create a simplified segments view for the sidebar.
  const toSidebarSegments = (segments) =>
    segments
      .filter((s) => s.mode !== "WAIT")
      .map((s) => ({ mode: s.mode, durationText: fmtDurationSec(s.seconds) }));

  // Direct no-transit options
  const directBikeCandidates = bikeRoutes.slice(0, 3).map((r) => {
    const { dist, dur } = routeTotals(r);
    const start = kind === "ARRIVE_BY" && tDate ? new Date(tDate.getTime() - dur * 1000) : kind === "DEPART_AT" && tDate ? tDate : now;
    const arrive = new Date(start.getTime() + dur * 1000);
    return {
      kind: "DIRECT_BIKE",
      baseRoute: r,
      baseResult: bikeResult,
      departTime: start,
      arriveTime: arrive,
      distanceMeters: dist,
      durationSec: dur,
      summary: r?.summary ?? "Bike",
      segments: [
        {
          mode: "BIKE",
          seconds: dur,
          distanceMeters: dist,
          route: r,
          directionsResult: bikeResult,
        },
      ],
    };
  });

  const directSkateCandidate = (() => {
    const bikeTop = directBikeCandidates[0];
    const walkTot = walkRoute ? routeTotals(walkRoute) : { dist: 0, dur: Infinity };
    const walkSkateSec = skateSecondsFromWalkSeconds(walkTot.dur);
    const bikeSkateSec = bikeTop ? skateSecondsFromGoogleBikeSeconds(bikeTop.durationSec) : Infinity;

    const useBike = bikeSkateSec <= walkSkateSec;
    const dist = useBike ? bikeTop?.distanceMeters ?? 0 : walkTot.dist;
    const sec = useBike ? bikeSkateSec : walkSkateSec;
    const start = kind === "ARRIVE_BY" && tDate ? new Date(tDate.getTime() - sec * 1000) : kind === "DEPART_AT" && tDate ? tDate : now;
    const arrive = new Date(start.getTime() + sec * 1000);

    return {
      kind: "DIRECT_SKATE",
      departTime: start,
      arriveTime: arrive,
      distanceMeters: dist,
      durationSec: sec,
      summary: "Skate",
      segments: [
        {
          mode: "SKATE",
          seconds: sec,
          distanceMeters: dist,
          route: useBike ? bikeTop?.baseRoute ?? null : walkRoute,
          directionsResult: useBike ? bikeResult : walkResult,
          // Indicates which Google mode geometry we used for skating
          skateGeometryMode: useBike ? "BICYCLING" : "WALKING",
        },
      ],
    };
  })();

  // Build hybrid options from transit alternatives.
  // We don't fully expand all 6 transit alternatives to avoid an explosion of micro queries.
  // We'll expand up to 4, then rely on direct options to fill the list to 6.
  // We don't fully expand all transit alternatives to avoid an explosion of micro queries.
  const expandTransitLimit = Math.min(transitCandidates.length, 4);

  for (let i = 0; i < expandTransitLimit; i++) {
    const cand = transitCandidates[i];
    const tr = cand?.route;
    const baseResult = cand?.result ?? transitResult1;
    const legs = tr?.legs ?? [];
    if (!legs.length) continue;

    const tripStart = getLegDeparture(tr, kind === "DEPART_AT" && tDate ? tDate : now) ?? (kind === "DEPART_AT" && tDate ? tDate : now);
    let currentTime = new Date(tripStart);

    const segments = [];
    let totalDist = 0;
    let totalSec = 0;

    // Only supports single-leg routes for now (Google often returns 1 leg anyway).
    const stepList = legs[0]?.steps ?? [];

    for (const step of stepList) {
      const mode = step?.travel_mode;
      if (mode === "WALKING") {
        const o = step.start_location;
        const d = step.end_location;

        // Query both walk + bike so cyclists can walk bikes, and skaters can use both geometries.
        const [walkRes, bikeResLeg] = await Promise.all([
          routeOnce(ds, { origin: o, destination: d, travelMode: "WALKING", provideRouteAlternatives: false }),
          routeOnce(ds, { origin: o, destination: d, travelMode: "BICYCLING", provideRouteAlternatives: false }),
        ]);

        const wRoute = walkRes?.routes?.[0] ?? null;
        const bRoute = bikeResLeg?.routes?.[0] ?? null;
        const w = wRoute ? routeTotals(wRoute) : { dist: 0, dur: Infinity };
        const b = bRoute ? routeTotals(bRoute) : { dist: 0, dur: Infinity };

        if (combo === ROUTE_COMBO.TRANSIT_BIKE) {
          const useBike = b.dur <= w.dur;
          const chosen = useBike ? bRoute : wRoute;
          const chosenRes = useBike ? bikeResLeg : walkRes;
          const chosenDur = useBike ? b.dur : w.dur;
          const chosenDist = useBike ? b.dist : w.dist;
          segments.push({
            mode: useBike ? "BIKE" : "WALK",
            seconds: chosenDur,
            distanceMeters: chosenDist,
            route: chosen,
            directionsResult: chosenRes,
          });
          totalSec += chosenDur;
          totalDist += chosenDist;
          currentTime = new Date(currentTime.getTime() + chosenDur * 1000);
          continue;
        }

        // TRANSIT_SKATE
        const wSkate = skateSecondsFromWalkSeconds(w.dur);
        const bSkate = skateSecondsFromGoogleBikeSeconds(b.dur);
        const useBike = bSkate <= wSkate;
        const chosen = useBike ? bRoute : wRoute;
        const chosenRes = useBike ? bikeResLeg : walkRes;
        const chosenSec = useBike ? bSkate : wSkate;
        const chosenDist = useBike ? b.dist : w.dist;

        segments.push({
          mode: "SKATE",
          seconds: chosenSec,
          distanceMeters: chosenDist,
          route: chosen,
          directionsResult: chosenRes,
          skateGeometryMode: useBike ? "BICYCLING" : "WALKING",
        });
        totalSec += chosenSec;
        totalDist += chosenDist;
        currentTime = new Date(currentTime.getTime() + chosenSec * 1000);
        continue;
      }

      if (mode === "TRANSIT") {
        const td = getTransitDetailsFromStep(step);
        const dep = coerceDate(td?.departure_time);
        const arr = coerceDate(td?.arrival_time);

        if (dep && currentTime < dep) {
          const waitSec = (dep.getTime() - currentTime.getTime()) / 1000;
          if (waitSec > 20) {
            segments.push({ mode: "WAIT", seconds: waitSec, distanceMeters: 0, atStop: td?.departure_stop });
            totalSec += waitSec;
            currentTime = dep;
          }
        }

        const dur = step?.duration?.value ?? (arr && dep ? (arr.getTime() - dep.getTime()) / 1000 : 0);
        const dist = step?.distance?.value ?? 0;
        segments.push({
          mode: "TRANSIT",
          seconds: dur,
          distanceMeters: dist,
          transitDetails: td ?? null,
          step,
        });
        totalSec += dur;
        totalDist += dist;
        currentTime = new Date(currentTime.getTime() + dur * 1000);
        continue;
      }

      // Fallback: keep Google's estimate for any other step type.
      const dur = step?.duration?.value ?? 0;
      const dist = step?.distance?.value ?? 0;
      segments.push({ mode: "OTHER", seconds: dur, distanceMeters: dist, step });
      totalSec += dur;
      totalDist += dist;
      currentTime = new Date(currentTime.getTime() + dur * 1000);
    }

    const departTime = tripStart;
    const arriveTime = currentTime;

    let opt = {
      kind: "HYBRID",
      baseRoute: tr,
      baseResult,
      departTime,
      arriveTime,
      distanceMeters: totalDist,
      durationSec: totalSec,
      summary: tr?.summary ?? "Transit",
      segments,
      sidebarSegments: toSidebarSegments(segments),
    };

    // Critical: After swapping WALK steps for BIKE/SKATE micro legs, update the trip start time
    // so we don't show "leave earlier just to wait at the first stop".
    opt = compressFirstStopWait({ option: opt, transitTime, now });
    opt.sidebarSegments = toSidebarSegments(opt.segments);
    options.push(opt);
  }

  // Include direct option unless taxing AND we already have enough other options.
  // Even if taxing, include it if we need it to fill the list to maxOptions.
  const addDirectBike = combo === ROUTE_COMBO.TRANSIT_BIKE || combo === ROUTE_COMBO.BIKE;
  const addDirectSkate = combo === ROUTE_COMBO.TRANSIT_SKATE || combo === ROUTE_COMBO.SKATE;

  if (addDirectBike) {
    for (const cand of directBikeCandidates) {
      const taxing = isTaxingDirect(cand.distanceMeters, cand.durationSec);
      if (!taxing || options.length < maxOptions - 1) options.push(cand);
      if (options.length >= maxOptions) break;
    }
  } else if (addDirectSkate) {
    const taxing = isTaxingDirect(directSkateCandidate.distanceMeters, directSkateCandidate.durationSec);
    if (!taxing || options.length < maxOptions - 1) options.push(directSkateCandidate);
  }

  // Sorting
  const targetArrive = kind === "ARRIVE_BY" && tDate ? tDate : null;
  if (kind === "ARRIVE_BY" && targetArrive) {
    options.sort((a, b) => {
      const aOk = a.arriveTime && a.arriveTime <= targetArrive;
      const bOk = b.arriveTime && b.arriveTime <= targetArrive;
      if (aOk !== bOk) return aOk ? -1 : 1;
      const aDep = a.departTime?.getTime?.() ?? 0;
      const bDep = b.departTime?.getTime?.() ?? 0;
      if (aDep !== bDep) return bDep - aDep; // latest departure first
      const aDur = a.durationSec ?? 0;
      const bDur = b.durationSec ?? 0;
      if (aDur !== bDur) return aDur - bDur; // shortest duration first (your preference)
      const aArr = a.arriveTime?.getTime?.() ?? 0;
      const bArr = b.arriveTime?.getTime?.() ?? 0;
      return bArr - aArr; // if still tied, arrive as late as possible
    });
  } else {
    options.sort((a, b) => {
      const aArr = a.arriveTime?.getTime?.() ?? (a.departTime?.getTime?.() ?? 0) + a.durationSec * 1000;
      const bArr = b.arriveTime?.getTime?.() ?? (b.departTime?.getTime?.() ?? 0) + b.durationSec * 1000;
      if (aArr !== bArr) return aArr - bArr;
      const aDep = a.departTime?.getTime?.() ?? 0;
      const bDep = b.departTime?.getTime?.() ?? 0;
      if (aDep !== bDep) return bDep - aDep; // latest departure first (tie-break)
      return (a.durationSec ?? 0) - (b.durationSec ?? 0);
    });
  }

  // Cap final list
  const capped = options.slice(0, Math.max(1, maxOptions));

  // Normalize indices + sidebar segments
  return capped.map((o, idx) => {
    const durationText = fmtDurationSec(o.durationSec);
    const distanceText = fmtDistanceMeters(o.distanceMeters);
    const summary = o.summary;
    const departTimeText = o.departTime ? fmtTime(o.departTime) : "";
    const arriveTimeText = o.arriveTime ? fmtTime(o.arriveTime) : "";
    const timeRangeText = departTimeText && arriveTimeText ? `${departTimeText}–${arriveTimeText}` : "";
    return {
      ...o,
      index: idx,
      durationText,
      distanceText,
      summary,
      departTimeText,
      arriveTimeText,
      timeRangeText,
      sidebarSegments: o.sidebarSegments ?? toSidebarSegments(o.segments ?? []),
    };
  });
}

// Elevation-based refinement for SKATE segments (selected route only).
// Conservative recreational model:
// - Downhill boosts up to 10 mph
// - Uphill slows
// - At >= 8° uphill, clamp to walking speed
export async function refineSkateSegmentsWithElevation({ option }) {
  if (!option?.segments?.length) return option;
  const hasSkate = option.segments.some((s) => s.mode === "SKATE" && s.route);
  if (!hasSkate) return option;

  const { ElevationService } = await window.google.maps.importLibrary("elevation");
  const { computeDistanceBetween } = window.google.maps.geometry.spherical;

  const es = new ElevationService();

  const segs = await Promise.all(
    option.segments.map(async (seg) => {
      if (seg.mode !== "SKATE" || !seg.route) return seg;
      const path = seg.route?.overview_path ?? [];
      if (!path.length) return seg;

      // Sample elevation along the path
      const samples = Math.min(48, Math.max(12, Math.round(path.length / 2)));
      const elev = await es.getElevationAlongPath({ path, samples });
      const results = elev?.results ?? [];
      if (results.length < 2) return seg;

      let sec = 0;
      for (let i = 0; i < results.length - 1; i++) {
        const a = results[i];
        const b = results[i + 1];
        const dist = computeDistanceBetween(a.location, b.location) || 0;
        const dz = (b.elevation ?? 0) - (a.elevation ?? 0);
        const gradeRad = dist > 0 ? Math.atan2(dz, dist) : 0;
        const gradeDeg = (gradeRad * 180) / Math.PI;

        // Conservative speed model
        let speed = SKATE_MPS_FLAT;
        if (gradeDeg >= 0) {
          const t = Math.min(1, gradeDeg / SKATE_UPHILL_COLLAPSE_DEG);
          speed = SKATE_MPS_FLAT + (WALK_MPS - SKATE_MPS_FLAT) * t;
        } else {
          const t = Math.min(1, Math.abs(gradeDeg) / 8);
          speed = SKATE_MPS_FLAT + (SKATE_MPS_CAP - SKATE_MPS_FLAT) * t;
        }

        sec += dist / Math.max(0.1, speed);
      }

      return { ...seg, seconds: sec };
    })
  );

  const durationSec = segs.reduce((s, x) => s + (x.seconds ?? 0), 0);
  const distanceMeters = segs.reduce((s, x) => s + (x.distanceMeters ?? 0), 0);
  const departTime = option.departTime;
  const arriveTime = departTime ? new Date(departTime.getTime() + durationSec * 1000) : option.arriveTime;

  return { ...option, segments: segs, durationSec, distanceMeters, arriveTime };
}

export const HYBRID_STYLES = {
  GOOGLE_BLUE,
  ALT_GRAY,
};
