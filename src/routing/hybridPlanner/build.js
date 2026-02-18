// Split from src/routing/hybridPlanner.js
import { ROUTE_COMBO } from "../routeCombos";
import { filterRoutesByFerrySchedule } from "../ferrySchedule";
import {
  coerceDate,
  compressFirstStopWait,
  buildBaseRouteForTransitSteps,
  firstTransitStep,
  fmtDistanceMeters,
  fmtDurationSec,
  fmtTime,
  getLegDeparture,
  getTransitDetailsFromStep,
  isTaxingDirect,
  insertWaitsAndRecompute,
  latLngKey,
  microPairRoutes,
  microSegmentForCombo,
  microAccessSecondsToStop,
  routeTotals,
  routeOnce,
  routeSignature,
  skateSecondsFromGoogleBikeSeconds,
  skateSecondsFromWalkSeconds,
  walkAccessSecondsToFirstTransit,
} from "./utils";

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
  const microPairCache = new Map();

  // ----------------------------------
  // Direct SKATE-only options (no transit)
  // ----------------------------------
  // For SKATE mode, we intentionally do NOT request transit routes.
  // We compare WALKING vs BICYCLING geometries, convert each to skateboard time
  // using assumed speeds, and return the fastest options.
  if (combo === ROUTE_COMBO.SKATE) {
    const bikeReq = {
      origin,
      destination,
      travelMode: "BICYCLING",
      provideRouteAlternatives: true,
      avoidFerries: true,
    };
    const walkReq = {
      origin,
      destination,
      travelMode: "WALKING",
      // Some regions may ignore alternatives for walking; that's fine.
      provideRouteAlternatives: true,
      avoidFerries: true,
    };

    let bikeResult = null;
    let walkResult = null;
    try {
      bikeResult = await routeOnce(ds, bikeReq);
    } catch {
      // If bicycling directions are unavailable here, we still try walking-based skate fallback.
    }
    try {
      walkResult = await routeOnce(ds, walkReq);
    } catch {
      // If walking directions are unavailable here, we may still have bicycling-based skate fallback.
    }

    let bikeRoutes = bikeResult?.routes ?? [];
    let walkRoutes = walkResult?.routes ?? [];

    if (bikeRoutes.length) {
      bikeRoutes = await filterRoutesByFerrySchedule({
        ds,
        routes: bikeRoutes,
        transitTime,
        now,
      });
    }
    if (walkRoutes.length) {
      walkRoutes = await filterRoutesByFerrySchedule({
        ds,
        routes: walkRoutes,
        transitTime,
        now,
      });
    }

    const opts = [];

    function addSkateOption(route, result, geometryMode) {
      if (!route) return;
      const { dist, dur } = routeTotals(route);
      const sec = geometryMode === "WALKING"
        ? skateSecondsFromWalkSeconds(dur)
        : skateSecondsFromGoogleBikeSeconds(dur);

      const start =
        kind === "ARRIVE_BY" && tDate
          ? new Date(tDate.getTime() - sec * 1000)
          : kind === "DEPART_AT" && tDate
            ? tDate
            : now;
      const arrive = new Date(start.getTime() + sec * 1000);

      opts.push({
        kind: "DIRECT_SKATE",
        baseRoute: route,
        baseResult: result,
        departTime: start,
        arriveTime: arrive,
        distanceMeters: dist,
        durationSec: sec,
        summary: route?.summary ?? "Skate",
        segments: [
          {
            mode: "SKATE",
            seconds: sec,
            distanceMeters: dist,
            route,
            directionsResult: result,
            skateGeometryMode: geometryMode,
          },
        ],
      });
    }

    // Prefer multiple bike alternatives (they tend to include useful trail/greenway variants).
    for (const r of bikeRoutes.slice(0, 4)) addSkateOption(r, bikeResult, "BICYCLING");

    // Include the best walking geometry as an additional candidate.
    if (walkRoutes?.[0]) addSkateOption(walkRoutes[0], walkResult, "WALKING");

    // Sort + cap (same rules as below).
    const targetArrive = kind === "ARRIVE_BY" && tDate ? tDate : null;
    if (kind === "ARRIVE_BY" && targetArrive) {
      opts.sort((a, b) => {
        const aOk = a.arriveTime && a.arriveTime <= targetArrive;
        const bOk = b.arriveTime && b.arriveTime <= targetArrive;
        if (aOk !== bOk) return aOk ? -1 : 1;
        const aDep = a.departTime?.getTime?.() ?? 0;
        const bDep = b.departTime?.getTime?.() ?? 0;
        if (aDep !== bDep) return bDep - aDep;
        const aDur = a.durationSec ?? 0;
        const bDur = b.durationSec ?? 0;
        if (aDur !== bDur) return aDur - bDur;
        const aArr = a.arriveTime?.getTime?.() ?? 0;
        const bArr = b.arriveTime?.getTime?.() ?? 0;
        return bArr - aArr;
      });
    } else {
      opts.sort((a, b) => {
        const aArr = a.arriveTime?.getTime?.() ?? (a.departTime?.getTime?.() ?? 0) + a.durationSec * 1000;
        const bArr = b.arriveTime?.getTime?.() ?? (b.departTime?.getTime?.() ?? 0) + b.durationSec * 1000;
        if (aArr !== bArr) return aArr - bArr;
        const aDep = a.departTime?.getTime?.() ?? 0;
        const bDep = b.departTime?.getTime?.() ?? 0;
        if (aDep !== bDep) return bDep - aDep;
        return (a.durationSec ?? 0) - (b.durationSec ?? 0);
      });
    }

    const capped = opts.slice(0, Math.max(1, maxOptions));

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
        sidebarSegments: [{ mode: "SKATE", durationText }],
      };
    });
  }

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
  let transitResult1 = null;
  let transitCandidates = [];
  try {
    transitResult1 = await routeOnce(ds, transitReq);
    const transitRoutes1 = transitResult1?.routes ?? [];
    transitCandidates = transitRoutes1.map((r) => ({ route: r, result: transitResult1 }));
  } catch {
    // Transit can be unavailable for a valid trip. Keep going so direct bike/skate options can render.
    transitResult1 = null;
    transitCandidates = [];
  }

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
  let bikeResult = null;
  try {
    bikeResult = await routeOnce(ds, bikeReq);
  } catch {
    // Keep going; walk-based skate or transit-based options may still exist.
  }
  let bikeRoutes = bikeResult?.routes ?? [];
  if (bikeRoutes.length) {
    bikeRoutes = await filterRoutesByFerrySchedule({
      ds,
      routes: bikeRoutes,
      transitTime,
      now,
    });
  }

  // Direct walk (for direct skate candidate)
  const walkReq = {
    origin,
    destination,
    travelMode: "WALKING",
    provideRouteAlternatives: false,
  };
  let walkResult = null;
  try {
    walkResult = await routeOnce(ds, walkReq);
  } catch {
    // Keep going; bike/transit options may still exist.
  }
  let walkRoute = walkResult?.routes?.[0] ?? null;
  if (walkRoute) {
    const filteredWalkRoutes = await filterRoutesByFerrySchedule({
      ds,
      routes: [walkRoute],
      transitTime,
      now,
    });
    walkRoute = filteredWalkRoutes[0] ?? null;
  }

  const options = [];

  // Helper to create a simplified segments view for the sidebar.
  const toSidebarSegments = (segments) =>
    segments
      .filter((s) => s.mode !== "WAIT")
      .map((s) => ({ mode: s.mode, durationText: fmtDurationSec(s.seconds) }));

  const sumSeconds = (segs, endExclusive) => {
    let s = 0;
    const n = typeof endExclusive === "number" ? Math.max(0, Math.min(segs.length, endExclusive)) : segs.length;
    for (let i = 0; i < n; i++) s += segs[i]?.seconds ?? 0;
    return s;
  };

  const sumSecondsInclusive = (segs, endInclusive) => {
    if (!Number.isFinite(endInclusive)) return sumSeconds(segs);
    return sumSeconds(segs, endInclusive + 1);
  };

  async function buildMicroSegment({ o, d }) {
    const pair = await microPairRoutes({ ds, origin: o, destination: d, cache: microPairCache });
    return microSegmentForCombo({ combo, pair });
  }

  async function expandStepsToSegments({ stepList, baseResult, fallbackRoute }) {
    const segs = [];
    let totalDist = 0;
    let totalSec = 0;

    for (const step of stepList) {
      const mode = step?.travel_mode;
      if (mode === "WALKING") {
        const o = step.start_location;
        const d = step.end_location;
        const seg = await buildMicroSegment({ o, d });
        if (!seg || !Number.isFinite(seg.seconds)) continue;
        segs.push(seg);
        totalSec += seg.seconds;
        totalDist += seg.distanceMeters ?? 0;
        continue;
      }

      if (mode === "TRANSIT") {
        const td = getTransitDetailsFromStep(step);
        const dep = coerceDate(td?.departure_time);
        const arr = coerceDate(td?.arrival_time);
        const dur = step?.duration?.value ?? (arr && dep ? (arr.getTime() - dep.getTime()) / 1000 : 0);
        const dist = step?.distance?.value ?? 0;
        segs.push({
          mode: "TRANSIT",
          seconds: dur,
          distanceMeters: dist,
          transitDetails: td ?? null,
          step,
          // Fallback geometry source if step.path is missing in some Maps payloads.
          route: fallbackRoute ?? null,
          directionsResult: baseResult,
        });
        totalSec += dur;
        totalDist += dist;
        continue;
      }

      const dur = step?.duration?.value ?? 0;
      const dist = step?.distance?.value ?? 0;
      segs.push({ mode: "OTHER", seconds: dur, distanceMeters: dist, step });
      totalSec += dur;
      totalDist += dist;
    }

    return { segments: segs, totalDist, totalSec };
  }

  async function buildTailCutVariantsFromOption(opt) {
    // Rule-set B: consider every TRANSIT leg <= 10 minutes.
    // For each short leg (except first transit), cut from the *previous* transit arrival stop and ride straight to destination.
    const segs = opt?.segments ?? [];
    const transitIdxs = [];
    for (let idx = 0; idx < segs.length; idx++) if (segs[idx]?.mode === "TRANSIT") transitIdxs.push(idx);
    if (transitIdxs.length < 2) return { variants: [], dropOriginal: false };

    const seen = new Set();
    const variants = [];
    let dropOriginal = false;

    for (let ti = 0; ti < transitIdxs.length; ti++) {
      const idx = transitIdxs[ti];
      const tSeg = segs[idx];
      const tDur = tSeg?.seconds ?? Infinity;
      if (!Number.isFinite(tDur) || tDur > 10 * 60) continue;

      // First transit leg: handled separately (skip-to-second logic).
      if (ti === 0) continue;

      const prevIdx = transitIdxs[ti - 1];
      const prev = segs[prevIdx];
      const stopLoc = prev?.transitDetails?.arrival_stop?.location ?? null;
      const stopName = prev?.transitDetails?.arrival_stop?.name ?? "";
      const stopKey = latLngKey(stopLoc);
      const dedupeKey = `tail:${stopKey}`;
      if (!stopKey || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const prefixSec = sumSecondsInclusive(segs, prevIdx);
      const origStretchSec = Math.max(0, (opt.durationSec ?? sumSeconds(segs)) - prefixSec);
      if (!Number.isFinite(origStretchSec) || origStretchSec <= 0) continue;

      const microSeg = await buildMicroSegment({ o: stopLoc, d: destination });
      const newStretchSec = microSeg?.seconds ?? Infinity;
      if (!Number.isFinite(newStretchSec) || newStretchSec === Infinity) continue;

      // Gate by your rule:
      // - Discard if > 10% slower
      // - Keep BOTH unless >= 20% faster (new <= 0.8 * orig), in which case keep only the variant.
      if (newStretchSec > origStretchSec * 1.1) continue;
      if (newStretchSec <= origStretchSec * 0.8) dropOriginal = true;

      const kept = segs.slice(0, prevIdx + 1);
      const keptTransitSteps = kept.filter((s) => s?.mode === "TRANSIT" && s?.step).map((s) => s.step);
      const glyphBaseRoute = buildBaseRouteForTransitSteps(opt.baseRoute, keptTransitSteps);
      const stitched = [...kept, { ...microSeg, cutMeta: { fromStopName: stopName, fromStopKey: stopKey } }];
      const rebuilt = insertWaitsAndRecompute({ departTime: opt.departTime, segments: stitched });
      let v = {
        kind: "HYBRID",
        // Critical for transit glyphs: remove cut TRANSIT steps so their shields disappear.
        baseRoute: glyphBaseRoute,
        baseResult: opt.baseResult,
        departTime: opt.departTime,
        arriveTime: rebuilt.arriveTime,
        distanceMeters: rebuilt.distanceMeters,
        durationSec: rebuilt.durationSec,
        summary: opt.summary,
        segments: rebuilt.segments,
        sidebarSegments: toSidebarSegments(rebuilt.segments),
        cutKind: "TAIL",
      };
      v = compressFirstStopWait({ option: v, transitTime, now });
      v.sidebarSegments = toSidebarSegments(v.segments);
      variants.push(v);
    }


    // Also consider long transfer waits even if the upcoming transit leg is > 10 minutes.
    // This catches the common "big wait + extra bus" pattern.
    const WAIT_TRIGGER_SEC = 10 * 60;
    for (let wi = 0; wi < segs.length; wi++) {
      const s = segs[wi];
      if (s?.mode !== "WAIT") continue;
      const w = s?.seconds ?? 0;
      if (!Number.isFinite(w) || w < WAIT_TRIGGER_SEC) continue;

      // Ensure there's another transit after this wait (i.e., it's actually a transfer wait).
      let nextTransit = -1;
      for (let j = wi + 1; j < segs.length; j++) {
        if (segs[j]?.mode === "TRANSIT") { nextTransit = j; break; }
      }
      if (nextTransit < 0) continue;

      // Cut from the previous transit arrival stop.
      let prevTransit = -1;
      for (let j = wi - 1; j >= 0; j--) {
        if (segs[j]?.mode === "TRANSIT") { prevTransit = j; break; }
      }
      if (prevTransit < 0) continue;

      const prev = segs[prevTransit];
      const stopLoc = prev?.transitDetails?.arrival_stop?.location ?? null;
      const stopName = prev?.transitDetails?.arrival_stop?.name ?? "";
      const stopKey = latLngKey(stopLoc);
      const dedupeKey = `tail:${stopKey}`;
      if (!stopKey || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const prefixSec = sumSecondsInclusive(segs, prevTransit);
      const origStretchSec = Math.max(0, (opt.durationSec ?? sumSeconds(segs)) - prefixSec);
      if (!Number.isFinite(origStretchSec) || origStretchSec <= 0) continue;

      const microSeg = await buildMicroSegment({ o: stopLoc, d: destination });
      const newStretchSec = microSeg?.seconds ?? Infinity;
      if (!Number.isFinite(newStretchSec) || newStretchSec === Infinity) continue;

      if (newStretchSec > origStretchSec * 1.1) continue;
      if (newStretchSec <= origStretchSec * 0.8) dropOriginal = true;

      const kept = segs.slice(0, prevTransit + 1);
      const keptTransitSteps = kept.filter((s) => s?.mode === "TRANSIT" && s?.step).map((s) => s.step);
      const glyphBaseRoute = buildBaseRouteForTransitSteps(opt.baseRoute, keptTransitSteps);
      const stitched = [...kept, { ...microSeg, cutMeta: { fromStopName: stopName, fromStopKey: stopKey } }];
      const rebuilt = insertWaitsAndRecompute({ departTime: opt.departTime, segments: stitched });
      let v = {
        kind: "HYBRID",
        // Critical for transit glyphs: remove cut TRANSIT steps so their shields disappear.
        baseRoute: glyphBaseRoute,
        baseResult: opt.baseResult,
        departTime: opt.departTime,
        arriveTime: rebuilt.arriveTime,
        distanceMeters: rebuilt.distanceMeters,
        durationSec: rebuilt.durationSec,
        summary: opt.summary,
        segments: rebuilt.segments,
        sidebarSegments: toSidebarSegments(rebuilt.segments),
        cutKind: "TAIL",
      };
      v = compressFirstStopWait({ option: v, transitTime, now });
      v.sidebarSegments = toSidebarSegments(v.segments);
      variants.push(v);
    }

    return { variants, dropOriginal };  }

  async function buildFirstLegSkipVariantsFromOption(opt) {
    // Only if the FIRST transit leg is <= 10 minutes and there is a second transit leg.
    const segs = opt?.segments ?? [];
    const transitIdxs = [];
    for (let idx = 0; idx < segs.length; idx++) if (segs[idx]?.mode === "TRANSIT") transitIdxs.push(idx);
    if (transitIdxs.length < 2) return { variants: [], dropOriginal: false };

    const first = segs[transitIdxs[0]];
    const firstDur = first?.seconds ?? Infinity;
    if (!Number.isFinite(firstDur) || firstDur > 10 * 60) return { variants: [], dropOriginal: false };

    const secondIdx = transitIdxs[1];
    const second = segs[secondIdx];
    const t2Stop = second?.transitDetails?.departure_stop?.location ?? null;
    const t2Name = second?.transitDetails?.departure_stop?.name ?? "";
    const t2Key = latLngKey(t2Stop);
    if (!t2Stop || !t2Key) return { variants: [], dropOriginal: false };

    // Access micro (origin -> second-leg boarding stop)
    const accessSeg = await buildMicroSegment({ o: origin, d: t2Stop });
    if (!accessSeg || !Number.isFinite(accessSeg.seconds) || accessSeg.seconds === Infinity) return { variants: [], dropOriginal: false };

    // Compare the replaced PREFIX stretch: departTime -> boarding the second transit in the original
    // vs departTime -> boarding the first transit in the variant.
    const origSecondTransitIdx = transitIdxs[1];
    const origStretchSec = sumSeconds(segs, origSecondTransitIdx);
    if (!Number.isFinite(origStretchSec) || origStretchSec <= 0) return { variants: [], dropOriginal: false };

    // Requery transit from the second-leg stop at the earlier arrival time.
    const arriveAtStop = new Date((opt.departTime?.getTime?.() ?? now.getTime()) + accessSeg.seconds * 1000);
    const remReq = {
      origin: t2Stop,
      destination,
      travelMode: "TRANSIT",
      provideRouteAlternatives: true,
      transitOptions: undefined,
    };

    if (kind === "ARRIVE_BY" && tDate) remReq.transitOptions = { arrivalTime: tDate };
    else remReq.transitOptions = { departureTime: arriveAtStop < now ? now : arriveAtStop };

    let remResult = null;
    try {
      remResult = await routeOnce(ds, remReq);
    } catch {
      remResult = null;
    }

    const remRoutes = (remResult?.routes ?? []).filter(Boolean).slice(0, 2);

    const variants = [];
    let dropOriginal = false;

    const seen = new Set();

    async function considerVariantFromRemainder(remRoute) {
      // Dedupe by transit signature so two alternatives that are effectively the same don't double-populate.
      const sig = routeSignature(remRoute);
      if (sig && seen.has(sig)) return;
      if (sig) seen.add(sig);

      let remainderSegments = [];
      if (remRoute?.legs?.[0]?.steps?.length) {
        const expanded = await expandStepsToSegments({
          stepList: remRoute.legs[0].steps,
          baseResult: remResult,
          fallbackRoute: remRoute,
        });
        remainderSegments = expanded.segments;
      }

      // If transit remainder is unavailable, allow a transit-less option by just riding/walking to destination.
      if (!remainderSegments.length) {
        const directSeg = await buildMicroSegment({ o: origin, d: destination });
        if (!directSeg || !Number.isFinite(directSeg.seconds) || directSeg.seconds === Infinity) return;

        const rebuiltDirect = insertWaitsAndRecompute({ departTime: opt.departTime, segments: [directSeg] });
        let v = {
          kind: "HYBRID",
          // No transit legs in this variant → ensure we do NOT keep transit glyphs.
          baseRoute: null,
          baseResult: null,
          departTime: opt.departTime,
          arriveTime: rebuiltDirect.arriveTime,
          distanceMeters: rebuiltDirect.distanceMeters,
          durationSec: rebuiltDirect.durationSec,
          summary: opt.summary,
          segments: rebuiltDirect.segments,
          sidebarSegments: toSidebarSegments(rebuiltDirect.segments),
          cutKind: "FIRST_LEG_SKIP",
          cutMeta: { toStopName: t2Name, toStopKey: t2Key },
        };
        v = compressFirstStopWait({ option: v, transitTime, now });
        v.sidebarSegments = toSidebarSegments(v.segments);

        const newStretchSec = v.durationSec ?? sumSeconds(v.segments ?? []);
        if (!Number.isFinite(newStretchSec)) return;
        if (newStretchSec > origStretchSec * 1.1) return;
        if (newStretchSec <= origStretchSec * 0.8) dropOriginal = true;
        variants.push(v);
        return;
      }

      const stitched = [{ ...accessSeg, cutMeta: { toStopName: t2Name, toStopKey: t2Key } }, ...remainderSegments];
      const rebuilt = insertWaitsAndRecompute({ departTime: opt.departTime, segments: stitched });
      let v = {
        kind: "HYBRID",
        // Glyphs should reflect the re-queried remainder transit route(s), not the original route we cut.
        baseRoute: remRoute ?? null,
        baseResult: remResult ?? null,
        departTime: opt.departTime,
        arriveTime: rebuilt.arriveTime,
        distanceMeters: rebuilt.distanceMeters,
        durationSec: rebuilt.durationSec,
        summary: opt.summary,
        segments: rebuilt.segments,
        sidebarSegments: toSidebarSegments(rebuilt.segments),
        cutKind: "FIRST_LEG_SKIP",
        cutMeta: { toStopName: t2Name, toStopKey: t2Key },
      };
      v = compressFirstStopWait({ option: v, transitTime, now });
      v.sidebarSegments = toSidebarSegments(v.segments);

      const vSegs = v.segments ?? [];
      const vFirstTransitIdx = vSegs.findIndex((s) => s?.mode === "TRANSIT");
      const newStretchSec = vFirstTransitIdx >= 0 ? sumSeconds(vSegs, vFirstTransitIdx) : (v.durationSec ?? sumSeconds(vSegs));

      if (!Number.isFinite(newStretchSec)) return;
      if (newStretchSec > origStretchSec * 1.1) return;
      if (newStretchSec <= origStretchSec * 0.8) dropOriginal = true;
      variants.push(v);
    }

    if (!remRoutes.length) {
      // No remainder transit found; still allow a transit-less variant.
      await considerVariantFromRemainder(null);
    } else {
      for (const r of remRoutes) await considerVariantFromRemainder(r);
    }

    return { variants, dropOriginal };
  }

  // Direct no-transit options


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

    const hasBike = Number.isFinite(bikeSkateSec);
    const hasWalk = Number.isFinite(walkSkateSec);
    if (!hasBike && !hasWalk) return null;

    const useBike = hasBike && (!hasWalk || bikeSkateSec <= walkSkateSec);
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

        // Cached WALK+BIKE pair; then choose the faster (bike riders can walk bikes; skaters can use either geometry).
        const pair = await microPairRoutes({ ds, origin: o, destination: d, cache: microPairCache });
        const seg = microSegmentForCombo({ combo, pair });
        if (!seg || !Number.isFinite(seg.seconds)) continue;

        segments.push(seg);
        totalSec += seg.seconds;
        totalDist += seg.distanceMeters ?? 0;
        currentTime = new Date(currentTime.getTime() + seg.seconds * 1000);
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
          // Fallback geometry source if step.path is missing in some Maps payloads.
          route: tr,
          directionsResult: baseResult,
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

    // --- Hybrid refinement: replace "short" transit legs (<= 10 min) with direct micro-mobility when competitive.
    // Rules (per your latest):
    // - Keep the cut variant if newStretch <= origStretch * 1.10
    // - If newStretch <= origStretch * 0.80, drop the original route entirely
    // - Otherwise, keep BOTH (sorting + slice(0, maxOptions) will decide)

    const variants = [];
    let dropOriginal = false;

    // First-transit short leg: try skipping everything up to the *second* transit leg,
    // then requery transit from that stop at the earlier arrival time.
    const firstSkip = await buildFirstLegSkipVariantsFromOption(opt);
    if (firstSkip?.variants?.length) {
      variants.push(...firstSkip.variants);
      if (firstSkip.dropOriginal) dropOriginal = true;
    }

    // Non-first short legs: cut from previous transit arrival stop to destination.
    const tailCuts = await buildTailCutVariantsFromOption(opt);
    if (tailCuts?.variants?.length) variants.push(...tailCuts.variants);
    if (tailCuts?.dropOriginal) dropOriginal = true;

    if (!dropOriginal) options.push(opt);
    for (const v of variants) options.push(v);
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
    if (directSkateCandidate && Number.isFinite(directSkateCandidate.durationSec)) {
      const taxing = isTaxingDirect(directSkateCandidate.distanceMeters, directSkateCandidate.durationSec);
      if (!taxing || options.length < maxOptions - 1) options.push(directSkateCandidate);
    }
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
