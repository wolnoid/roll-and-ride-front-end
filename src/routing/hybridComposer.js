// src/routing/hybridComposer.js
//
// Builds “Google-like” route options + an itinerary model for:
// - TRANSIT
// - BIKE
// - SKATE (walk/bike + speed adjustment)
// - TRANSIT_BIKE (replace walking legs with best of walk/bike)
// - TRANSIT_SKATE (replace walking legs with best of bike / adjusted-walk)
//
// Notes:
// - We do NOT attempt to mutate the DirectionsResult to feed DirectionsRenderer.
// - Instead we generate a custom itinerary model that the UI renders.
// - For TRANSIT_* we keep the transit schedule fixed, and insert “wait” segments
//   whenever a faster last-mile leg arrives early.

import { ROUTE_COMBO } from "./routeCombos";
import {
  addSeconds,
  asDate,
  clamp,
  formatDistanceMeters,
  formatDurationSec,
  formatTime,
} from "./routeFormat";
import { toLatLngLiteral } from "../maps/googleUtils";

const DEFAULT_TRANSFER_BUFFER_SEC = 60;
const SKATE_WALK_MULT = 0.5; // 3mph -> ~6mph
// If we represent skating with a *bicycling* geometry (bike lanes),
// scale Google’s bicycling ETA (~10mph) to a skateboard ETA (~6mph).
const SKATE_BIKE_MULT = 10 / 6;

function llKey(ll) {
  const p = toLatLngLiteral(ll);
  return p ? `${p.lat.toFixed(6)},${p.lng.toFixed(6)}` : "none";
}

function safeText(x) {
  return typeof x === "string" ? x : "";
}

function sumLegDistanceMeters(route) {
  const legs = route?.legs ?? [];
  return legs.reduce((s, l) => s + (l?.distance?.value ?? 0), 0);
}

function sumLegDurationSec(route) {
  const legs = route?.legs ?? [];
  return legs.reduce((s, l) => s + (l?.duration?.value ?? 0), 0);
}

function getRouteStartEnd(route) {
  const legs = route?.legs ?? [];
  const first = legs[0];
  const last = legs[legs.length - 1];
  return {
    start: first?.start_location ?? null,
    end: last?.end_location ?? null,
  };
}

function modeLabelFromTravelMode(travelMode) {
  if (travelMode === "BICYCLING") return "Bike";
  if (travelMode === "WALKING") return "Walk";
  if (travelMode === "TRANSIT") return "Transit";
  return safeText(travelMode) || "Move";
}

function buildSegmentId(prefix, idx) {
  return `${prefix}-${idx}-${Math.random().toString(16).slice(2, 8)}`;
}

async function dsRoute(ds, req, cache) {
  const mode = req?.travelMode ?? "";
  const key = `${mode}|o:${llKey(req?.origin)}|d:${llKey(req?.destination)}|w:${(req?.waypoints ?? [])
    .map((w) => llKey(w?.location ?? w))
    .join(";")}`;

  if (cache && cache.has(key)) return cache.get(key);
  const p = ds.route(req);
  if (cache) cache.set(key, p);
  return p;
}

function buildStepsFromDirectionsRoute(route) {
  const leg = route?.legs?.[0];
  const steps = leg?.steps ?? [];
  return steps.map((s) => ({
    travelMode: safeText(s?.travel_mode),
    html: safeText(s?.instructions ?? s?.html_instructions),
    distanceText: safeText(s?.distance?.text),
    durationText: safeText(s?.duration?.text),
  }));
}

function transitLineLabel(step) {
  const td = step?.transit_details;
  const line = td?.line;
  const vehicle = line?.vehicle?.type ?? "";
  const short = line?.short_name || line?.name || "Transit";
  const headsign = td?.headsign || "";
  return {
    vehicle: safeText(vehicle),
    shortName: safeText(short),
    headsign: safeText(headsign),
  };
}

function segmentSummaryLabel(seg) {
  if (!seg) return "";
  if (seg.kind === "WAIT") return `Wait ${formatDurationSec(seg.durationSec)}`;
  if (seg.mode === "TRANSIT") {
    const t = seg.transit;
    const base = [t?.vehicle, t?.shortName].filter(Boolean).join(" ");
    return base || "Transit";
  }
  return seg.modeLabel || "Move";
}

function formatTimeRange(dep, arr) {
  const a = formatTime(dep);
  const b = formatTime(arr);
  if (!a || !b) return "";
  return `${a} → ${b}`;
}

function computeRouteOption(route, index) {
  const durationText = formatDurationSec(route.totalDurationSec);
  const distanceText = formatDistanceMeters(route.totalDistanceMeters);

  const timeText = formatTimeRange(route.departureTime, route.arrivalTime);

  // Like Google: “Bike 8 min · Bus 24 min · Wait 4 min …”
  const bits = [];
  for (const s of route.segments) {
    if (s.kind === "MOVE") {
      bits.push(`${segmentSummaryLabel(s)} ${formatDurationSec(s.durationSec)}`);
    } else if (s.kind === "WAIT") {
      bits.push(`Wait ${formatDurationSec(s.durationSec)}`);
    }
  }

  return {
    index,
    summary: route.summary || `Route ${index + 1}`,
    durationText,
    distanceText,
    timeText,
    detailText: bits.join(" · "),
  };
}

function normalizeModeForCombo(combo, baseTravelMode) {
  if (combo === ROUTE_COMBO.BIKE) return "BICYCLING";
  if (combo === ROUTE_COMBO.SKATE) return "SKATE";
  if (combo === ROUTE_COMBO.TRANSIT) return "TRANSIT";
  if (combo === ROUTE_COMBO.TRANSIT_BIKE) return "TRANSIT_BIKE";
  if (combo === ROUTE_COMBO.TRANSIT_SKATE) return "TRANSIT_SKATE";
  return baseTravelMode || "TRANSIT";
}

function startTimeFromTransitRoute(route, fallback) {
  const dep = asDate(route?.legs?.[0]?.departure_time?.value ?? route?.legs?.[0]?.departure_time);
  return dep ?? fallback ?? null;
}

function endTimeFromTransitRoute(route) {
  const legs = route?.legs ?? [];
  const lastLeg = legs[legs.length - 1];
  const arr = asDate(lastLeg?.arrival_time?.value ?? lastLeg?.arrival_time);
  return arr ?? null;
}

function computeBikeStartTimeFromTimePrefs(timePref, bikeDurationSec) {
  // timePref: { kind: "NOW"|"DEPART_AT"|"ARRIVE_BY", date: Date|null }
  if (timePref?.kind === "DEPART_AT" && timePref?.date instanceof Date) {
    return timePref.date;
  }
  if (timePref?.kind === "ARRIVE_BY" && timePref?.date instanceof Date) {
    return addSeconds(timePref.date, -(bikeDurationSec ?? 0));
  }
  return new Date();
}

function computeSkateDurationFromWalk(walkDurationSec, gradeFactor = 1) {
  // Placeholder: gradeFactor lets you later slow uphill / speed downhill.
  const base = (walkDurationSec ?? 0) * SKATE_WALK_MULT;
  return Math.max(0, Math.round(base * (gradeFactor || 1)));
}

async function chooseLastMileForWalkingStep({
  ds,
  cache,
  step,
  combo,
  maxAllowedSec,
  hillWeight = 0,
}) {
  const a = step?.start_location;
  const b = step?.end_location;
  if (!a || !b) return null;

  const originalWalkSec = step?.duration?.value ?? 0;

  // Short transfers inside stations can produce ugly bike routes; avoid spam calls.
  const approxDistM = step?.distance?.value ?? 0;
  const tooShort = approxDistM > 0 && approxDistM < 35;

  const wantBike = combo === ROUTE_COMBO.TRANSIT_BIKE || combo === ROUTE_COMBO.TRANSIT_SKATE;
  const wantWalk = true; // always keep walking as a fallback

  let walkRes = null;
  let bikeRes = null;
  try {
    if (wantWalk) {
      walkRes = await dsRoute(
        ds,
        {
          origin: a,
          destination: b,
          travelMode: "WALKING",
          provideRouteAlternatives: false,
        },
        cache
      );
    }
  } catch {
    // ignore
  }

  try {
    if (wantBike && !tooShort) {
      bikeRes = await dsRoute(
        ds,
        {
          origin: a,
          destination: b,
          travelMode: "BICYCLING",
          provideRouteAlternatives: false,
        },
        cache
      );
    }
  } catch {
    // ignore
  }

  const walkRoute = walkRes?.routes?.[0];
  const bikeRoute = bikeRes?.routes?.[0];

  const walkDurSec = walkRoute ? sumLegDurationSec(walkRoute) : originalWalkSec;
  const bikeDurSec = bikeRoute ? sumLegDurationSec(bikeRoute) : Infinity;

  // If we're skating but using a bicycling geometry, scale bicycling ETA to skate ETA.
  const bikeAsSec =
    combo === ROUTE_COMBO.TRANSIT_SKATE && Number.isFinite(bikeDurSec)
      ? Math.max(0, Math.round(bikeDurSec * SKATE_BIKE_MULT))
      : bikeDurSec;

  // Skate: treat “walk” as skate by scaling time.
  const walkAsSec =
    combo === ROUTE_COMBO.TRANSIT_SKATE ? computeSkateDurationFromWalk(walkDurSec) : walkDurSec;

  // Simple hill preference hook (future): you can adjust the score for bike choices.
  // Today it only nudges away from bike if user cranks hillWeight and bike isn't clearly faster.
  const bikeScore = bikeAsSec * (1 + clamp(hillWeight, 0, 1) * 0.15);
  const walkScore = walkAsSec;

  const candidates = [];
  if (Number.isFinite(walkScore)) {
    candidates.push({
      mode: combo === ROUTE_COMBO.TRANSIT_SKATE ? "SKATE" : "WALK",
      durationSec: walkAsSec,
      distanceMeters: sumLegDistanceMeters(walkRoute) || approxDistM || 0,
      sourceRoute: walkRoute,
      sourceTravelMode: "WALKING",
      score: walkScore,
    });
  }

  if (Number.isFinite(bikeScore) && bikeRoute) {
    candidates.push({
      mode: combo === ROUTE_COMBO.TRANSIT_SKATE ? "SKATE" : "BIKE",
      durationSec: bikeAsSec,
      distanceMeters: sumLegDistanceMeters(bikeRoute) || approxDistM || 0,
      sourceRoute: bikeRoute,
      sourceTravelMode: "BICYCLING",
      score: bikeScore,
    });
  }

  // Feasibility: if we have a scheduled transit departure, don't pick an option that makes you miss it.
  const feasible = candidates.filter((c) => {
    if (!Number.isFinite(maxAllowedSec)) return true;
    return (c.durationSec ?? Infinity) <= maxAllowedSec;
  });

  const best = (feasible.length ? feasible : candidates).sort((a, b) => a.score - b.score)[0];
  if (!best) return null;

  return best;
}

export async function buildItinerariesForCombo({
  ds,
  combo,
  origin,
  destination,
  timePref,
  transitOptions,
  waypoints,
  maxTransitRoutes = 6,
  hillWeight = 0,
}) {
  const cache = new Map();

  const mode = normalizeModeForCombo(combo);
  const wantTransit =
    combo === ROUTE_COMBO.TRANSIT ||
    combo === ROUTE_COMBO.TRANSIT_BIKE ||
    combo === ROUTE_COMBO.TRANSIT_SKATE;

  const itineraries = [];

  // Direct bike (for TRANSIT_BIKE) and “direct skate” (for SKATE/TRANSIT_SKATE)
  // are always computed so we can surface “just ride there” when it's faster.
  let directBike = null;
  let directWalk = null;

  try {
    directBike = await dsRoute(
      ds,
      {
        origin,
        destination,
        travelMode: "BICYCLING",
        provideRouteAlternatives: false,
        ...(waypoints?.length ? { waypoints: waypoints.map((p) => ({ location: p, stopover: false })) } : null),
      },
      cache
    );
  } catch {
    // ignore
  }

  try {
    directWalk = await dsRoute(
      ds,
      {
        origin,
        destination,
        travelMode: "WALKING",
        provideRouteAlternatives: false,
        ...(waypoints?.length ? { waypoints: waypoints.map((p) => ({ location: p, stopover: false })) } : null),
      },
      cache
    );
  } catch {
    // ignore
  }

  // 1) Pure BIKE
  if (combo === ROUTE_COMBO.BIKE && directBike?.routes?.[0]) {
    const r = directBike.routes[0];
    const totalDurationSec = sumLegDurationSec(r);
    const depart = computeBikeStartTimeFromTimePrefs(timePref, totalDurationSec);
    const arr = addSeconds(depart, totalDurationSec);

    itineraries.push({
      kind: "DIRECT",
      summary: r?.summary || "Bike",
      totalDurationSec,
      totalDistanceMeters: sumLegDistanceMeters(r),
      departureTime: depart,
      arrivalTime: arr,
      sourceDirections: directBike,
      sourceRouteIndex: 0,
      segments: [
        {
          id: buildSegmentId("bike", 0),
          kind: "MOVE",
          mode: "BIKE",
          modeLabel: "Bike",
          durationSec: totalDurationSec,
          distanceMeters: sumLegDistanceMeters(r),
          startTime: depart,
          endTime: arr,
          steps: buildStepsFromDirectionsRoute(r),
          sourceRoute: r,
        },
      ],
      baseRoute: r,
    });
  }

  // 2) Pure SKATE (choose best of bike vs adjusted-walk)
  if (combo === ROUTE_COMBO.SKATE) {
    const walkR = directWalk?.routes?.[0] ?? null;
    const bikeR = directBike?.routes?.[0] ?? null;

    const walkSec = walkR ? sumLegDurationSec(walkR) : Infinity;
    const skateFromWalk = Number.isFinite(walkSec)
      ? computeSkateDurationFromWalk(walkSec)
      : Infinity;
    const bikeSec = bikeR ? sumLegDurationSec(bikeR) : Infinity;

    const skateFromBike = Number.isFinite(bikeSec)
      ? Math.max(0, Math.round(bikeSec * SKATE_BIKE_MULT))
      : Infinity;

    const pickBike = skateFromBike < skateFromWalk;
    const pickedRoute = pickBike ? bikeR : walkR;
    if (pickedRoute) {
      const dur = pickBike ? skateFromBike : skateFromWalk;
      const depart = computeBikeStartTimeFromTimePrefs(timePref, dur);
      const arr = addSeconds(depart, dur);

      itineraries.push({
        kind: "DIRECT",
        summary: pickBike ? (bikeR?.summary || "Skate") : "Skate",
        totalDurationSec: dur,
        totalDistanceMeters: sumLegDistanceMeters(pickedRoute),
        departureTime: depart,
        arrivalTime: arr,
        sourceDirections: pickBike ? directBike : directWalk,
        sourceRouteIndex: 0,
        segments: [
          {
            id: buildSegmentId("skate", 0),
            kind: "MOVE",
            mode: "SKATE",
            modeLabel: "Skate",
            durationSec: dur,
            distanceMeters: sumLegDistanceMeters(pickedRoute),
            startTime: depart,
            endTime: arr,
            steps: buildStepsFromDirectionsRoute(pickedRoute),
            sourceRoute: pickedRoute,
            sourceTravelMode: pickBike ? "BICYCLING" : "WALKING",
          },
        ],
        baseRoute: pickedRoute,
      });
    }
  }

  // 3) Transit-family
  if (wantTransit) {
    let transitRes = null;
    try {
      transitRes = await dsRoute(
        ds,
        {
          origin,
          destination,
          travelMode: "TRANSIT",
          provideRouteAlternatives: true,
          ...(waypoints?.length ? { waypoints: waypoints.map((p) => ({ location: p, stopover: false })) } : null),
          ...(transitOptions ? { transitOptions } : null),
        },
        null // don't cache transit because time prefs matter
      );
    } catch {
      transitRes = null;
    }

    const baseRoutes = (transitRes?.routes ?? []).slice(0, maxTransitRoutes);

    // Include “direct ride” options even when user asked for TRANSIT_*
    // so we can surface obviously faster no-transit options.
    if (combo === ROUTE_COMBO.TRANSIT_BIKE && directBike?.routes?.[0]) {
      const r = directBike.routes[0];
      const totalDurationSec = sumLegDurationSec(r);
      const depart = computeBikeStartTimeFromTimePrefs(timePref, totalDurationSec);
      const arr = addSeconds(depart, totalDurationSec);

      itineraries.push({
        kind: "DIRECT",
        summary: "Bike only",
        totalDurationSec,
        totalDistanceMeters: sumLegDistanceMeters(r),
        departureTime: depart,
        arrivalTime: arr,
        sourceDirections: directBike,
        sourceRouteIndex: 0,
        segments: [
          {
            id: buildSegmentId("bike", 0),
            kind: "MOVE",
            mode: "BIKE",
            modeLabel: "Bike",
            durationSec: totalDurationSec,
            distanceMeters: sumLegDistanceMeters(r),
            startTime: depart,
            endTime: arr,
            steps: buildStepsFromDirectionsRoute(r),
            sourceRoute: r,
          },
        ],
        baseRoute: r,
      });
    }

    if (combo === ROUTE_COMBO.TRANSIT_SKATE) {
      // Direct skate option.
      const walkR = directWalk?.routes?.[0] ?? null;
      const bikeR = directBike?.routes?.[0] ?? null;

      const walkSec = walkR ? sumLegDurationSec(walkR) : Infinity;
      const skateFromWalk = Number.isFinite(walkSec)
        ? computeSkateDurationFromWalk(walkSec)
        : Infinity;
      const bikeSec = bikeR ? sumLegDurationSec(bikeR) : Infinity;

      const skateFromBike = Number.isFinite(bikeSec)
        ? Math.max(0, Math.round(bikeSec * SKATE_BIKE_MULT))
        : Infinity;

      const pickBike = skateFromBike < skateFromWalk;
      const pickedRoute = pickBike ? bikeR : walkR;

      if (pickedRoute) {
        const dur = pickBike ? skateFromBike : skateFromWalk;
        const depart = computeBikeStartTimeFromTimePrefs(timePref, dur);
        const arr = addSeconds(depart, dur);

        itineraries.push({
          kind: "DIRECT",
          summary: "Skate only",
          totalDurationSec: dur,
          totalDistanceMeters: sumLegDistanceMeters(pickedRoute),
          departureTime: depart,
          arrivalTime: arr,
          sourceDirections: pickBike ? directBike : directWalk,
          sourceRouteIndex: 0,
          segments: [
            {
              id: buildSegmentId("skate", 0),
              kind: "MOVE",
              mode: "SKATE",
              modeLabel: "Skate",
              durationSec: dur,
              distanceMeters: sumLegDistanceMeters(pickedRoute),
              startTime: depart,
              endTime: arr,
              steps: buildStepsFromDirectionsRoute(pickedRoute),
              sourceRoute: pickedRoute,
              sourceTravelMode: pickBike ? "BICYCLING" : "WALKING",
            },
          ],
          baseRoute: pickedRoute,
        });
      }
    }

    for (let rIdx = 0; rIdx < baseRoutes.length; rIdx++) {
      const baseRoute = baseRoutes[rIdx];
      const baseLegs = baseRoute?.legs ?? [];
      if (!baseLegs.length) continue;

      const dep0 = startTimeFromTransitRoute(baseRoute, timePref?.date ?? new Date());
      let current = dep0 ?? new Date();

      const segments = [];
      let totalDistanceMeters = 0;
      let totalDurationSec = 0;

      // Build segments based on per-step travel modes.
      for (const leg of baseLegs) {
        const steps = leg?.steps ?? [];
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const travelMode = step?.travel_mode;

          // Find next transit departure (if the next step is transit)
          const nextStep = steps[i + 1];
          const nextTransitDep = asDate(
            nextStep?.transit_details?.departure_time?.value ??
              nextStep?.transit_details?.departure_time
          );

          if (travelMode === "WALKING" && combo !== ROUTE_COMBO.TRANSIT) {
            const maxAllowedSec = nextTransitDep
              ? Math.max(
                  0,
                  Math.floor((nextTransitDep.getTime() - current.getTime()) / 1000) -
                    DEFAULT_TRANSFER_BUFFER_SEC
                )
              : Infinity;

            const chosen = await chooseLastMileForWalkingStep({
              ds,
              cache,
              step,
              combo,
              maxAllowedSec,
              hillWeight,
            });

            const dur = chosen?.durationSec ?? (step?.duration?.value ?? 0);
            const dist = chosen?.distanceMeters ?? (step?.distance?.value ?? 0);

            const segStart = current;
            const segEnd = addSeconds(segStart, dur);

            segments.push({
              id: buildSegmentId("lm", segments.length),
              kind: "MOVE",
              mode: chosen?.mode ?? "WALK",
              modeLabel: chosen?.mode === "BIKE" ? "Bike" : chosen?.mode === "SKATE" ? "Skate" : "Walk",
              durationSec: dur,
              distanceMeters: dist,
              startTime: segStart,
              endTime: segEnd,
              steps: chosen?.sourceRoute ? buildStepsFromDirectionsRoute(chosen.sourceRoute) : [],
              sourceRoute: chosen?.sourceRoute ?? null,
              sourceTravelMode: chosen?.sourceTravelMode ?? "WALKING",
              from: step?.start_location ?? null,
              to: step?.end_location ?? null,
            });

            totalDistanceMeters += dist;
            totalDurationSec += dur;
            current = segEnd ?? current;

            // If there's a scheduled departure coming up, wait until it.
            if (nextTransitDep && current instanceof Date && current < nextTransitDep) {
              const waitSec = Math.max(
                0,
                Math.floor((nextTransitDep.getTime() - current.getTime()) / 1000)
              );
              if (waitSec > 0) {
                const wStart = current;
                const wEnd = addSeconds(wStart, waitSec);
                segments.push({
                  id: buildSegmentId("wait", segments.length),
                  kind: "WAIT",
                  mode: "WAIT",
                  durationSec: waitSec,
                  startTime: wStart,
                  endTime: wEnd,
                  at: safeText(nextStep?.transit_details?.departure_stop?.name),
                });
                totalDurationSec += waitSec;
                current = wEnd ?? current;
              }
            }
            continue;
          }

          if (travelMode === "WALKING") {
            // Plain transit route (or fallback walking step)
            const dur = step?.duration?.value ?? 0;
            const dist = step?.distance?.value ?? 0;
            const segStart = current;
            const segEnd = addSeconds(segStart, dur);

            segments.push({
              id: buildSegmentId("walk", segments.length),
              kind: "MOVE",
              mode: "WALK",
              modeLabel: "Walk",
              durationSec: dur,
              distanceMeters: dist,
              startTime: segStart,
              endTime: segEnd,
              steps: safeText(step?.instructions ?? step?.html_instructions)
                ? [{ travelMode: "WALKING", html: safeText(step?.instructions ?? step?.html_instructions) }]
                : [],
              from: step?.start_location ?? null,
              to: step?.end_location ?? null,
            });

            totalDistanceMeters += dist;
            totalDurationSec += dur;
            current = segEnd ?? current;
            continue;
          }

          if (travelMode === "TRANSIT") {
            const td = step?.transit_details;
            const dep = asDate(td?.departure_time?.value ?? td?.departure_time) ?? current;
            const arr = asDate(td?.arrival_time?.value ?? td?.arrival_time);
            const dur = step?.duration?.value ??
              (dep && arr ? Math.max(0, Math.floor((arr.getTime() - dep.getTime()) / 1000)) : 0);

            const dist = step?.distance?.value ?? 0;

            // Ensure current aligns with scheduled departure.
            if (dep && current instanceof Date && current < dep) {
              const waitSec = Math.max(0, Math.floor((dep.getTime() - current.getTime()) / 1000));
              if (waitSec > 0) {
                const wStart = current;
                const wEnd = addSeconds(wStart, waitSec);
                segments.push({
                  id: buildSegmentId("wait", segments.length),
                  kind: "WAIT",
                  mode: "WAIT",
                  durationSec: waitSec,
                  startTime: wStart,
                  endTime: wEnd,
                  at: safeText(td?.departure_stop?.name),
                });
                totalDurationSec += waitSec;
              }
            }

            const segStart = dep ?? current;
            const segEnd = arr ?? addSeconds(segStart, dur) ?? current;
            const t = transitLineLabel(step);

            segments.push({
              id: buildSegmentId("transit", segments.length),
              kind: "MOVE",
              mode: "TRANSIT",
              modeLabel: "Transit",
              durationSec: dur,
              distanceMeters: dist,
              startTime: segStart,
              endTime: segEnd,
              transit: {
                ...t,
                numStops: td?.num_stops ?? null,
                depStop: safeText(td?.departure_stop?.name),
                arrStop: safeText(td?.arrival_stop?.name),
              },
              from: td?.departure_stop?.location ?? step?.start_location ?? null,
              to: td?.arrival_stop?.location ?? step?.end_location ?? null,
              steps: safeText(step?.instructions ?? step?.html_instructions)
                ? [{ travelMode: "TRANSIT", html: safeText(step?.instructions ?? step?.html_instructions) }]
                : [],
            });

            totalDistanceMeters += dist;
            totalDurationSec += dur;
            current = segEnd ?? current;
            continue;
          }

          // Fallback: treat unknown step as “move”.
          const dur = step?.duration?.value ?? 0;
          const dist = step?.distance?.value ?? 0;
          const segStart = current;
          const segEnd = addSeconds(segStart, dur);
          segments.push({
            id: buildSegmentId("move", segments.length),
            kind: "MOVE",
            mode: modeLabelFromTravelMode(travelMode).toUpperCase(),
            modeLabel: modeLabelFromTravelMode(travelMode),
            durationSec: dur,
            distanceMeters: dist,
            startTime: segStart,
            endTime: segEnd,
            steps: safeText(step?.instructions ?? step?.html_instructions)
              ? [{ travelMode: safeText(travelMode), html: safeText(step?.instructions ?? step?.html_instructions) }]
              : [],
          });
          totalDistanceMeters += dist;
          totalDurationSec += dur;
          current = segEnd ?? current;
        }
      }

      const arr0 = segments.length ? segments[segments.length - 1]?.endTime : null;
      const baseArr = endTimeFromTransitRoute(baseRoute);

      itineraries.push({
        kind: "TRANSIT",
        summary: baseRoute?.summary || `Transit option ${rIdx + 1}`,
        totalDurationSec,
        totalDistanceMeters,
        departureTime: dep0,
        arrivalTime: arr0 ?? baseArr ?? addSeconds(dep0 ?? new Date(), totalDurationSec),
        sourceDirections: transitRes,
        sourceRouteIndex: rIdx,
        segments,
        baseRoute,
        baseTransitRoute: baseRoute,
      });
    }
  }

  // Sort by duration; stable-ish.
  itineraries.sort((a, b) => (a.totalDurationSec ?? Infinity) - (b.totalDurationSec ?? Infinity));

  const options = itineraries.map((r, i) => computeRouteOption(r, i));
  return { itineraries, options };
}
