import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import styles from "./DirectionsSidebar.module.css";
import { getStartIconUrl, getEndIconUrl } from "../../maps/markerIconSvgs";
import { placeToLatLng } from "../../maps/directionsUtils";
import { usePlacePickerChange } from "../../hooks/usePlacePickerChange";
import {
  populatePlacePickerFromLatLng,
  forcePickerText,
  getPickerText,
} from "../../maps/placePicker";
import {
  isTransitOn,
  isBikeOn,
  isSkateOn,
  nextCombo,
} from "../../routing/routeCombos";
import RouteDetails from "../RouteDetails/RouteDetails.jsx";

const LS_KEY = "carpool.sidebarCollapsed";

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M14.5 5.5L8 12l6.5 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}



// --- Sidebar route-card helpers (UI only) ---
const MODE_META = {
  WALK: { label: "Walk", dot: "🚶", bg: "rgba(0,0,0,0.06)" },
  WALKING: { label: "Walk", dot: "🚶", bg: "rgba(0,0,0,0.06)" },
  BIKE: { label: "Bike", dot: "🚲", bg: "rgba(26,115,232,0.12)" },
  BICYCLING: { label: "Bike", dot: "🚲", bg: "rgba(26,115,232,0.12)" },
  SKATE: { label: "Skate", dot: "🛹", bg: "rgba(34,197,94,0.14)" },
  WAIT: { label: "Wait", dot: "⏳", bg: "rgba(0,0,0,0.06)" },
};

function normalizeHexColor(c) {
  if (!c || typeof c !== "string") return null;
  let s = c.trim();
  if (!s) return null;
  if (!s.startsWith("#")) return null;
  s = s.slice(1);
  if (s.length === 3) {
    s = s
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  if (s.length !== 6) return null;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return `#${s.toUpperCase()}`;
}

function readableTextColor(bg) {
  // If it's not a hex color, default to dark text.
  const hex = normalizeHexColor(bg);
  if (!hex) return "rgba(0,0,0,0.86)";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Perceived luminance (YIQ-ish)
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq < 150 ? "rgba(255,255,255,0.96)" : "rgba(0,0,0,0.86)";
}

function vehicleGlyphFromType(type) {
  const t = String(type || "").toUpperCase();
  if (t.includes("BUS")) return "🚌";
  if (t.includes("TRAM") || t.includes("LIGHT_RAIL")) return "🚊";
  if (t.includes("SUBWAY") || t.includes("METRO") || t.includes("HEAVY_RAIL")) return "🚇";
  if (t.includes("RAIL") || t.includes("TRAIN")) return "🚆";
  if (t.includes("FERRY")) return "⛴️";
  return "🚉";
}

function getExplicitLineColor(transitDetails) {
  const line = transitDetails?.line;
  return normalizeHexColor(line?.color) || normalizeHexColor(line?.color_hex) || null;
}

function transitLabel(transitDetails) {
  const line = transitDetails?.line;
  // Per requirement: short_name only. If absent, keep it generic.
  return line?.short_name || line?.shortName || "Transit";
}


function transitModeWordFromType(typeOrName) {
  const t = String(typeOrName || "").toUpperCase();
  if (!t) return "";
  if (t.includes("BUS")) return "bus";
  if (t.includes("TRAM") || t.includes("LIGHT_RAIL")) return "tram";
  if (t.includes("SUBWAY") || t.includes("METRO") || t.includes("HEAVY_RAIL")) return "subway";
  if (t.includes("FERRY")) return "ferry";
  if (t.includes("CABLE_CAR")) return "cable car";
  if (t.includes("GONDOLA")) return "gondola";
  if (t.includes("FUNICULAR")) return "funicular";
  if (t.includes("MONORAIL")) return "monorail";
  if (t.includes("RAIL") || t.includes("TRAIN")) return "train";
  return "";
}

function transitLineWithMode(transitDetails) {
  const line = transitLabel(transitDetails);
  const mode = transitModeWordFromType(transitVehicleType(transitDetails));

  if (line && line !== "Transit" && mode) return `${line} ${mode}`;
  return line || mode || "Transit";
}


function transitVehicleType(transitDetails) {
  const line = transitDetails?.line;
  return line?.vehicle?.type || line?.vehicle?.name || transitDetails?.line?.vehicle?.type || "";
}

function transitServiceName(transitDetails) {
  const line = transitDetails?.line;
  const agencies = line?.agencies || line?.agency || transitDetails?.agencies || [];
  const a0 = Array.isArray(agencies) ? agencies[0] : agencies;
  return a0?.name || a0?.short_name || a0?.shortName || "";
}

const AGENCY_ALIASES = [
  { re: /Bay Area Rapid Transit/i, alias: "BART" },
  { re: /San Francisco Municipal Transportation Agency/i, alias: "Muni" },
  { re: /SFMTA/i, alias: "Muni" },
  { re: /Sacramento Regional Transit/i, alias: "SacRT" },
  { re: /Sacramento Regional Transit District/i, alias: "SacRT" },
  { re: /Los Angeles County Metropolitan Transportation Authority/i, alias: "LA Metro" },
  { re: /Metropolitan Transportation Authority/i, alias: "MTA" },
  { re: /Washington Metropolitan Area Transit Authority/i, alias: "WMATA" },
  { re: /Port Authority Trans-Hudson/i, alias: "PATH" },
  { re: /Massachusetts Bay Transportation Authority/i, alias: "MBTA" },
  { re: /Chicago Transit Authority/i, alias: "CTA" },
  { re: /San Mateo County Transit District/i, alias: "SamTrans" },
  { re: /Santa Clara Valley Transportation Authority/i, alias: "VTA" },
  { re: /Caltrain/i, alias: "Caltrain" },
  { re: /Amtrak/i, alias: "Amtrak" },
];

function shortTransitAgencyName(name) {
  const s = String(name || "").trim();
  if (!s) return "";

  // Already looks like an alias (e.g., BART, MBTA)
  if (s.length <= 8 && /^[A-Z0-9&.-]+$/.test(s)) return s;

  for (const { re, alias } of AGENCY_ALIASES) {
    if (re.test(s)) return alias;
  }

  // If the name has a parenthetical short form, prefer it.
  const m = s.match(/\(([^)]+)\)\s*$/);
  if (m && m[1] && m[1].trim().length <= 10) return m[1].trim();

  return s;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(s, max = 28) {
  const t = String(s || "").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function extractPrimaryPathNameFromSteps(steps) {
  const arr = Array.isArray(steps) ? steps : [];
  for (const st of arr) {
    const instr = stripHtml(st?.html || st?.instructions || st?.html_instructions || "");
    if (!instr) continue;

    // Common Google phrasing: "Head north on X", "Turn left onto X".
    const m = instr.match(/(?:on|onto)\s+([^,]+?)(?:\s+(?:toward|to|for|and|then|at)|$)/i);
    if (m && m[1]) {
      const name = m[1].trim();
      if (name && !/your destination/i.test(name)) return name;
    }
  }
  return "";
}

function flattenGoogleStepList(steps) {
  const arr = Array.isArray(steps) ? steps : [];
  const out = [];

  for (const st of arr) {
    const subs = Array.isArray(st?.steps) && st.steps.length ? st.steps : [st];
    for (const sub of subs) {
      out.push({
        html: sub?.instructions || sub?.html_instructions || "",
        distanceText: sub?.distance?.text || "",
        durationText: sub?.duration?.text || "",
      });
    }
  }

  return out;
}


function segMinutes(sec) {
  const m = Math.max(0, Math.round((Number(sec) || 0) / 60));
  return `${m}m`;
}

function minutesText(sec) {
  const m = Math.max(0, Math.round((Number(sec) || 0) / 60));
  return m === 1 ? "1 minute" : `${m} minutes`;
}

function formatDistanceMi(meters) {
  const mi = (Number(meters) || 0) / 1609.344;
  if (!mi) return "";
  return mi >= 10 ? `${mi.toFixed(0)} mi` : `${mi.toFixed(1)} mi`;
}

function timeRangeTextForOption(option) {
  const dep = option?.departTimeText || "";
  const arr = option?.arriveTimeText || "";
  if (dep && arr) return `${dep} - ${arr}`;
  const t = option?.timeText || option?.timeRangeText || "";
  return String(t).replace(/–|—/g, "-").replace(/\s*-\s*/g, " - ");
}


function coerceDate(d) {
  if (!d) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d;
  // Some Google objects have { value: Date }
  if (d?.value instanceof Date) return Number.isNaN(d.value.getTime()) ? null : d.value;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t;
}

function buildSidebarSegmentsFromHybridOption(option) {
  const segs = option?.segments ?? [];
  const out = [];

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const mode = seg?.mode || "";

    if (mode === "TRANSIT") {
      const td = seg?.transitDetails || seg?.step?.transit || seg?.step?.transit_details || seg?.transit || seg?.transit_details || null;
      const explicit = getExplicitLineColor(td);
      const label = transitLineWithMode(td);
      const glyph = vehicleGlyphFromType(transitVehicleType(td));
      out.push({
        key: `t-${i}`,
        kind: "TRANSIT",
        mode: "TRANSIT",
        label,
        glyph,
        durationSec: seg?.seconds ?? 0,
        distanceMeters: seg?.distanceMeters ?? 0,
        bg: explicit || MODE_META.WALK.bg,
        text: readableTextColor(explicit || MODE_META.WALK.bg),
        lineColor: explicit,
        _service: transitServiceName(td),
      });
      continue;
    }

    if (mode === "WAIT") {
      out.push({
        key: `w-${i}`,
        kind: "WAIT",
        mode: "WAIT",
        label: "Wait",
        glyph: "⏳",
        durationSec: seg?.seconds ?? 0,
        distanceMeters: 0,
        bg: MODE_META.WAIT.bg,
        text: "rgba(0,0,0,0.78)",
      });
      continue;
    }

    const meta = MODE_META[mode] || { label: mode || "Move", dot: "•", bg: MODE_META.WALK.bg };
    out.push({
      key: `m-${i}`,
      kind: "MOVE",
      mode,
      label: meta.label,
      glyph: meta.dot,
      durationSec: seg?.seconds ?? 0,
      distanceMeters: seg?.distanceMeters ?? 0,
      bg: meta.bg,
      text: "rgba(0,0,0,0.86)",
    });
  }

  return out;
}

function buildSidebarSegmentsFromGoogleRoute(route, { defaultMode = "WALK" } = {}) {
  const out = [];
  const legs = route?.legs ?? [];

  // For TRANSIT results, Google often provides scheduled departure/arrival times for transit steps.
  // We use those (when present) to synthesize explicit WAIT segments between transit legs.
  const WAIT_THRESHOLD_SEC = 60; // ignore tiny gaps / rounding
  let cursor = null; // Date

  let group = null;
  const flush = () => {
    if (!group) return;
    out.push(group);
    group = null;
  };

  for (const leg of legs) {
    // Anchor cursor to a timeline if available.
    cursor = cursor || coerceDate(leg?.departure_time) || null;
    const steps = leg?.steps ?? [];
    for (const st of steps) {
      const tm = st?.travel_mode || st?.travelMode || defaultMode;

      if (String(tm).toUpperCase() === "TRANSIT") {
        flush();
        const td = st?.transit || st?.transit_details || null;

        const depT = coerceDate(td?.departure_time) || null;
        const arrT = coerceDate(td?.arrival_time) || null;

        // If our running cursor is earlier than the scheduled departure, that's explicit waiting time.
        if (cursor && depT) {
          const gapSec = Math.round((depT.getTime() - cursor.getTime()) / 1000);
          if (gapSec >= WAIT_THRESHOLD_SEC) {
            out.push({
              key: `w-${out.length}`,
              kind: "WAIT",
              mode: "WAIT",
              label: MODE_META.WAIT.label,
              glyph: MODE_META.WAIT.dot,
              durationSec: gapSec,
              distanceMeters: 0,
              bg: MODE_META.WAIT.bg,
              text: "rgba(0,0,0,0.86)",
              _at: td?.departure_stop?.name || td?.departure_stop?.short_name || "",
            });
          }
        }

        const explicit = getExplicitLineColor(td);
        const label = transitLabel(td);
        const glyph = vehicleGlyphFromType(transitVehicleType(td));
        out.push({
          key: `t-${out.length}`,
          kind: "TRANSIT",
          mode: "TRANSIT",
          label,
          glyph,
          durationSec: st?.duration?.value ?? 0,
          distanceMeters: st?.distance?.value ?? 0,
          bg: explicit || MODE_META.WALK.bg,
          text: readableTextColor(explicit || MODE_META.WALK.bg),
          lineColor: explicit,
          _td: td,
          _service: transitServiceName(td),
        });

        // Advance the timeline cursor.
        if (arrT) cursor = arrT;
        else if (depT) cursor = new Date(depT.getTime() + (st?.duration?.value ?? 0) * 1000);
        else if (cursor) cursor = new Date(cursor.getTime() + (st?.duration?.value ?? 0) * 1000);
        continue;
      }

      const modeKey = String(tm).toUpperCase();
      const meta = MODE_META[modeKey] || MODE_META[defaultMode] || MODE_META.WALK;

      if (!group || group.mode !== modeKey) {
        flush();
        group = {
          key: `m-${out.length}`,
          kind: "MOVE",
          mode: modeKey,
          label: meta.label,
          glyph: meta.dot,
          durationSec: 0,
          distanceMeters: 0,
          bg: meta.bg,
          text: "rgba(0,0,0,0.86)",
        };
      }

      group.durationSec += st?.duration?.value ?? 0;
      group.distanceMeters += st?.distance?.value ?? 0;

      if (cursor) cursor = new Date(cursor.getTime() + (st?.duration?.value ?? 0) * 1000);
    }
  }

  flush();

  return out;
}

function buildSidebarSegments(option, routeCombo) {
  if (option?.segments) return buildSidebarSegmentsFromHybridOption(option);
  if (option?.__route) {
    const def = (routeCombo && isBikeOn(routeCombo)) ? "BICYCLING" : "WALK";
    return buildSidebarSegmentsFromGoogleRoute(option.__route, { defaultMode: def });
  }
  const defMode = routeCombo && isBikeOn(routeCombo) ? "BIKE" : (routeCombo && isSkateOn(routeCombo) ? "SKATE" : "WALK");
  const meta = MODE_META[defMode] || MODE_META.WALK;
  return [{
    key: "fallback",
    kind: "MOVE",
    mode: defMode,
    label: meta.label,
    glyph: meta.dot,
    durationSec: option?.durationSec ?? 0,
    distanceMeters: option?.distanceMeters ?? 0,
    bg: meta.bg,
    text: "rgba(0,0,0,0.86)",
  }];
}

function buildRouteDetailsModel(option) {
  if (!option) return null;

  // Hybrid options already have segments in our internal shape.
  if (option?.segments) {
    const route = {
      totalDurationSec: option.durationSec ?? (option.segments ?? []).reduce((s, seg) => s + (seg?.seconds ?? 0), 0),
      totalDistanceMeters: option.distanceMeters ?? (option.segments ?? []).reduce((s, seg) => s + (seg?.distanceMeters ?? 0), 0),
      departureTime: coerceDate(option.departTime) || new Date(),
      arrivalTime: coerceDate(option.arriveTime) || null,
      segments: [],
    };

    let cursor = coerceDate(option.departTime) || new Date();

    (option.segments ?? []).forEach((seg, i) => {
      const mode = seg?.mode;

      if (mode === "WAIT") {
        const dur = seg?.seconds ?? 0;
        const startTime = cursor;
        const endTime = new Date(startTime.getTime() + dur * 1000);
        cursor = endTime;
        route.segments.push({
          id: `wait-${i}`,
          kind: "WAIT",
          mode: "WAIT",
          modeLabel: "Wait",
          durationSec: dur,
          distanceMeters: 0,
          startTime,
          endTime,
          at: seg?.atStop?.name || seg?.atStop || "",
          steps: [],
        });
        return;
      }

      if (mode === "TRANSIT") {
        const td = seg?.transitDetails || seg?.step?.transit || seg?.step?.transit_details || seg?.transit || seg?.transit_details || null;
        const depT = coerceDate(td?.departure_time) || cursor;
        const arrT = coerceDate(td?.arrival_time) || new Date(depT.getTime() + (seg?.seconds ?? 0) * 1000);
        cursor = arrT;

        const tLabel = transitLabel(td);
        const vType = transitVehicleType(td);
        const vehicleWord = transitModeWordFromType(vType);
        const lineWithMode = tLabel && tLabel !== "Transit" && vehicleWord
          ? `${tLabel} ${vehicleWord}`
          : (tLabel || vehicleWord || "Transit");

        const depStop = td?.departure_stop?.name || td?.departure_stop?.short_name || td?.departure_stop;
        const arrStop = td?.arrival_stop?.name || td?.arrival_stop?.short_name || td?.arrival_stop;

        const steps = [];
        if (depStop) steps.push({ html: `Board at <b>${depStop}</b>`, distanceText: "", durationText: "" });
        steps.push({
          html: `Ride <b>${lineWithMode}</b>${td?.headsign ? ` toward <b>${td.headsign}</b>` : ""}`,
          distanceText: "",
          durationText: td?.num_stops ? `${td.num_stops} stops` : segMinutes(seg?.seconds ?? 0),
        });
        if (arrStop) steps.push({ html: `Get off at <b>${arrStop}</b>`, distanceText: "", durationText: "" });

        route.segments.push({
          id: `t-${i}`,
          kind: "MOVE",
          mode: "TRANSIT",
          modeLabel: "Transit",
          durationSec: seg?.seconds ?? 0,
          distanceMeters: seg?.distanceMeters ?? 0,
          startTime: depT,
          endTime: arrT,
          transit: {
            vehicle: vehicleWord,
            shortName: tLabel,
            agency: transitServiceName(td),
            headsign: td?.headsign || "",
            depStop: depStop || "",
            arrStop: arrStop || "",
            numStops: td?.num_stops || td?.numStops || 0,
          },
          steps,
        });
        return;
      }

      const dur = seg?.seconds ?? 0;
      const startTime = cursor;
      const endTime = new Date(startTime.getTime() + dur * 1000);
      cursor = endTime;

      const modeKey = mode || "WALK";
      const meta = MODE_META[modeKey] || MODE_META.WALK;

      // Pull turn-by-turn from the underlying sub-route if present.
      const leg = seg?.route?.legs?.[0];
      const steps = flattenGoogleStepList(leg?.steps ?? []);

      route.segments.push({
        id: `m-${i}`,
        kind: "MOVE",
        mode: modeKey,
        modeLabel: meta.label,
        durationSec: dur,
        distanceMeters: seg?.distanceMeters ?? 0,
        startTime,
        endTime,
        steps,
      });
    });

    if (!route.arrivalTime && route.segments.length) {
      route.arrivalTime = route.segments[route.segments.length - 1].endTime;
    }

    return route;
  }

  // Google (non-hybrid) route.
  const gRoute = option?.__route;
  if (!gRoute) return null;

  const legs = gRoute?.legs ?? [];
  const totalDurationSec = option.durationSec ?? legs.reduce((s, l) => s + (l?.duration?.value ?? 0), 0);
  const totalDistanceMeters = option.distanceMeters ?? legs.reduce((s, l) => s + (l?.distance?.value ?? 0), 0);

  let cursor = coerceDate(option.departTime) || coerceDate(legs?.[0]?.departure_time) || new Date();
  const departureTime = cursor;

  const segments = [];

  for (const leg of legs) {
    const steps = leg?.steps ?? [];

    const WAIT_THRESHOLD_SEC = 60;

    // Group consecutive non-transit steps
    let group = null;
    const flush = () => {
      if (!group) return;
      segments.push(group);
      group = null;
    };

    for (const st of steps) {
      const tm = String(st?.travel_mode || st?.travelMode || "WALK").toUpperCase();

      if (tm === "TRANSIT") {
        flush();
        const td = st?.transit || st?.transit_details || null;
        const depScheduled = coerceDate(td?.departure_time) || null;

        // Explicit waiting time before the scheduled departure.
        if (cursor && depScheduled) {
          const gapSec = Math.round((depScheduled.getTime() - cursor.getTime()) / 1000);
          if (gapSec >= WAIT_THRESHOLD_SEC) {
            segments.push({
              id: `w-${segments.length}`,
              kind: "WAIT",
              mode: "WAIT",
              modeLabel: "Wait",
              durationSec: gapSec,
              distanceMeters: 0,
              startTime: cursor,
              endTime: depScheduled,
              at: td?.departure_stop?.name || td?.departure_stop?.short_name || "",
              steps: [],
            });
            cursor = depScheduled;
          }
        }

        const depT = depScheduled || cursor;
        const arrT = coerceDate(td?.arrival_time) || new Date(depT.getTime() + (st?.duration?.value ?? 0) * 1000);
        cursor = arrT;

        const tLabel = transitLabel(td);
        const vType = transitVehicleType(td);
        const vehicleWord = transitModeWordFromType(vType);
        const lineWithMode = tLabel && tLabel !== "Transit" && vehicleWord
          ? `${tLabel} ${vehicleWord}`
          : (tLabel || vehicleWord || "Transit");

        const depStop = td?.departure_stop?.name || td?.departure_stop?.short_name || td?.departure_stop;
        const arrStop = td?.arrival_stop?.name || td?.arrival_stop?.short_name || td?.arrival_stop;

        const pseudo = [];
        if (depStop) pseudo.push({ html: `Board at <b>${depStop}</b>`, distanceText: "", durationText: "" });
        pseudo.push({
          html: `Ride <b>${lineWithMode}</b>${td?.headsign ? ` toward <b>${td.headsign}</b>` : ""}`,
          distanceText: "",
          durationText: td?.num_stops ? `${td.num_stops} stops` : (st?.duration?.text || ""),
        });
        if (arrStop) pseudo.push({ html: `Get off at <b>${arrStop}</b>`, distanceText: "", durationText: "" });

        segments.push({
          id: `t-${segments.length}`,
          kind: "MOVE",
          mode: "TRANSIT",
          modeLabel: "Transit",
          durationSec: st?.duration?.value ?? 0,
          distanceMeters: st?.distance?.value ?? 0,
          startTime: depT,
          endTime: arrT,
          transit: {
            vehicle: vehicleWord,
            shortName: tLabel,
            agency: transitServiceName(td),
            headsign: td?.headsign || "",
            depStop: depStop || "",
            arrStop: arrStop || "",
            numStops: td?.num_stops || td?.numStops || 0,
          },
          steps: pseudo,
        });
        continue;
      }

      // Non-transit move (walk/bike)
      if (!group || group.mode !== tm) {
        flush();
        const meta = MODE_META[tm] || MODE_META.WALK;
        const startTime = cursor;
        group = {
          id: `m-${segments.length}`,
          kind: "MOVE",
          mode: tm,
          modeLabel: meta.label,
          durationSec: 0,
          distanceMeters: 0,
          startTime,
          endTime: startTime,
          steps: [],
        };
      }

      group.durationSec += st?.duration?.value ?? 0;
      group.distanceMeters += st?.distance?.value ?? 0;
      group.steps.push(...flattenGoogleStepList([st]));

      group.endTime = new Date(group.startTime.getTime() + group.durationSec * 1000);
      cursor = group.endTime;
    }

    flush();

    // Per-leg arrival_time can be more authoritative
    const legArr = coerceDate(leg?.arrival_time);
    if (legArr) cursor = legArr;
  }

  const arrivalTime = coerceDate(option.arriveTime) || coerceDate(legs?.[legs.length - 1]?.arrival_time) || (totalDurationSec ? new Date(departureTime.getTime() + totalDurationSec * 1000) : null);

  return {
    totalDurationSec,
    totalDistanceMeters,
    departureTime,
    arrivalTime,
    segments,
  };
}

function isWaitSegment(seg) {
  const mode = String(seg?.mode || "").toUpperCase();
  return seg?.kind === "WAIT" || mode === "WAIT";
}

function isTransitSegment(seg) {
  const mode = String(seg?.mode || "").toUpperCase();
  return seg?.kind === "TRANSIT" || mode === "TRANSIT";
}

function isHideableMoveSegment(seg) {
  const kind = String(seg?.kind || "").toUpperCase();
  const isMoveish = kind === "MOVE" || kind === "" || kind === "SEG";
  return isMoveish && !isTransitSegment(seg) && !isWaitSegment(seg);
}

function carryHiddenMinuteMoves(segments) {
  const src = Array.isArray(segments) ? segments : [];
  const segs = src.map((s) => ({ ...s }));

  const hidden = new Set();
  const spareMins = new Map();

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const mins = Math.max(0, Math.round(Number(s?.durationSec || 0) / 60));
    if (mins <= 0) {
      hidden.add(i);
      continue;
    }
    if (isHideableMoveSegment(s) && mins <= 1) {
      hidden.add(i);
      spareMins.set(i, mins);
    }
  }

  const findPrev = (i, pred) => {
    for (let j = i - 1; j >= 0; j--) if (!hidden.has(j) && pred(segs[j])) return j;
    return null;
  };
  const findNext = (i, pred) => {
    for (let j = i + 1; j < segs.length; j++) if (!hidden.has(j) && pred(segs[j])) return j;
    return null;
  };

  for (const [i, mins] of spareMins.entries()) {
    if (!mins) continue;

    // 1) Adjacent WAIT leg if applicable.
    let target = null;
    if (i - 1 >= 0 && !hidden.has(i - 1) && isWaitSegment(segs[i - 1])) target = i - 1;
    else if (i + 1 < segs.length && !hidden.has(i + 1) && isWaitSegment(segs[i + 1]))
      target = i + 1;

    // 2) Previous TRANSIT leg.
    if (target == null) target = findPrev(i, isTransitSegment);

    // 3) Following TRANSIT leg.
    if (target == null) target = findNext(i, isTransitSegment);

    // Fallback: nearest non-hidden leg.
    if (target == null) target = findPrev(i, () => true) ?? findNext(i, () => true);

    if (target != null) {
      segs[target].durationSec = Number(segs[target].durationSec || 0) + mins * 60;
    }
  }

  return segs.filter((_, i) => !hidden.has(i) && Math.round(Number(segs[i]?.durationSec || 0) / 60) > 0);
}

function carryHiddenMinuteMovesExceptEnds(segments) {
  const src = Array.isArray(segments) ? segments : [];
  const segs = src.map((s) => ({ ...s }));

  const hidden = new Set();
  const spareMins = new Map();
  const last = Math.max(0, segs.length - 1);

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const mins = Math.max(0, Math.round(Number(s?.durationSec || 0) / 60));

    // Always drop truly zero-length segments.
    if (mins <= 0) {
      hidden.add(i);
      continue;
    }

    // Hide 1-minute-or-less move segments, EXCEPT first/last segment.
    if (i !== 0 && i !== last && isHideableMoveSegment(s) && mins <= 1) {
      hidden.add(i);
      spareMins.set(i, mins);
    }
  }

  const findPrev = (i, pred) => {
    for (let j = i - 1; j >= 0; j--) if (!hidden.has(j) && pred(segs[j])) return j;
    return null;
  };
  const findNext = (i, pred) => {
    for (let j = i + 1; j < segs.length; j++) if (!hidden.has(j) && pred(segs[j])) return j;
    return null;
  };

  for (const [i, mins] of spareMins.entries()) {
    if (!mins) continue;

    // 1) Adjacent WAIT leg if applicable.
    let target = null;
    if (i - 1 >= 0 && !hidden.has(i - 1) && isWaitSegment(segs[i - 1])) target = i - 1;
    else if (i + 1 < segs.length && !hidden.has(i + 1) && isWaitSegment(segs[i + 1])) target = i + 1;

    // 2) Previous TRANSIT leg.
    if (target == null) target = findPrev(i, isTransitSegment);

    // 3) Following TRANSIT leg.
    if (target == null) target = findNext(i, isTransitSegment);

    // Fallback: nearest non-hidden leg.
    if (target == null) target = findPrev(i, () => true) ?? findNext(i, () => true);

    if (target != null) {
      segs[target].durationSec = Number(segs[target].durationSec || 0) + mins * 60;
    }
  }

  return segs.filter((_, i) => !hidden.has(i) && Math.round(Number(segs[i]?.durationSec || 0) / 60) > 0);
}


function ItinBubble({ seg }) {
  const segRef = useRef(null);
  const glyphRef = useRef(null);
  const labelMeasureRef = useRef(null);
  const minsMeasureRef = useRef(null);

  const isTransit = seg?.kind === "TRANSIT" || String(seg?.mode || "").toUpperCase() === "TRANSIT";
  const label = isTransit ? String(seg?.label || "").trim() : "";
  const mins = Math.max(0, Math.round(Number(seg?.durationSec || 0) / 60));
  const minsText = `${mins}m`;

  const [showLabel, setShowLabel] = useState(false);
  const [showMins, setShowMins] = useState(true);

  useEffect(() => {
    const el = segRef.current;
    const glyphEl = glyphRef.current;
    const labelMeasEl = labelMeasureRef.current;
    const minsMeasEl = minsMeasureRef.current;
    if (!el || !glyphEl || !minsMeasEl) return;

    const recompute = () => {
      const segW = el.clientWidth || 0;
      const glyphW = glyphEl.offsetWidth || 0;
      const minsW = minsMeasEl.offsetWidth || 0;
      const labelW = labelMeasEl ? (labelMeasEl.offsetWidth || 0) : 0;

      const cs = window.getComputedStyle(el);
      const padL = parseFloat(cs.paddingLeft || "0") || 0;
      const padR = parseFloat(cs.paddingRight || "0") || 0;
      const gap = parseFloat(cs.columnGap || cs.gap || "6") || 6;

      const available = Math.max(0, segW - padL - padR - 2);

      // Only show minutes if (emoji + minutes) can fit.
      const canShowMins = minsW > 0 && (glyphW + minsW + gap) <= available;
      setShowMins(canShowMins);

      // Transit label is optional and must fit with whatever else is showing.
      if (isTransit && label && labelMeasEl) {
        const req = glyphW + labelW + (canShowMins ? minsW : 0) + gap * (canShowMins ? 2 : 1);
        setShowLabel(labelW > 0 && req <= available);
      } else {
        setShowLabel(false);
      }
    };

    let raf = 0;
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
    };

    schedule();

    // Watch the segment and the measure spans. Emoji/text widths can change
    // after font loading without the segment's own width changing.
    const ro = new ResizeObserver(() => schedule());
    ro.observe(el);
    ro.observe(glyphEl);
    ro.observe(minsMeasEl);
    if (labelMeasEl) ro.observe(labelMeasEl);

    // Extra safety: run once after fonts settle.
    let cancelled = false;
    if (document?.fonts?.ready?.then) {
      document.fonts.ready.then(() => {
        if (!cancelled) schedule();
      });
    }

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [isTransit, label, minsText]);

  if (mins <= 0) return null;

  return (
    <div
      ref={segRef}
      className={styles.itinSeg}
      style={{
        flexGrow: Math.max(1, Number(seg?.durationSec || 0)),
        backgroundColor: seg?.bg,
        color: seg?.text,
      }}
      title={label ? `${label} · ${minsText}` : minsText}
    >
      {/* Requirement: route name (transit line) to the left of the emoji */}
      {isTransit && label && showLabel ? <span className={styles.itinLabel}>{label}</span> : null}

      <span ref={glyphRef} className={styles.itinGlyph} aria-hidden="true">
        {seg?.glyph}
      </span>

      {isTransit && label ? (
        <span
          ref={labelMeasureRef}
          className={`${styles.itinLabel} ${styles.itinLabelMeasure}`}
          aria-hidden="true"
        >
          {label}
        </span>
      ) : null}

      <span
        ref={minsMeasureRef}
        className={`${styles.itinText} ${styles.itinTextMeasure}`}
        aria-hidden="true"
      >
        {minsText}
      </span>

      {showMins ? <span className={styles.itinText}>{minsText}</span> : null}
    </div>
  );
}

function RouteCard({ option, selected, expanded, onSelect, onDetails, routeCombo }) {
  const allSegs = buildSidebarSegments(option, routeCombo);
  const segs = useMemo(() => carryHiddenMinuteMoves(allSegs), [allSegs]);

  const timeText = timeRangeTextForOption(option);
  const durationText = option?.durationText || "—";

  // Build a richer preview (expanded only).
  const previewLines = useMemo(() => {
    if (!expanded) return [];

    const model = buildRouteDetailsModel(option);
    const segs2 = carryHiddenMinuteMoves(model?.segments ?? []);
    if (!segs2.length) return [];

    const out = [];

    for (let i = 0; i < segs2.length; i++) {
      const s = segs2[i];
      const mins = Math.max(0, Math.round(Number(s.durationSec || 0) / 60));
      if (mins <= 0) continue;

      const dur = minutesText(s.durationSec);
      const mode = String(s.mode || "").toUpperCase();

      if (mode === "WAIT") {
        const at = s.at ? ` at ${s.at}` : "";
        out.push(`⏳ ${dur} • Wait${at}`);
        continue;
      }

      if (mode === "TRANSIT") {
        const t = s.transit || {};
        const veh = vehicleGlyphFromType(t.vehicle || "");
        const line = String(t.shortName || "Transit").trim();
        const modeWord = transitModeWordFromType(t.vehicle || "");
        const lineWithMode = line && line !== "Transit" && modeWord ? `${line} ${modeWord}` : line;
        const agency = shortTransitAgencyName(t.agency || "");

        // Requirement: show line/number first (with mode), then agency name.
        if (lineWithMode && agency && lineWithMode !== "Transit") out.push(`${veh} ${dur} • ${lineWithMode} • ${agency}`);
        else if (lineWithMode && lineWithMode !== "Transit") out.push(`${veh} ${dur} • ${lineWithMode}`);
        else if (agency) out.push(`${veh} ${dur} • ${agency}`);
        else out.push(`${veh} ${dur} • Transit`);
        continue;
      }

      // Non-transit move (walk/bike/skate)
      const meta = MODE_META[mode] || MODE_META.WALK;
      const emoji = meta?.dot || "🚶";
      const dist = formatDistanceMi(s.distanceMeters);
      const path = truncateText(extractPrimaryPathNameFromSteps(s.steps), 28);

      const distText = dist ? ` • ${dist}` : "";
      const pathText = path ? ` • ${path}` : "";
      out.push(`${emoji} ${dur}${distText}${pathText}`);
    }

    return out;
	  }, [expanded, option]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect?.();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={`${styles.routeCard} ${selected ? styles.routeCardSelected : ""}`}
    >
      <span className={`${styles.routeAccent} ${selected ? styles.routeAccentSelected : ""}`} />

      <div className={styles.routeCardInner}>
        <div className={styles.routeTopRow}>
          <div className={styles.routeTopLeft}>
            <div className={styles.routeDepArr}>{timeText}</div>
          </div>

          <div className={styles.routeTopRight}>
            <div className={styles.routeDurationBig}>{durationText}</div>
          </div>
        </div>

        {/* Visual itinerary bar only (relative widths) */}
        <div className={styles.itinBar}>
          {segs.map((s) => (
            <ItinBubble key={s.key} seg={s} />
          ))}
        </div>

        {expanded ? (
          <div className={styles.routeExpanded}>
            <div className={styles.previewListText}>
              {previewLines.map((line, i) => (
                <div key={i} className={styles.previewLine}>
                  {line}
                </div>
              ))}
            </div>
            <div className={styles.detailsRow}>
              <button
                type="button"
                className={styles.detailsBtn}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDetails?.();
                }}
              >
                Details
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}


function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M14.5 5.5L8 12l6.5 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M9.5 5.5L16 12l-6.5 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SwapIcon() {
  const stroke = 3; // thicker
  const stagger = 2.5; // more vertical stagger
  const xLeft = 6.25; // further left (more horizontal separation)
  const xRight = 17.75; // further right

  const yTop = 4.2; // keep a little margin so caps don't touch the circle
  const yBottom = 19.8;

  const head = 4; // arrowhead size
  const headInset = 4; // how "wide" the head spreads

  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      {/* Up arrow (left) — nudged UP */}
      <g transform={`translate(0,${-stagger})`}>
        <path
          d={`M${xLeft} ${yBottom} V${yTop}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        <path
          d={`M${xLeft} ${yTop} L${xLeft - headInset} ${yTop + head} M${xLeft} ${yTop} L${xLeft + headInset} ${yTop + head}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>

      {/* Down arrow (right) — nudged DOWN */}
      <g transform={`translate(0,${stagger})`}>
        <path
          d={`M${xRight} ${yTop} V${yBottom}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        <path
          d={`M${xRight} ${yBottom} L${xRight - headInset} ${yBottom - head} M${xRight} ${yBottom} L${xRight + headInset} ${yBottom - head}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

export default function DirectionsSidebar({
  canRenderMap,
  userLoc,
  setOrigin,
  destination,
  setDestination,

  routeCombo,
  setRouteCombo,

  hillMaxDeg,
  setHillMaxDeg,

  // transit time props from Landing
  timeKind,
  setTimeKind,
  timeValue,
  setTimeValue,

  onBuildRoute,
  onClearRoute,

  directionsPanelRef,
  directionsDirty = true,

  originPickerRef,
  destPickerRef,

  routeOptions = [],
  isLoadingRoutes = false,
  selectedRouteIndex = 0,
  onSelectRoute,
}) {
  const internalOriginRef = useRef(null);
  const internalDestRef = useRef(null);

  const originRef = originPickerRef ?? internalOriginRef;
  const destRef = destPickerRef ?? internalDestRef;

  // Track the latest resolved LatLngs so swap works even though <gmpx-place-picker>.value is readonly.
  const originLLRef = useRef(null);
  const destLLRef = useRef(null);

  useEffect(() => {
    destLLRef.current = destination ?? null;
  }, [destination]);

  useEffect(() => {
    if (userLoc && !originLLRef.current) originLLRef.current = userLoc;
  }, [userLoc]);

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage?.getItem(LS_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage?.setItem(LS_KEY, collapsed ? "1" : "0");
    } catch {
      // ignore
    }
  }, [collapsed]);

  const startIconUrl = getStartIconUrl();
  const endIconUrl = getEndIconUrl();

  // In FULL details mode we hide the top control stack (including the place pickers) but keep it mounted,
  // so the visible text/state doesn't "re-load" when returning from details.
  // We still snapshot the latest UI state for the FULL details header.
  const pickerSnapshotRef = useRef({
    originText: "",
    destText: "",
    originLL: null,
    destLL: null,
  });

  const snapshotPickers = useCallback(() => {
    const oEl = originRef.current;
    const dEl = destRef.current;
    if (oEl) {
      const v = oEl.value;
      pickerSnapshotRef.current.originText = getPickerText(oEl) || pickerSnapshotRef.current.originText;
      pickerSnapshotRef.current.originLL = placeToLatLng(v) || pickerSnapshotRef.current.originLL;
    }
    if (dEl) {
      const v = dEl.value;
      pickerSnapshotRef.current.destText = getPickerText(dEl) || pickerSnapshotRef.current.destText;
      pickerSnapshotRef.current.destLL = placeToLatLng(v) || pickerSnapshotRef.current.destLL;
    }
  }, [originRef, destRef]);

  const restorePickers = useCallback(async () => {
    const snap = pickerSnapshotRef.current;

    // Destination: we also have a canonical LatLng in props.
    const destLL = destination || snap.destLL;

    // UX: restore both fields in parallel so the values don't "load" one after another.
    // Also set snapshot text immediately to avoid blank fields while reverse-geocoding.
    const tasks = [];

    try {
      if (originRef.current) {
        const curText = (getPickerText(originRef.current) || "").trim();
        if (!curText) {
          if (snap.originText) forcePickerText(originRef.current, snap.originText);
          const ll = snap.originLL || userLoc || null;
          if (ll) tasks.push(populatePlacePickerFromLatLng(originRef.current, ll));
        }
      }

      if (destRef.current) {
        const curText = (getPickerText(destRef.current) || "").trim();
        if (!curText) {
          if (snap.destText) forcePickerText(destRef.current, snap.destText);
          if (destLL) tasks.push(populatePlacePickerFromLatLng(destRef.current, destLL));
        }
      }

      if (tasks.length) await Promise.all(tasks.map((p) => p.catch(() => {})));
    } catch {
      // best-effort only
    }
  }, [originRef, destRef, destination, userLoc]);

  useEffect(() => {
    if (!canRenderMap || !userLoc) return;

    const attrs = {
      "location-bias": `${userLoc.lat},${userLoc.lng}`,
      radius: "20000",
    };

    [originRef.current, destRef.current].forEach((el) => {
      if (!el) return;
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    });
  }, [canRenderMap, userLoc, originRef, destRef]);

  const handleOriginPlaceChange = useCallback(
    (e, originEl) => {
      const place = e?.target?.value ?? originEl.value;
      const ll = placeToLatLng(place);

      if (ll) {
        originLLRef.current = ll;
        setOrigin(ll);
        return;
      }

      // If the user cleared the field, fall back to user location (if available).
      const txt = (getPickerText(originEl) || "").trim();
      if (!txt) {
        const fallback = userLoc ?? null;
        originLLRef.current = fallback;
        if (fallback) setOrigin(fallback);
      }
    },
    [setOrigin, userLoc]
  );

  const handleDestPlaceChange = useCallback(
    (e, destEl) => {
      const place = e?.target?.value ?? destEl.value;
      const ll = placeToLatLng(place);

      if (ll) {
        destLLRef.current = ll;
        setDestination(ll);
        return;
      }

      // If the user cleared the destination field, clear destination state too.
      const txt = (getPickerText(destEl) || "").trim();
      if (!txt) {
        destLLRef.current = null;
        setDestination(null);
      }
    },
    [setDestination]
  );

  usePlacePickerChange(originRef, canRenderMap, handleOriginPlaceChange);
  usePlacePickerChange(destRef, canRenderMap, handleDestPlaceChange);

  const canShowRoutes = typeof onSelectRoute === "function";
  const showRoutes = canShowRoutes && (((routeOptions?.length ?? 0) >= 1) || isLoadingRoutes);

  const transitOn = isTransitOn(routeCombo);
  const bikeOn = isBikeOn(routeCombo);
  const skateOn = isSkateOn(routeCombo);

  const [detailsMode, setDetailsMode] = useState("NONE");

  const prevDetailsModeRef = useRef("NONE");
  useEffect(() => {
    const prev = prevDetailsModeRef.current;
    prevDetailsModeRef.current = detailsMode;

    // We keep the place pickers mounted (even in FULL details mode) and only hide them,
    // but still do a best-effort restore if either field is blank.
    if (detailsMode === "NONE" && prev !== "NONE") {
      const oEl = originRef.current;
      const dEl = destRef.current;

      const oText = oEl ? (getPickerText(oEl) || "").trim() : "";
      const dText = dEl ? (getPickerText(dEl) || "").trim() : "";

      const needsRestore = !oEl || !dEl || !oText || !dText;
      if (!needsRestore) return;

      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => restorePickers());
      } else {
        setTimeout(() => restorePickers(), 0);
      }
    }
  }, [detailsMode, restorePickers, originRef, destRef]);

  const resultsScrollRef = useRef(null);
  const inlineDetailsRef = useRef(null);

  useEffect(() => {
    if ((routeOptions?.length ?? 0) === 0) setDetailsMode("NONE");
  }, [routeOptions]);

  const selectedOption = useMemo(() => {
    if (!routeOptions || routeOptions.length === 0) return null;
    return routeOptions.find((o) => o.index === selectedRouteIndex) || routeOptions[0] || null;
  }, [routeOptions, selectedRouteIndex]);

  const detailsRouteModel = useMemo(() => buildRouteDetailsModel(selectedOption), [selectedOption]);

  const detailsRouteModelDisplay = useMemo(() => {
    if (!detailsRouteModel) return null;
    const segs = carryHiddenMinuteMovesExceptEnds(detailsRouteModel.segments ?? []);
    return { ...detailsRouteModel, segments: segs };
  }, [detailsRouteModel]);

  useLayoutEffect(() => {
    if (detailsMode !== "INLINE") return;

    const container = resultsScrollRef.current;
    const content = inlineDetailsRef.current;
    if (!container || !content) return;

    const check = () => {
      const fits = content.scrollHeight <= container.clientHeight + 2;
      if (!fits) {
        snapshotPickers();
        setDetailsMode("FULL");
      }
    };

    if (typeof requestAnimationFrame === "function") requestAnimationFrame(check);
    else check();

    const ro = new ResizeObserver(() => check());
    ro.observe(container);
    ro.observe(content);
    return () => ro.disconnect();
  }, [detailsMode, selectedRouteIndex, selectedOption, detailsRouteModelDisplay, snapshotPickers]);
  const handleSwap = useCallback(async () => {
    const oEl = originRef.current;
    const dEl = destRef.current;

    // Prefer our tracked LatLngs so swap works even though <gmpx-place-picker>.value is readonly
    // (and can lag behind the visible text).
    const currentOriginLL =
      originLLRef.current ?? placeToLatLng(oEl?.value) ?? userLoc ?? null;

    const currentDestLL =
      destLLRef.current ?? destination ?? placeToLatLng(dEl?.value) ?? null;

    if (!currentDestLL) return;

    // Snapshot labels BEFORE touching inputs.
    const snap = pickerSnapshotRef.current;
    const originText = (oEl ? getPickerText(oEl) : "") || snap.originText || "";
    const destText = (dEl ? getPickerText(dEl) : "") || snap.destText || "";

    // Update refs immediately so a fast double-click swaps back correctly.
    originLLRef.current = currentDestLL;
    destLLRef.current = currentOriginLL;

    setOrigin(currentDestLL);
    if (currentOriginLL) setDestination(currentOriginLL);
    else setDestination(null);

    // Only do an instant swap when we actually have labels; otherwise we rely on populate.
    if (oEl && destText) forcePickerText(oEl, destText);
    if (dEl && originText) forcePickerText(dEl, originText);

    const tasks = [];
    if (oEl) tasks.push(populatePlacePickerFromLatLng(oEl, currentDestLL));
    if (dEl) {
      if (currentOriginLL) tasks.push(populatePlacePickerFromLatLng(dEl, currentOriginLL));
      else forcePickerText(dEl, "");
    }

    if (tasks.length) await Promise.all(tasks.map((p) => p.catch(() => {})));
  }, [originRef, destRef, destination, setOrigin, setDestination, userLoc]);

  // Keep our snapshot reasonably fresh during normal usage.
  useEffect(() => {
    if (detailsMode !== "NONE") return;
    snapshotPickers();
  }, [detailsMode, destination, userLoc, snapshotPickers]);

  // Keep the visible datetime box set to “now” when Leave now is selected.
  useEffect(() => {
    if (timeKind === "NOW") {
      setTimeValue(new Date());
    }
  }, [timeKind, setTimeValue]);

  // --- datetime-local helpers (local timezone, matches browser behavior) ---
  function toDatetimeLocalValue(d) {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");

    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const min = pad(d.getMinutes());

    return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
  }

  function fromDatetimeLocalValue(s) {
    if (!s) return null;
    const [datePart, timePart] = s.split("T");
    if (!datePart || !timePart) return null;

    const [y, m, d] = datePart.split("-").map(Number);
    const [hh, mm] = timePart.split(":").map(Number);

    if (![y, m, d, hh, mm].every(Number.isFinite)) return null;

    return new Date(y, m - 1, d, hh, mm, 0, 0);
  }

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.sidebarCollapsed : ""}`}>
      <button
        type="button"
        className={styles.collapseNub}
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? "Expand directions sidebar" : "Collapse directions sidebar"}
        title={collapsed ? "Expand" : "Collapse"}
      >
        <span className={styles.collapseNubIcon} aria-hidden="true">
          {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
        </span>
      </button>

                  <div className={styles.sidebarBody}>
        <div
          className={`${styles.topControls} ${detailsMode === "FULL" ? styles.topControlsHidden : ""}`}
          aria-hidden={detailsMode === "FULL"}
        >
          <div className={styles.modeBar}>
            <div className={styles.modeRow}>
              <button
                type="button"
                className={`${styles.modeBtn} ${transitOn ? styles.modeBtnOn : ""}`}
                onClick={() => setRouteCombo((c) => nextCombo(c, "TRANSIT"))}
                aria-pressed={transitOn}
                aria-label="Transit"
                title="Transit"
              >
                <span
                  className={styles.modeEmoji}
	                  style={{ "--emoji-scale": 1.0, "--emoji-y": "0px" }}
                  aria-hidden="true"
                >
                  🚉
                </span>
              </button>

              <button
                type="button"
                className={`${styles.modeBtn} ${bikeOn ? styles.modeBtnOn : ""}`}
                onClick={() => setRouteCombo((c) => nextCombo(c, "BIKE"))}
                aria-pressed={bikeOn}
                aria-label="Bike"
                title="Bike"
              >
                <span
                  className={styles.modeEmoji}
	                  style={{ "--emoji-scale": 1.18, "--emoji-y": "2px" }}
                  aria-hidden="true"
                >
                  🚲
                </span>
              </button>

              <button
                type="button"
                className={`${styles.modeBtn} ${skateOn ? styles.modeBtnOn : ""}`}
                onClick={() => setRouteCombo((c) => nextCombo(c, "SKATE"))}
                aria-pressed={skateOn}
                aria-label="Skate"
                title="Skate"
              >
                <span
                  className={styles.modeEmoji}
	                  style={{ "--emoji-scale": 1.08, "--emoji-y": "1px" }}
                  aria-hidden="true"
                >
                  🛹
                </span>
              </button>
            </div>
          </div>

          <div className={styles.inputsCard}>
            <div className={styles.inputRow}>
              <img className={styles.inputMarker} src={startIconUrl} alt="" aria-hidden="true" />
              <div className={styles.pickerWrap}>
                <gmpx-place-picker ref={originRef} for-map="map" placeholder="Choose origin" />
              </div>
            </div>

            <button
              type="button"
              className={styles.swapBtn}
              onClick={handleSwap}
              aria-label="Swap origin and destination"
              title="Swap"
              disabled={!destination && !placeToLatLng(destRef.current?.value)}
            >
              <SwapIcon />
            </button>

            <div className={styles.inputRow}>
              <img className={styles.inputMarker} src={endIconUrl} alt="" aria-hidden="true" />
              <div className={styles.pickerWrap}>
                <gmpx-place-picker ref={destRef} for-map="map" placeholder="Choose destination" />
              </div>
            </div>
          </div>

          {/* ---- Transit time options (below inputs, above hills) ---- */}
          <div className={styles.field}>
            <div className={styles.timeRow}>
              <select
                className={styles.timeSelect}
                value={timeKind}
                onChange={(e) => {
                  const next = e.target.value;
                  setTimeKind(next);

                  // Seed a sensible value if switching away from NOW and current value is invalid.
                  if (
                    next !== "NOW" &&
                    (!(timeValue instanceof Date) || Number.isNaN(timeValue.getTime()))
                  ) {
                    setTimeValue(new Date());
                  }

                  // If switching to NOW, refresh the displayed time immediately.
                  if (next === "NOW") {
                    setTimeValue(new Date());
                  }
	                }}
                disabled={!transitOn}
              >
                <option value="NOW">Leave now</option>
                <option value="DEPART_AT">Depart at</option>
                <option value="ARRIVE_BY">Arrive by</option>
              </select>

              <input
                className={styles.timeInput}
                type="datetime-local"
                value={toDatetimeLocalValue(timeValue)}
                onChange={(e) => {
                  const d = fromDatetimeLocalValue(e.target.value);
                  if (d) setTimeValue(d);
	                }}
                disabled={!transitOn || timeKind === "NOW"}
                title={
                  timeKind === "NOW"
                    ? "Current time (Leave now)"
                    : "Select date and time"
                }
              />
            </div>
          </div>

          <div className={styles.field}>
            <div className={styles.labelRow}>
              <div className={styles.label}>Avoid hills</div>
              <div className={styles.hillValue}>{Math.round(hillMaxDeg ?? 25)}°</div>
            </div>
            <input
              className={styles.slider}
              type="range"
              min="0"
              max="25"
              step="1"
              value={Math.round(hillMaxDeg ?? 25)}
              onChange={(e) => setHillMaxDeg(Number(e.target.value))}
            />
            <div className={styles.hint}>Lower values avoid steeper inclines. 25° covers very steep city streets.</div>
          </div>


          <div className={styles.actions}>
            <button
              className={`${styles.primaryBtn} ${!directionsDirty ? styles.primaryBtnDrained : ""}`}
              onClick={onBuildRoute}
              disabled={!destination}
              type="button"
            >
              Get directions
            </button>
            <button className={styles.secondaryBtn} onClick={onClearRoute} type="button">
              Clear
            </button>
          </div>

        
        </div>

        {detailsMode === "FULL" && selectedOption && detailsRouteModelDisplay ? (
        <div className={styles.detailsFullScroll}>
                    <div className={styles.detailsPane}>
                      <div className={styles.detailsStickyStack}>
                        {/* In FULL details mode (top controls hidden), show origin/destination at the very top of the sidebar in its own element. */}
                        <div className={styles.detailsODCard}>
                          <div className={styles.detailsOD}>
                            <div className={styles.detailsODRow}>
                              <span className={styles.detailsODLabel}>From</span>
                              <span className={styles.detailsODText}>
                                {(pickerSnapshotRef.current?.originText || "").trim() || "—"}
                              </span>
                            </div>
                            <div className={styles.detailsODRow}>
                              <span className={styles.detailsODLabel}>To</span>
                              <span className={styles.detailsODText}>
                                {(pickerSnapshotRef.current?.destText || "").trim() || "—"}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className={`${styles.detailsHeader} ${styles.detailsHeaderInStack}`}>
                          <div className={styles.detailsHeaderTop}>
                            <button
                              type="button"
                              className={styles.backBtn}
                              onClick={() => setDetailsMode("NONE")}
                              aria-label="Back"
                            >
                              <BackIcon />
                            </button>

                            <div className={styles.detailsTopRow}>
                              <div className={styles.detailsTimes}>{timeRangeTextForOption(selectedOption)}</div>
                              <div className={styles.detailsDuration}>{selectedOption.durationText || "—"}</div>
                            </div>
                          </div>

                          <div className={styles.detailsItinBar}>
                            {carryHiddenMinuteMovesExceptEnds(buildSidebarSegments(selectedOption, routeCombo)).map((s) => (
                              <ItinBubble key={s.key} seg={s} />
                            ))}
                          </div>
                        </div>
                      </div>

                      <RouteDetails route={detailsRouteModelDisplay} hideTop />
                    </div>

                    <div ref={directionsPanelRef} className={styles.hiddenPanel} />
                  </div>
        ) : (
        <div ref={resultsScrollRef} className={styles.resultsScroll}>
                      {detailsMode === "INLINE" && selectedOption && detailsRouteModelDisplay ? (
                        <div ref={inlineDetailsRef} className={styles.inlineDetailsWrap}>
                          <div className={styles.detailsPane}>
                            <div className={styles.detailsHeader}>
          <div className={styles.detailsHeaderTop}>
            <button
                                type="button"
                                className={styles.backBtn}
                                onClick={() => setDetailsMode("NONE")}
                                aria-label="Back"
                              >
                              <BackIcon />
                            </button>

            <div className={styles.detailsTopRow}>
                                  <div className={styles.detailsTimes}>{timeRangeTextForOption(selectedOption)}</div>
                                  <div className={styles.detailsDuration}>{selectedOption.durationText || "—"}</div></div>
          </div>

          <div className={styles.detailsItinBar}>
                                  {carryHiddenMinuteMovesExceptEnds(buildSidebarSegments(selectedOption, routeCombo)).map((s) => (
                                    <ItinBubble key={s.key} seg={s} />
                                  ))}</div>
        </div>

                            <RouteDetails route={detailsRouteModelDisplay} hideTop />
                          </div>

                          <div ref={directionsPanelRef} className={styles.hiddenPanel} />
                        </div>
                      ) : (
                        <>
                          {showRoutes && (
                            <div className={styles.routesCards}>
                              <div className={styles.routesTitleRow}>
                                <div className={styles.routesTitle}>Routes</div>
                              </div>

                              {isLoadingRoutes ? (
                                <div className={styles.routesLoading}>
                                  <div className={styles.routesSpinner} aria-hidden="true" />
                                  <div className={styles.routesLoadingText}>Loading routes…</div>
                                </div>
                              ) : (
                                <div className={styles.routeCardsList}>
                                  {routeOptions.map((r) => (
                                    <RouteCard
                                      key={r.index}
                                      option={r}
                                      routeCombo={routeCombo}
                                      selected={selectedRouteIndex === r.index}
                                      expanded={selectedRouteIndex === r.index}
                                      onSelect={() => {
                                        setDetailsMode("NONE");
                                        onSelectRoute?.(r.index);
                                      }}
                                      onDetails={() => {
                                        if (selectedRouteIndex !== r.index) onSelectRoute?.(r.index);
                                        const model = buildRouteDetailsModel(r);
                                        if (!model) return;
                                        setDetailsMode("INLINE");
                                      }}
                                    />
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          <div ref={directionsPanelRef} className={styles.hiddenPanel} />
                        </>
                      )}
                    </div>
        )}
</div>

    </aside>
  );
}
