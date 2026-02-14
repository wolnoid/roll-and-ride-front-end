import { useEffect, useRef, useState } from "react";
import {
  extractViaPointsFromRoute,
  summarizeDirectionsRoutes,
} from "../maps/directionsUtils";
import {
  createDetourIcon,
  createEndIcon,
  createStartIcon,
} from "../maps/markerIcons";
import { populatePlacePickerFromLatLng } from "../maps/placePicker";
import {
  disposeAnyMarker,
  latLngToNums,
  toLatLngLiteral,
} from "../maps/googleUtils";

import { ROUTE_COMBO } from "../routing/routeCombos";
import {
  buildHybridOptions,
  refineSkateSegmentsWithElevation,
  polylineStyleForMode,
  HYBRID_STYLES,
} from "../routing/hybridPlanner";

function haversineMeters(a, b) {
  const A = latLngToNums(a);
  const B = latLngToNums(b);
  if (!A || !B) return Infinity;

  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(B.lat - A.lat);
  const dLng = toRad(B.lng - A.lng);
  const lat1 = toRad(A.lat);
  const lat2 = toRad(B.lat);

  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function routeDistanceMeters(route) {
  const legs = route?.legs ?? [];
  return legs.reduce((sum, l) => sum + (l?.distance?.value ?? 0), 0);
}

export function useRouting({
  enabled,
  map,
  panelRef,

  originRef,
  destinationRef,
  travelModeRef,
  userLocRef,
  routeComboRef,
  hillMaxDegRef,
  transitTimeRef,

  setOrigin,
  setDestination,

  originPickerRef,
  destPickerRef,

  markFromPicked,
  fallbackCenter,
}) {
  const serviceRef = useRef(null);
  const rendererRef = useRef(null);

  const fullDirectionsRef = useRef(null);
  const viaPointsRef = useRef([]);

  const markersRef = useRef({ start: null, end: null, vias: [] });
  const iconsRef = useRef({ detour: null, start: null, end: null });

  // Alternate route polylines (we draw these ourselves)
  const altPolylinesRef = useRef([]);
  const altPolylineListenersRef = useRef([]);

  // Primary route polylines (we draw these ourselves; DirectionsRenderer is kept mostly for panel + dragging)
  const primaryPolylinesRef = useRef([]);

  // Hybrid map overlays
  const hybridPolylinesRef = useRef([]);
  const hybridAltPolylinesRef = useRef([]);
  const hybridAltListenersRef = useRef([]);
  const hybridStopMarkersRef = useRef([]);
  const hybridOptionsRef = useRef(null);

  // Draggable first/last micro-leg renderers (hybrid modes)
  const microFirstRendererRef = useRef(null);
  const microLastRendererRef = useRef(null);
  const microFirstListenerRef = useRef(null);
  const microLastListenerRef = useRef(null);
  const microProgrammaticRef = useRef({ first: false, last: false });
  const microSegIndexRef = useRef({ first: -1, last: -1 });
  const microViaPointsRef = useRef({ first: [], last: [] });
  const microViaMarkersRef = useRef({ first: [], last: [] });
  const microRefineTimersRef = useRef({ first: null, last: null });
  const hybridReplanInFlightRef = useRef(false);

  const [selectedSegments, setSelectedSegments] = useState(null);
  const [showGooglePanel, setShowGooglePanel] = useState(true);

  const [routeOptions, setRouteOptions] = useState([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const selectedIdxRef = useRef(0);

  // When we call setDirections ourselves, ignore the next directions_changed
  const programmaticUpdateRef = useRef(false);


  // Incremented for every route build/clear to cancel in-flight async work.
  const requestSeqRef = useRef(0);
  function bumpRequestSeq() {
    requestSeqRef.current += 1;
    return requestSeqRef.current;
  }
  function isStaleSeq(seq) {
    return seq !== requestSeqRef.current;
  }

  
  // True when there is an active route on-map (prevents late directions_changed from re-drawing after Clear)
  const hasActiveRouteRef = useRef(false);

useEffect(() => {
    selectedIdxRef.current = selectedRouteIndex;
  }, [selectedRouteIndex]);

  function getIcons() {
    if (!iconsRef.current.detour) iconsRef.current.detour = createDetourIcon();
    if (!iconsRef.current.start) iconsRef.current.start = createStartIcon();
    if (!iconsRef.current.end) iconsRef.current.end = createEndIcon();
    return iconsRef.current;
  }

  function clearAltPolylines() {
    altPolylineListenersRef.current.forEach((l) => {
      try {
        l?.remove?.();
      } catch {
        // ignore
      }
    });
    altPolylineListenersRef.current = [];

    altPolylinesRef.current.forEach((p) => {
      try {
        p.setMap(null);
      } catch {
        // ignore
      }
    });
    altPolylinesRef.current = [];
  }

  function clearPrimaryPolylines() {
    primaryPolylinesRef.current.forEach((p) => {
      try {
        p.setMap(null);
      } catch {
        // ignore
      }
    });
    primaryPolylinesRef.current = [];
  }

  function clearHybridOverlays({ resetState = true } = {}) {
    // listeners
    hybridAltListenersRef.current.forEach((l) => {
      try {
        l?.remove?.();
      } catch {
        // ignore
      }
    });
    hybridAltListenersRef.current = [];

    // polylines
    [...hybridPolylinesRef.current, ...hybridAltPolylinesRef.current].forEach((p) => {
      try {
        p?.setMap?.(null);
      } catch {
        // ignore
      }
    });
    hybridPolylinesRef.current = [];
    hybridAltPolylinesRef.current = [];

    // stop markers
    hybridStopMarkersRef.current.forEach((m) => disposeAnyMarker(m));
    hybridStopMarkersRef.current = [];

    // draggable micro renderers + detour markers
    ["first", "last"].forEach((k) => {
      try {
        const t = microRefineTimersRef.current[k];
        if (t) clearTimeout(t);
      } catch {
        // ignore
      }
      microRefineTimersRef.current[k] = null;

      microViaMarkersRef.current[k].forEach((m) => disposeAnyMarker(m));
      microViaMarkersRef.current[k] = [];
      microViaPointsRef.current[k] = [];
      microSegIndexRef.current[k] = -1;

      const r = k === "first" ? microFirstRendererRef.current : microLastRendererRef.current;
      const l = k === "first" ? microFirstListenerRef.current : microLastListenerRef.current;
      try {
        l?.remove?.();
      } catch {
        // ignore
      }
      if (k === "first") microFirstListenerRef.current = null;
      else microLastListenerRef.current = null;

      try {
        r?.setDirections?.(null);
      } catch {
        // ignore
      }
      try {
        r?.setMap?.(null);
      } catch {
        // ignore
      }
      if (k === "first") microFirstRendererRef.current = null;
      else microLastRendererRef.current = null;
    });

    hybridReplanInFlightRef.current = false;

    if (resetState) {
      hybridOptionsRef.current = null;
      setSelectedSegments(null);
      setShowGooglePanel(true);
    }
  }

  function clearRouteMarkers() {
    const m = markersRef.current;
    disposeAnyMarker(m.start);
    disposeAnyMarker(m.end);
    m.vias.forEach(disposeAnyMarker);
    markersRef.current = { start: null, end: null, vias: [] };
    viaPointsRef.current = [];
  }

  function clearAlternativesState() {
    clearAltPolylines();
    setRouteOptions([]);
    setSelectedRouteIndex(0);
    selectedIdxRef.current = 0;
    fullDirectionsRef.current = null;
  }

  /**
   * Adaptive fitBounds:
   * - Avoid hard-coded left padding that destroys zoom on narrow maps.
   * - Only apply big left padding if the sidebar overlays the map (map starts near left edge).
   * - Clamp padding as a fraction of current map width.
   */
  function fitAllRoutesInView(directions, selectedIdx = 0) {
    if (!map) return;

    const routes = directions?.routes ?? [];
    if (!routes.length) return;

    const mapDiv = map.getDiv?.();
    const rect = mapDiv?.getBoundingClientRect?.();
    const mapW = rect?.width ?? 800;

    // Base padding scales with map width (24–60px)
    const basePad = Math.max(24, Math.min(60, Math.round(mapW * 0.08)));

    // If the map starts near the window left edge, sidebar is probably overlaying the map.
    const sidebarLikelyOverlaying = (rect?.left ?? 9999) < 40;

    // If overlay: allow larger left pad but clamp hard so half-screen doesn’t explode.
    // If NOT overlay (your flex layout): keep left pad small.
    const leftPad = sidebarLikelyOverlaying
      ? Math.max(basePad, Math.min(380, Math.round(mapW * 0.35)))
      : basePad;

    const padding = { top: basePad, right: basePad, bottom: basePad, left: leftPad };

    // Outlier rejection (avoid random far-away points widening bounds)
    const selectedRoute = routes[selectedIdx] ?? routes[0];
    const approxMeters = routeDistanceMeters(selectedRoute) || 0;

    const startLL = toLatLngLiteral(selectedRoute?.legs?.[0]?.start_location);
    const endLL = toLatLngLiteral(
      selectedRoute?.legs?.[(selectedRoute?.legs?.length ?? 1) - 1]?.end_location
    );

    const outlierThreshold =
      approxMeters > 0 ? Math.max(approxMeters * 2.0, 100000) : 200000; // 100km min

    const bounds = new window.google.maps.LatLngBounds();
    let hasAny = false;

    for (const r of routes) {
      const path = r?.overview_path;
      if (!path?.length) continue;

      for (const p of path) {
        const n = latLngToNums(p);
        if (!n) continue;
        if (Math.abs(n.lat) > 89.999 || Math.abs(n.lng) > 180) continue;

        if (startLL && endLL) {
          const d1 = haversineMeters(n, startLL);
          const d2 = haversineMeters(n, endLL);
          if (d1 > outlierThreshold && d2 > outlierThreshold) continue;
        }

        bounds.extend(n);
        hasAny = true;
      }
    }

    if (!hasAny && startLL && endLL) {
      bounds.extend(startLL);
      bounds.extend(endLL);
      hasAny = true;
    }
    if (!hasAny) return;

    map.fitBounds(bounds, padding);

    // Clamp “too far out” for short-ish trips, especially on narrow maps
    if (approxMeters > 0 && approxMeters < 250000) {
      const minZoom = mapW < 700 ? 10 : 9;

      const once = window.google.maps.event.addListenerOnce(map, "idle", () => {
        try {
          const z = map.getZoom?.();
          if (Number.isFinite(z) && z < minZoom) map.setZoom(minZoom);
        } catch {
          // ignore
        }
      });

      setTimeout(() => {
        try {
          once?.remove?.();
        } catch {
          // ignore
        }
      }, 5000);
    }
  }

  // ---------------------------
  // Primary route drawing (custom polylines)
  // ---------------------------

  function decodeStepPath(step) {
    try {
      return (
        step?.path ??
        window.google?.maps?.geometry?.encoding?.decodePath?.(step?.polyline?.points ?? "") ??
        []
      );
    } catch {
      return [];
    }
  }

  function routeHasTransitSteps(route) {
    const legs = route?.legs ?? [];
    for (const leg of legs) {
      const steps = leg?.steps ?? [];
      for (const s of steps) {
        if (s?.travel_mode === "TRANSIT") return true;
      }
    }
    return false;
  }

  // Transit details/line color are not always exposed on the same property name
  // across Maps JS API / Routes library versions. Be defensive.
  function getTransitDetailsFromStep(step) {
    return step?.transitDetails ?? step?.transit ?? step?.transit_details ?? null;
  }

  function normalizeHexColor(c) {
    if (!c) return null;

    if (typeof c === "string") {
      const s = c.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
      if (/^[0-9a-fA-F]{6}$/.test(s)) return "#" + s;
      if (/^0x[0-9a-fA-F]{6,8}$/.test(s)) {
        const hex = s.replace(/^0x/i, "");
        const rgb = hex.length === 8 ? hex.slice(2) : hex.slice(0, 6);
        return "#" + rgb;
      }
      // If it's already a valid CSS color name/rgb(), let Maps try to parse it.
      return s;
    }

    if (typeof c === "number") {
      const hex = c.toString(16).padStart(6, "0");
      return "#" + hex.slice(-6);
    }

    return null;
  }

  function getTransitLineColor(td, fallback = "#4285F4") {
    const line = td?.line ?? td?.transit_line ?? td?.transitLine ?? null;
    const raw =
      line?.color ??
      line?.color_hex ??
      line?.colorHex ??
      td?.lineColor ??
      td?.color ??
      null;

    return normalizeHexColor(raw) || fallback;
  }
  function dottedStyle({ color, scale = 2, repeat = "10px", strokeWeight = 8 }) {
    return {
      strokeOpacity: 0,
      strokeColor: color,
      strokeWeight,
      icons: [
        {
          icon: {
            path: window.google.maps.SymbolPath.CIRCLE,
            scale,
            strokeColor: color,
            strokeOpacity: 1,
          },
          offset: "0",
          repeat,
        },
      ],
    };
  }

  function drawPrimaryPolylinesFromRoute(route) {
    if (!map || !route) return;
    clearPrimaryPolylines();

    const combo = routeComboRef?.current ?? null;
    const travelMode = travelModeRef.current ?? "TRANSIT";
    const isTransit = travelMode === "TRANSIT" || routeHasTransitSteps(route);

    const zIndex = 30;

    if (isTransit) {
      const WALK_COLOR = "#5F6368"; // Google-ish gray for walking legs

      const legs = route?.legs ?? [];
      legs.forEach((leg) => {
        const steps = leg?.steps ?? [];
        steps.forEach((step) => {
          const mode = step?.travel_mode;
          const path = decodeStepPath(step);
          if (!path?.length) return;

          let polylineOptions = null;

          if (mode === "TRANSIT") {
            const td = getTransitDetailsFromStep(step);
            const lineColor = getTransitLineColor(td, DEFAULT_TRANSIT_BLUE);
            polylineOptions = {
              strokeColor: lineColor,
              strokeOpacity: 1,
              strokeWeight: 8,
            };
          } else if (mode === "WALKING") {
            polylineOptions = dottedStyle({ color: WALK_COLOR, scale: 2, repeat: "10px", strokeWeight: 8 });
          } else if (mode === "BICYCLING") {
            polylineOptions = { strokeColor: HYBRID_STYLES.GOOGLE_BLUE, strokeOpacity: 1, strokeWeight: 8 };
          } else {
            polylineOptions = { strokeColor: HYBRID_STYLES.GOOGLE_BLUE, strokeOpacity: 1, strokeWeight: 8 };
          }

          const poly = new window.google.maps.Polyline({
            map,
            path,
            clickable: false,
            ...polylineOptions,
            zIndex,
          });
          primaryPolylinesRef.current.push(poly);
        });
      });

      return;
    }

    // Non-transit: draw a single overview polyline.
    const path = route?.overview_path ?? [];
    if (!path?.length) return;

    let style = { strokeColor: HYBRID_STYLES.GOOGLE_BLUE, strokeOpacity: 1, strokeWeight: 8 };
    if (combo === ROUTE_COMBO.SKATE) style = polylineStyleForMode("SKATE", { isAlt: false });
    else if (travelMode === "WALKING") style = polylineStyleForMode("WALK", { isAlt: false });
    else if (travelMode === "BICYCLING") style = polylineStyleForMode("BIKE", { isAlt: false });

    const poly = new window.google.maps.Polyline({
      map,
      path,
      clickable: false,
      ...style,
      zIndex,
    });
    primaryPolylinesRef.current.push(poly);
  }

  function drawAlternatePolylines(fullDirections, selectedIdx) {
    if (!map) return;

    clearAltPolylines();

    const routes = fullDirections?.routes ?? [];
    if (routes.length <= 1) return;

    // Styling for alternates (lighter blue, consistent)
    const ALT_COLOR = HYBRID_STYLES.ALT_GRAY;
    const ALT_OPACITY = 0.35;
    const ALT_WEIGHT = 6;

    routes.forEach((r, idx) => {
      if (idx === selectedIdx) return;
      const path = r?.overview_path;
      if (!path?.length) return;

      const poly = new window.google.maps.Polyline({
        map,
        path,
        clickable: true,
        strokeColor: ALT_COLOR,
        strokeOpacity: ALT_OPACITY,
        strokeWeight: ALT_WEIGHT,
        zIndex: 5,
      });

      const listener = poly.addListener("click", () => {
        selectRoute(idx);
      });

      altPolylinesRef.current.push(poly);
      altPolylineListenersRef.current.push(listener);
    });
  }

  // ---------------------------
  // Hybrid route drawing (custom polylines)
  // ---------------------------

  const DEFAULT_TRANSIT_BLUE = "#4285F4";


  // --- Hybrid micro-leg helpers ---
  const BIKE_MPH_ASSUMED = 10;
  const WALK_MPH_ASSUMED = 3;
  const SKATE_MPH_FLAT = 6;

  function fmtDurationSec(sec) {
    const s = Math.max(0, Math.round(sec ?? 0));
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    if (h > 0) return h + " hr " + m + " min";
    return m + " min";
  }

  function getFirstLastMicroSegIndices(option) {
    const segs = option?.segments ?? [];
    const microIdxs = [];
    for (let i = 0; i < segs.length; i++) {
      const m = segs[i]?.mode;
      if (m === "WALK" || m === "BIKE" || m === "SKATE") microIdxs.push(i);
    }
    if (!microIdxs.length) return { first: -1, last: -1 };
    return { first: microIdxs[0], last: microIdxs[microIdxs.length - 1] };
  }

  function asSingleResult(res, route) {
    if (!res || !route) return null;
    return { ...res, routes: [route] };
  }

  function skateSecondsFromBase(seg, baseSec) {
    if (!Number.isFinite(baseSec)) return baseSec;
    const geom = seg?.skateGeometryMode;
    if (geom === "WALKING") return baseSec * (WALK_MPH_ASSUMED / SKATE_MPH_FLAT);
    return baseSec * (BIKE_MPH_ASSUMED / SKATE_MPH_FLAT);
  }

  function microLegTravelMode(seg) {
    if (!seg) return "WALKING";
    if (seg.mode === "WALK") return "WALKING";
    if (seg.mode === "BIKE") return "BICYCLING";
    if (seg.mode === "SKATE") return seg.skateGeometryMode === "WALKING" ? "WALKING" : "BICYCLING";
    return "WALKING";
  }

  function getStepPath(step) {
    const p = step?.path;
    if (Array.isArray(p) && p.length) return p;
    const pts = step?.polyline?.points;
    if (pts && window.google?.maps?.geometry?.encoding?.decodePath) {
      try {
        return window.google.maps.geometry.encoding.decodePath(pts);
      } catch {
        // ignore
      }
    }
    return [];
  }

  function optionCombinedPath(option) {
    const path = [];
    const segs = option?.segments ?? [];
    segs.forEach((seg, segIdx) => {
      if (seg.mode === "WAIT") return;
      let segPath = [];
      if (seg.mode === "TRANSIT") {
        segPath = getStepPath(seg.step);
      } else {
        segPath = seg.route?.overview_path ?? [];
      }
      if (!segPath?.length) return;
      if (!path.length) {
        path.push(...segPath);
      } else {
        // Avoid duplicating the join point
        path.push(...segPath.slice(1));
      }
    });
    return path;
  }

  function drawHybridStopsForOption(option) {
    const seen = new Set();
    const addStop = (stop, strokeColor) => {
      const ll = toLatLngLiteral(stop?.location);
      if (!ll) return;
      const key = `${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}`;
      if (seen.has(key)) return;
      seen.add(key);

      const marker = new window.google.maps.Marker({
        map,
        position: ll,
        zIndex: 999980,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 5,
          fillColor: "#FFFFFF",
          fillOpacity: 1,
          strokeColor: strokeColor ?? DEFAULT_TRANSIT_BLUE,
          strokeOpacity: 1,
          strokeWeight: 2,
        },
        title: stop?.name ?? "Stop",
      });

      hybridStopMarkersRef.current.push(marker);
    };

    (option?.segments ?? []).forEach((seg) => {
      if (seg.mode !== "TRANSIT") return;
      const td = seg.transitDetails;
      const lineColor = getTransitLineColor(td, DEFAULT_TRANSIT_BLUE);
      addStop(td?.departure_stop, lineColor);
      addStop(td?.arrival_stop, lineColor);
    });
  }

  function drawHybridOption(option, { isAlt = false, zIndex = 2, skipMicroIndices = null } = {}) {
    const segs = option?.segments ?? [];
    segs.forEach((seg, segIdx) => {
      if (seg.mode === "WAIT") return;

      if (seg.mode === "TRANSIT") {
        const td = seg.transitDetails;
        const lineColor = getTransitLineColor(td, DEFAULT_TRANSIT_BLUE);
        const path = getStepPath(seg.step);
        if (!path.length) return;

        const poly = new window.google.maps.Polyline({
          map,
          path,
          clickable: false,
          strokeColor: isAlt ? HYBRID_STYLES.ALT_GRAY : lineColor,
          strokeOpacity: isAlt ? 0.35 : 1,
          strokeWeight: isAlt ? 6 : 8,
          zIndex,
        });
        (isAlt ? hybridAltPolylinesRef : hybridPolylinesRef).current.push(poly);
        return;
      }

      // Micro-mobility legs (walk / bike / skate)
      if (!isAlt && skipMicroIndices && skipMicroIndices.has(segIdx)) return;

      const path = seg.route?.overview_path ?? [];
      if (!path.length) return;
      const style = polylineStyleForMode(seg.mode, { isAlt });
      const poly = new window.google.maps.Polyline({
        map,
        path,
        clickable: false,
        ...style,
        zIndex,
      });
      (isAlt ? hybridAltPolylinesRef : hybridPolylinesRef).current.push(poly);
    });
  }

  function drawHybridAlternates(options, selectedIdx) {
    if (!map) return;

    // Remove existing alt overlays
    hybridAltListenersRef.current.forEach((l) => {
      try {
        l?.remove?.();
      } catch {
        // ignore
      }
    });
    hybridAltListenersRef.current = [];

    hybridAltPolylinesRef.current.forEach((p) => {
      try {
        p.setMap(null);
      } catch {
        // ignore
      }
    });
    hybridAltPolylinesRef.current = [];

    if (!options?.length || options.length <= 1) return;

    // Draw full alternates as continuous segments (no chunking/"connectors" that create spaghetti lines).
    options.forEach((opt, idx) => {
      if (idx === selectedIdx) return;

      const segs = opt?.segments ?? [];
      segs.forEach((seg) => {
        if (!seg || seg.mode === "WAIT") return;

        let path = [];
        let polyOptions = null;

        if (seg.mode === "TRANSIT") {
          path = getStepPath(seg.step);
          polyOptions = {
            strokeColor: HYBRID_STYLES.ALT_GRAY,
            strokeOpacity: 0.35,
            strokeWeight: 6,
          };
        } else {
          path = seg.route?.overview_path ?? [];
          polyOptions = polylineStyleForMode(seg.mode, { isAlt: true });
        }

        if (!path?.length || !polyOptions) return;

        const poly = new window.google.maps.Polyline({
          map,
          path,
          clickable: true,
          ...polyOptions,
          zIndex: 0,
        });

        const listener = poly.addListener("click", () => {
          selectRoute(idx);
        });

        hybridAltPolylinesRef.current.push(poly);
        hybridAltListenersRef.current.push(listener);
      });
    });
  }


  // ---------------------------
  // Hybrid: draggable first/last micro-legs + detour markers
  // ---------------------------

  function fmtDistanceMeters(m) {
    if (!Number.isFinite(m)) return "";
    const miles = m / 1609.344;
    if (miles < 0.1) return Math.round(m) + " m";
    if (miles < 10) return miles.toFixed(1) + " mi";
    return Math.round(miles) + " mi";
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

  function maxDate(a, b) {
    if (a && b) return a > b ? a : b;
    return a ?? b ?? null;
  }

  function itineraryForSidebar(option) {
    const segs = option?.segments ?? [];
    return segs.map((seg) => {
      // More Google-like labels
      if (seg.mode === "TRANSIT") {
        const line = seg.transitDetails?.line;
        const name = line?.short_name || line?.name || "Transit";
        return { mode: name, durationText: fmtDurationSec(seg.seconds) };
      }
      if (seg.mode === "WAIT") {
        const stop = seg.atStop?.name;
        return { mode: stop ? "WAIT (" + stop + ")" : "WAIT", durationText: fmtDurationSec(seg.seconds) };
      }
      return { mode: seg.mode, durationText: fmtDurationSec(seg.seconds) };
    });
  }

  function rebuildWaitSegments(option, inputSegments) {
    const segs = inputSegments ?? option?.segments ?? [];
    const out = [];
    let totalSec = 0;
    let totalDist = 0;

    let currentTime = option?.departTime instanceof Date ? new Date(option.departTime) : null;

    for (const seg of segs) {
      if (!seg || seg.mode === "WAIT") continue;

      if (seg.mode === "TRANSIT") {
        const dep =
          coerceDate(seg.transitDetails?.departure_time) ??
          coerceDate(getTransitDetailsFromStep(seg.step)?.departure_time);

        // Determine when we actually start this transit segment in our stitched timeline.
        // If we arrive before the scheduled departure, we insert an explicit WAIT.
        // If we arrive after the scheduled departure, we assume we catch the next feasible run
        // (we don't re-query schedules yet), so we don't allow time to go backwards.
        let transitStart = currentTime;

        if (currentTime && dep) {
          if (currentTime < dep) {
            const waitSec = (dep.getTime() - currentTime.getTime()) / 1000;
            if (waitSec > 20) {
              out.push({ mode: "WAIT", seconds: waitSec, distanceMeters: 0, atStop: seg.transitDetails?.departure_stop });
              totalSec += waitSec;
            }
            transitStart = dep;
          } else {
            transitStart = currentTime;
          }
        }

        out.push(seg);
        totalSec += seg.seconds ?? 0;
        totalDist += seg.distanceMeters ?? 0;

        if (transitStart) {
          currentTime = new Date(transitStart.getTime() + (seg.seconds ?? 0) * 1000);
        }

        continue;
      }

      out.push(seg);
      totalSec += seg.seconds ?? 0;
      totalDist += seg.distanceMeters ?? 0;
      if (currentTime) currentTime = new Date(currentTime.getTime() + (seg.seconds ?? 0) * 1000);
    }

    const departTime = option?.departTime;
    const arriveTime = currentTime ?? option?.arriveTime;

    return {
      ...option,
      segments: out,
      durationSec: totalSec,
      distanceMeters: totalDist,
      arriveTime,
      durationText: fmtDurationSec(totalSec),
      distanceText: fmtDistanceMeters(totalDist),
    };

  }

  function getMinAllowedDepartTime() {
    const t = transitTimeRef?.current;
    const now = new Date();
    const dt = t?.date instanceof Date && !Number.isNaN(t.date.getTime()) ? t.date : null;
    if (t?.kind === "DEPART_AT" && dt) return dt;
    // ARRIVE_BY has no minimum requested depart time, but we still can’t depart in the past.
    return now;
  }

  function computeAccessSecondsToFirstTransit(segs) {
    let sec = 0;
    for (const s of segs ?? []) {
      if (!s || s.mode === "WAIT") continue;
      if (s.mode === "TRANSIT") break;
      sec += s.seconds ?? 0;
    }
    return sec;
  }

  function findFirstTransitDeparture(segs) {
    for (const s of segs ?? []) {
      if (!s || s.mode !== "TRANSIT") continue;
      const dep =
        coerceDate(s.transitDetails?.departure_time) ??
        coerceDate(getTransitDetailsFromStep(s.step)?.departure_time);
      return { dep, seg: s };
    }
    return { dep: null, seg: null };
  }

  function applyRecommendedDepartShift(option) {
    // Only meaningful if there is at least one TRANSIT segment with a scheduled departure.
    const segs = option?.segments ?? [];
    const { dep } = findFirstTransitDeparture(segs);
    if (!dep) return { option, missed: false, departTime: option?.departTime ?? null };

    const accessSec = computeAccessSecondsToFirstTransit(segs);
    const minAllowed = getMinAllowedDepartTime();

    // Recommended departure: arrive at the stop right at scheduled departure.
    const recommended = new Date(dep.getTime() - accessSec * 1000);

    // Respect user constraint (depart-now / depart-at) by clamping to minAllowed.
    const departTime = maxDate(minAllowed, recommended);

    const arrivalAtStop = new Date(departTime.getTime() + accessSec * 1000);
    const bufferMs = 30 * 1000;
    const missed = arrivalAtStop.getTime() > dep.getTime() + bufferMs;

    if (missed) {
      return { option, missed: true, departTime };
    }

    // Rebuild waits and totals from the shifted departure time.
    const shifted = rebuildWaitSegments({ ...option, departTime }, segs);
    return { option: shifted, missed: false, departTime };
  }

  function clearMicroDetourMarkers(which) {
    microViaMarkersRef.current[which].forEach((m) => disposeAnyMarker(m));
    microViaMarkersRef.current[which] = [];
  }

  async function rerouteMicroLegFromViaPoints(which, viaPoints) {
    const ds = serviceRef.current;
    if (!ds) return;
    const opts = hybridOptionsRef.current;
    const optIdx = selectedIdxRef.current;
    if (!opts?.length) return;

    const segIdx = microSegIndexRef.current[which];
    if (segIdx == null || segIdx < 0) return;

    const currentOpt = opts[optIdx];
    const seg = currentOpt?.segments?.[segIdx];
    if (!seg?.route) return;

    const leg0 = seg.route?.legs?.[0];
    const o = leg0?.start_location;
    const d = leg0?.end_location;
    if (!o || !d) return;

    const req = {
      origin: o,
      destination: d,
      travelMode: microLegTravelMode(seg),
      provideRouteAlternatives: false,
    };

    if (viaPoints?.length) {
      req.waypoints = viaPoints.map((p) => ({ location: p, stopover: false }));
      req.optimizeWaypoints = false;
    }

    const res = await ds.route(req);
    const route = res?.routes?.[0] ?? null;
    if (!route) return;

    // Update renderer programmatically
    const renderer = which === "first" ? microFirstRendererRef.current : microLastRendererRef.current;
    if (renderer) {
      microProgrammaticRef.current[which] = true;
      try {
        renderer.setDirections(asSingleResult(res, route));
      } catch {
        // ignore
      }
      setTimeout(() => (microProgrammaticRef.current[which] = false), 0);
    }

    // Update option + UI
    onMicroLegDirectionsChanged(which, res, route);
  }

  function syncMicroDetours(which, seg) {
    clearMicroDetourMarkers(which);

    const viaPts = seg?.route ? extractViaPointsFromRoute(seg.route) : [];
    microViaPointsRef.current[which] = viaPts;

    if (!viaPts?.length) return;

    const icons = getIcons();

    microViaMarkersRef.current[which] = viaPts.map((p, idx) => {
      const marker = new window.google.maps.Marker({
        map,
        position: p,
        draggable: true,
        zIndex: 999999,
        icon: icons.detour,
        cursor: "pointer",
      });

      marker.addListener("click", async () => {
        const next = microViaPointsRef.current[which].filter((_, i) => i !== idx);
        microViaPointsRef.current[which] = next;
        await rerouteMicroLegFromViaPoints(which, next);
      });

      marker.addListener("dragend", async (e) => {
        const ll = toLatLngLiteral(e?.latLng);
        if (!ll) return;
        const next = [...microViaPointsRef.current[which]];
        next[idx] = ll;
        microViaPointsRef.current[which] = next;
        await rerouteMicroLegFromViaPoints(which, next);
      });

      return marker;
    });
  }

  function updateHybridOptionsAtIndex(optIdx, nextOpt) {
    const cur = hybridOptionsRef.current;
    if (!cur?.length) return;
    const next = cur.map((o, i) => (i === optIdx ? { ...nextOpt, index: i } : o));
    hybridOptionsRef.current = next;
    setRouteOptions(next);
    setSelectedSegments(itineraryForSidebar(next[optIdx]));
  }

  function scheduleSkateRefine(which, optIdx, opt) {
    // Only refine for transit+skate routes and only after user settles (dragging can fire repeatedly).
    const seq = requestSeqRef.current;

    try {
      const t = microRefineTimersRef.current[which];
      if (t) clearTimeout(t);
    } catch {
      // ignore
    }

    microRefineTimersRef.current[which] = setTimeout(() => {
      if (isStaleSeq(seq)) return;

      refineSkateSegmentsWithElevation({ option: opt })
        .then((refined) => {
          if (isStaleSeq(seq)) return;
          if (!refined) return;
          // Rebuild waits after skate seconds change
          const rebuilt = rebuildWaitSegments(refined, refined.segments);
          updateHybridOptionsAtIndex(optIdx, rebuilt);
        })
        .catch(() => {});
    }, 650);
  }


  async function replanHybridAfterMissedDeparture({ departTime, preserveVia = true } = {}) {
    if (hybridReplanInFlightRef.current) return;
    hybridReplanInFlightRef.current = true;

    const seq = requestSeqRef.current;
    if (isStaleSeq(seq)) return;

    try {
      const ds = serviceRef.current;
      if (!ds) return;

      const origin = originRef.current ?? userLocRef?.current ?? fallbackCenter;
      const destination = destinationRef.current;
      if (!destination) return;

      const combo = routeComboRef?.current ?? null;
      if (combo !== ROUTE_COMBO.TRANSIT_BIKE && combo !== ROUTE_COMBO.TRANSIT_SKATE) return;

      const savedFirst = preserveVia ? [...(microViaPointsRef.current.first ?? [])] : [];
      const savedLast = preserveVia ? [...(microViaPointsRef.current.last ?? [])] : [];

      // Re-query transit alternatives starting at the (clamped) depart time from origin.
      const tOverride = { kind: "DEPART_AT", date: departTime instanceof Date ? departTime : new Date() };

      const options = await buildHybridOptions({
        ds,
        origin,
        destination,
        transitTime: tOverride,
        combo,
        maxOptions: 6,
      });

        if (isStaleSeq(seq)) return;

      if (!options?.length) return;

      // Replace options list and re-render selection.
      clearHybridMapOnly();
      hybridOptionsRef.current = options;
      setRouteOptions(options);

      await renderHybridSelection(0, { fitToRoutes: false, requestSeq: seq });
      if (isStaleSeq(seq)) return;

      // Re-apply user detours to first/last micro legs when reasonable.
      if (savedFirst.length) {
        microViaPointsRef.current.first = savedFirst;
        await rerouteMicroLegFromViaPoints("first", savedFirst);
        if (isStaleSeq(seq)) return;
      }
      if (savedLast.length) {
        microViaPointsRef.current.last = savedLast;
        await rerouteMicroLegFromViaPoints("last", savedLast);
        if (isStaleSeq(seq)) return;
      }

      // Elevation refinement for selected transit+skate option.
      if (combo === ROUTE_COMBO.TRANSIT_SKATE) {
        const opt = hybridOptionsRef.current?.[0];
        if (opt) {
          try {
            const refined = await refineSkateSegmentsWithElevation({ option: opt });
            if (isStaleSeq(seq)) return;
            if (refined) {
              const rebuilt = rebuildWaitSegments(refined, refined.segments);
              updateHybridOptionsAtIndex(0, rebuilt);
            }
          } catch {
            // ignore
          }
        }
      }
    } finally {
      hybridReplanInFlightRef.current = false;
    }
  }

  function onMicroLegDirectionsChanged(which, res, route) {
    const opts = hybridOptionsRef.current;
    const optIdx = selectedIdxRef.current;
    if (!opts?.length) return;

    const segIdx = microSegIndexRef.current[which];
    if (segIdx == null || segIdx < 0) return;

    const currentOpt = opts[optIdx];
    const segs = [...(currentOpt?.segments ?? [])];
    const oldSeg = segs[segIdx];

    const leg0 = route?.legs?.[0];
    const baseSec = leg0?.duration?.value ?? 0;
    const dist = leg0?.distance?.value ?? 0;

    let sec = baseSec;
    if (oldSeg?.mode === "SKATE") sec = skateSecondsFromBase(oldSeg, baseSec);

    segs[segIdx] = {
      ...oldSeg,
      seconds: sec,
      distanceMeters: dist,
      route,
      directionsResult: res,
    };


    // Refresh detour markers for this micro leg early so replans preserve the latest via-points
    syncMicroDetours(which, segs[segIdx]);

    let nextOpt = rebuildWaitSegments(currentOpt, segs);

    // For first-leg edits, shift the trip start time to minimize waiting at the first stop,
    // and replan transit if the dragged leg would miss a scheduled departure.
    if (which === "first") {
      const shifted = applyRecommendedDepartShift(nextOpt);
      if (shifted?.missed) {
        // Replan transit (next feasible run) starting at the earliest allowed departure time.
        replanHybridAfterMissedDeparture({ departTime: shifted.departTime, preserveVia: true }).catch(() => {});
        return;
      }
      nextOpt = shifted?.option ?? nextOpt;
    }

    updateHybridOptionsAtIndex(optIdx, nextOpt);

    if ((nextOpt?.segments ?? []).some((s) => s.mode === "SKATE")) {
      scheduleSkateRefine(which, optIdx, nextOpt);
    }
  }

  async function ensureMicroRenderer(which, mode, seq) {
    if (isStaleSeq(seq)) return null;
    const { DirectionsRenderer } = await window.google.maps.importLibrary("routes");
    if (isStaleSeq(seq)) return null;
    const style = polylineStyleForMode(mode, { isAlt: false });

    const isFirst = which === "first";
    const existing = isFirst ? microFirstRendererRef.current : microLastRendererRef.current;

    if (existing) {
      try {
        existing.setOptions?.({ polylineOptions: { ...style, zIndex: 40 } });
      } catch {
        // ignore
      }
      return existing;
    }

    const renderer = new DirectionsRenderer({
      map,
      draggable: true,
      suppressMarkers: true,
      preserveViewport: true,
      hideRouteList: true,
      polylineOptions: { ...style, zIndex: 40 },
    });

    const listener = renderer.addListener("directions_changed", () => {
      if (microProgrammaticRef.current[which]) return;
      const dir = renderer.getDirections?.();
      const r = dir?.routes?.[0];
      if (!r) return;
      onMicroLegDirectionsChanged(which, dir, r);
    });

    if (isFirst) {
      microFirstRendererRef.current = renderer;
      microFirstListenerRef.current = listener;
    } else {
      microLastRendererRef.current = renderer;
      microLastListenerRef.current = listener;
    }

    return renderer;
  }

  async function setMicroRendererDirections(which, seg, seq) {
    if (isStaleSeq(seq)) return;
    if (!seg?.route || !seg?.directionsResult) return;

    const renderer = await ensureMicroRenderer(which, seg.mode, seq);
    if (!renderer || isStaleSeq(seq)) return;

    const single = asSingleResult(seg.directionsResult, seg.route);
    if (!single || isStaleSeq(seq)) return;

    microProgrammaticRef.current[which] = true;
    try {
      renderer.setDirections(single);
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (!isStaleSeq(seq)) microProgrammaticRef.current[which] = false;
    }, 0);

    if (isStaleSeq(seq)) return;
    syncMicroDetours(which, seg);
  }

  function clearHybridMapOnly() {
    // Clear everything drawn for a specific hybrid selection, but keep the options list.
    clearHybridOverlays({ resetState: false });
  }

  async function renderHybridSelection(idx, { fitToRoutes = false, requestSeq = null } = {}) {
    const seq = requestSeq ?? requestSeqRef.current;
    if (isStaleSeq(seq)) return;
    const options = hybridOptionsRef.current;
    if (!options?.length) return;

    const maxIdx = options.length - 1;
    const clamped = Math.max(0, Math.min(idx, maxIdx));

    setSelectedRouteIndex(clamped);
    selectedIdxRef.current = clamped;

    clearHybridMapOnly();
    if (isStaleSeq(seq)) return;
    setShowGooglePanel(false);

    const opt = options[clamped];

    const { first, last } = getFirstLastMicroSegIndices(opt);
    microSegIndexRef.current.first = first;
    microSegIndexRef.current.last = last;

    const skip = new Set();
    if (first >= 0) skip.add(first);
    if (last >= 0 && last !== first) skip.add(last);

    // Draw everything except first/last micro legs (those use draggable renderers)
    drawHybridOption(opt, { isAlt: false, zIndex: 20, skipMicroIndices: skip });
    drawHybridStopsForOption(opt);
    drawHybridAlternates(options, clamped);

    // Draggable micro legs
    if (first >= 0) await setMicroRendererDirections("first", opt.segments[first], seq);
    if (isStaleSeq(seq)) return;
    if (last >= 0 && last !== first) await setMicroRendererDirections("last", opt.segments[last], seq);
    if (isStaleSeq(seq)) return;

    setSelectedSegments(itineraryForSidebar(opt));

    if (fitToRoutes) {
      requestAnimationFrame(() => {
        if (isStaleSeq(seq)) return;
        requestAnimationFrame(() => {
          if (isStaleSeq(seq)) return;
          try {
            const bounds = new window.google.maps.LatLngBounds();
            options.forEach((o) => {
              const p = optionCombinedPath(o);
              p?.forEach((pt) => bounds.extend(pt));
            });
            if (!bounds.isEmpty?.() || bounds.getNorthEast) {
              const mapDiv = map.getDiv?.();
              const rect = mapDiv?.getBoundingClientRect?.();
              const mapW = rect?.width ?? 800;
              const basePad = Math.max(24, Math.min(60, Math.round(mapW * 0.08)));
              map.fitBounds(bounds, { top: basePad, bottom: basePad, left: basePad, right: basePad });
            }
          } catch {
            // ignore
          }
        });
      });
    }
  }


  function ensureEndpointMarker({ currentMarker, position, icon, title, onDragEnd }) {
    if (!position) return currentMarker;

    if (!currentMarker) {
      const marker = new window.google.maps.Marker({
        map,
        position,
        draggable: true,
        zIndex: 999990,
        icon,
        title,
      });

      marker.addListener("dragend", async (e) => {
        const ll = toLatLngLiteral(e?.latLng);
        if (!ll) return;
        await onDragEnd(ll);
      });

      return marker;
    }

    currentMarker.setPosition(position);
    currentMarker.setIcon(icon);
    return currentMarker;
  }

  function syncMarkersFromRoute(route) {
    if (!map) return;

    const legs = route?.legs ?? [];
    if (!route || !legs.length) {
      clearRouteMarkers();
      return;
    }

    const icons = getIcons();

    const startPos = toLatLngLiteral(legs[0]?.start_location);
    const endPos = toLatLngLiteral(legs[legs.length - 1]?.end_location);

    markersRef.current.start = ensureEndpointMarker({
      currentMarker: markersRef.current.start,
      position: startPos,
      icon: icons.start,
      title: "Start",
      onDragEnd: async (ll) => {
        markFromPicked?.();
        setOrigin(ll);
        populatePlacePickerFromLatLng(originPickerRef.current, ll);

        await buildRoute({
          originOverride: ll,
          alternatives: true,
          fitToRoutes: true,
        });
      },
    });

    markersRef.current.end = ensureEndpointMarker({
      currentMarker: markersRef.current.end,
      position: endPos,
      icon: icons.end,
      title: "Destination",
      onDragEnd: async (ll) => {
        setDestination(ll);
        populatePlacePickerFromLatLng(destPickerRef.current, ll);

        await buildRoute({
          destinationOverride: ll,
          alternatives: true,
          fitToRoutes: true,
        });
      },
    });

    const viaPts = extractViaPointsFromRoute(route);
    viaPointsRef.current = viaPts;

    markersRef.current.vias.forEach(disposeAnyMarker);
    markersRef.current.vias = viaPts.map((p, idx) => {
      const marker = new window.google.maps.Marker({
        map,
        position: p,
        draggable: true,
        zIndex: 999999,
        icon: icons.detour,
        cursor: "pointer",
      });

      marker.addListener("click", async () => {
        const next = viaPointsRef.current.filter((_, i) => i !== idx);
        viaPointsRef.current = next;

        await rebuildWithoutAlternatives(next);
      });

      marker.addListener("dragend", async (e) => {
        const ll = toLatLngLiteral(e?.latLng);
        if (!ll) return;

        const next = [...viaPointsRef.current];
        next[idx] = ll;
        viaPointsRef.current = next;

        await rebuildWithoutAlternatives(next);
      });

      return marker;
    });
  }

  function syncMarkersFromEndpoints(origin, destination) {
    if (!map) return;
    const icons = getIcons();
    const startPos = toLatLngLiteral(origin);
    const endPos = toLatLngLiteral(destination);
    if (!startPos || !endPos) return;

    // Hybrid currently ignores via-point detours (they're tied to DirectionsRenderer).
    // We still keep draggable endpoints so users can adjust origin/destination.
    markersRef.current.vias.forEach(disposeAnyMarker);
    markersRef.current.vias = [];
    viaPointsRef.current = [];

    markersRef.current.start = ensureEndpointMarker({
      currentMarker: markersRef.current.start,
      position: startPos,
      icon: icons.start,
      title: "Start",
      onDragEnd: async (ll) => {
        markFromPicked?.();
        setOrigin(ll);
        populatePlacePickerFromLatLng(originPickerRef.current, ll);
        await buildRoute({ originOverride: ll, alternatives: true, fitToRoutes: true });
      },
    });

    markersRef.current.end = ensureEndpointMarker({
      currentMarker: markersRef.current.end,
      position: endPos,
      icon: icons.end,
      title: "Destination",
      onDragEnd: async (ll) => {
        setDestination(ll);
        populatePlacePickerFromLatLng(destPickerRef.current, ll);
        await buildRoute({ destinationOverride: ll, alternatives: true, fitToRoutes: true });
      },
    });
  }

  async function rebuildWithoutAlternatives(viaPointsOverride) {
    clearAlternativesState();
    await buildRoute({
      viaPointsOverride,
      alternatives: false,
      fitToRoutes: true,
    });
  }

  function renderPrimaryOnlyFromFull(fullDirections, idx) {
    const dr = rendererRef.current;
    if (!dr || !fullDirections?.routes?.length) return;

    const maxIdx = fullDirections.routes.length - 1;
    const clamped = Math.max(0, Math.min(idx, maxIdx));

    const single = { ...fullDirections, routes: [fullDirections.routes[clamped]] };

    programmaticUpdateRef.current = true;
    dr.setDirections(single);

    setTimeout(() => {
      programmaticUpdateRef.current = false;
    }, 0);
  }

  async function buildRoute({
    originOverride,
    destinationOverride,
    viaPointsOverride,
    alternatives = true,
    fitToRoutes = true,
  } = {}) {
    const ds = serviceRef.current;
    const dr = rendererRef.current;
    if (!ds || !dr || !map) return;

    const seq = bumpRequestSeq();
    hasActiveRouteRef.current = false;

    // Clear all existing overlays immediately so nothing from the previous search lingers.
    // Also hard-reset the main renderer to avoid lingering transit glyphs from the prior search.
    hardResetMainRenderer({ reattach: true, clearPanel: false });
    clearAltPolylines();
    clearPrimaryPolylines();
    clearHybridOverlays();

    const ul = userLocRef?.current;
    const origin = originOverride ?? originRef.current ?? ul ?? fallbackCenter;
    const destination = destinationOverride ?? destinationRef.current;
    if (!destination) return;

    const viaPts = viaPointsOverride ?? viaPointsRef.current;

    const combo = routeComboRef?.current ?? null;

    // ---------------------------
    // Hybrid modes (Transit + Bike / Transit + Skate)
    // ---------------------------
    if (combo === ROUTE_COMBO.TRANSIT_BIKE || combo === ROUTE_COMBO.TRANSIT_SKATE) {
      try {
        // Clear Google renderer output (we draw our own polylines)
        clearAlternativesState();
        clearAltPolylines();
        clearPrimaryPolylines();
        clearHybridOverlays();

        // Detach the main renderer in hybrid mode so no Google overlay glyphs linger.
        hardResetMainRenderer({ reattach: false, clearPanel: true });

        setShowGooglePanel(false);
        setSelectedSegments(null);

        // NOTE: detours/via points are not yet wired for hybrid.
        if (viaPts?.length) {
          console.warn("Hybrid routing: via points currently ignored");
        }

        const options = await buildHybridOptions({
          ds,
          origin,
          destination,
          transitTime: transitTimeRef?.current,
          combo,
          maxOptions: 6,
        });

        if (isStaleSeq(seq)) return;

        if (!options?.length) return;

        hybridOptionsRef.current = options;
        setRouteOptions(options);

        // Draw selected route + alternates with custom overlays, but keep first/last micro-legs draggable
        await renderHybridSelection(0, { fitToRoutes, requestSeq: seq });
        if (isStaleSeq(seq)) return;

        // Draggable endpoints (origin/destination)
        syncMarkersFromEndpoints(origin, destination);

        // Elevation refinement for skate (selected-only)
        if (combo === ROUTE_COMBO.TRANSIT_SKATE) {
          const opt = hybridOptionsRef.current?.[0];
          if (opt) {
            refineSkateSegmentsWithElevation({ option: opt })
              .then((refined) => {
                if (isStaleSeq(seq)) return;
                if (!refined) return;
                const rebuilt = rebuildWaitSegments(refined, refined.segments);
                updateHybridOptionsAtIndex(0, rebuilt);
              })
              .catch(() => {});
          }
        }

        return;
      } catch (err) {
        console.error("Hybrid build failed:", err);
        return;
      }
    }

    const req = {
      origin,
      destination,
      travelMode: travelModeRef.current ?? "TRANSIT",
      provideRouteAlternatives: Boolean(alternatives),
    };

    // ✅ Transit depart/arrive time support
    if ((req.travelMode ?? "TRANSIT") === "TRANSIT") {
      const t = transitTimeRef?.current; // { kind: "NOW"|"DEPART_AT"|"ARRIVE_BY", date: Date|null }
      const dt =
        t?.date instanceof Date && !Number.isNaN(t.date.getTime()) ? t.date : null;

      if (t?.kind === "ARRIVE_BY" && dt) {
        req.transitOptions = { arrivalTime: dt };
      } else if (t?.kind === "DEPART_AT" && dt) {
        req.transitOptions = { departureTime: dt };
      }
      // "NOW" => omit transitOptions (defaults to now)
    }

    if (viaPts?.length) {
      req.waypoints = viaPts.map((p) => ({ location: p, stopover: false }));
      req.optimizeWaypoints = false;
    }

    try {
      const result = await ds.route(req);
      if (isStaleSeq(seq)) return;
      const routesCount = result?.routes?.length ?? 0;

      if (alternatives && routesCount > 1) {
        fullDirectionsRef.current = result;

        const idx = 0;
        setSelectedRouteIndex(idx);
        selectedIdxRef.current = idx;
        setRouteOptions(summarizeDirectionsRoutes(result));

        renderPrimaryOnlyFromFull(result, idx);
        syncMarkersFromRoute(result.routes[idx]);
        drawPrimaryPolylinesFromRoute(result.routes[idx]);
        drawAlternatePolylines(result, idx);

        if (fitToRoutes) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (!isStaleSeq(seq)) fitAllRoutesInView(result, idx);
            });
          });
        }
      } else {
        clearAlternativesState();

        programmaticUpdateRef.current = true;
        dr.setDirections(result);

        const route = result?.routes?.[0];
        if (route) {
          hasActiveRouteRef.current = true;
          syncMarkersFromRoute(route);
          drawPrimaryPolylinesFromRoute(route);
        }

        if (fitToRoutes) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (!isStaleSeq(seq)) fitAllRoutesInView(result, 0);
            });
          });
        }

        setTimeout(() => {
          programmaticUpdateRef.current = false;
        }, 0);
      }
    } catch (err) {
      console.error("Directions route() failed:", err);
    }
  }

  async function selectRoute(idx) {

    const seq = requestSeqRef.current;

    // Hybrid selection (custom overlays)
    const hybrid = hybridOptionsRef.current;
    if (hybrid?.length) {
      const maxIdx = hybrid.length - 1;
      const clamped = Math.max(0, Math.min(idx, maxIdx));

      await renderHybridSelection(clamped, { requestSeq: seq });
      if (isStaleSeq(seq)) return;

      // Keep draggable endpoints in sync
      syncMarkersFromEndpoints(
        originRef.current ?? userLocRef?.current ?? fallbackCenter,
        destinationRef.current
      );

      const combo = routeComboRef?.current ?? null;
      if (combo === ROUTE_COMBO.TRANSIT_SKATE) {
        // Best-effort elevation refinement for the newly selected option (timing only)
        const opt = hybridOptionsRef.current?.[clamped];
        if (opt) {
          refineSkateSegmentsWithElevation({ option: opt })
            .then((refined) => {
              if (isStaleSeq(seq)) return;
              if (!refined) return;
              const rebuilt = rebuildWaitSegments(refined, refined.segments);
              updateHybridOptionsAtIndex(clamped, rebuilt);
            })
            .catch(() => {});
        }
      }
      return;
    }

    // Normal Google DirectionsRenderer selection
    const full = fullDirectionsRef.current;
    if (!full?.routes?.length) return;

    const maxIdx = full.routes.length - 1;
    const clamped = Math.max(0, Math.min(idx, maxIdx));

    setSelectedRouteIndex(clamped);
    selectedIdxRef.current = clamped;

    renderPrimaryOnlyFromFull(full, clamped);
    syncMarkersFromRoute(full.routes[clamped]);
    drawPrimaryPolylinesFromRoute(full.routes[clamped]);
    drawAlternatePolylines(full, clamped);
  }

  // init service/renderer + keep markers in sync when user drags the primary route line
  useEffect(() => {
    if (!enabled || !map) return;

    let cancelled = false;
    let changedListener = null;

    (async () => {
      const { DirectionsService, DirectionsRenderer } =
        await window.google.maps.importLibrary("routes");

      if (cancelled) return;

      serviceRef.current = new DirectionsService();

      const renderer = new DirectionsRenderer({
        map,
        panel: panelRef.current ?? undefined,
        draggable: true,
        suppressMarkers: true,
        hideRouteList: true,
        preserveViewport: true,
        // We draw our own polylines for consistent styling.
        // Keep the renderer polyline invisible but draggable/selectable.
        polylineOptions: { strokeOpacity: 0, strokeWeight: 10 },
      });

      rendererRef.current = renderer;

      changedListener = renderer.addListener("directions_changed", () => {
        if (!hasActiveRouteRef.current) return;
        if (programmaticUpdateRef.current) return;

        const dir = renderer.getDirections?.();
        const route = dir?.routes?.[0];
        if (!route) return;

        if (fullDirectionsRef.current) {
          clearAlternativesState();
        }

        syncMarkersFromRoute(route);
        drawPrimaryPolylinesFromRoute(route);
      });
    })();

    return () => {
      cancelled = true;

      changedListener?.remove?.();

      rendererRef.current?.setMap(null);
      rendererRef.current = null;
      serviceRef.current = null;

      clearAltPolylines();
      clearPrimaryPolylines();
      clearHybridOverlays({ resetState: false });
      clearRouteMarkers();
      iconsRef.current = { detour: null, start: null, end: null };
      fullDirectionsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, map]);

  
function hardResetMainRenderer({ reattach = true, clearPanel = false } = {}) {
  const dr = rendererRef.current;
  if (!dr) return;

  // Nuke old overlays as aggressively as possible. Some Maps JS builds leave
  // transit glyphs on-map unless we detach/reattach the renderer.
  try {
    dr.setDirections?.(null);
  } catch {
    // ignore
  }
  try {
    dr.setDirections?.({ routes: [] });
  } catch {
    // ignore
  }

  // Detach panel first (helps clear lingering panel annotations).
  try {
    dr.setPanel?.(clearPanel ? null : panelRef?.current ?? undefined);
  } catch {
    // ignore
  }

  // Detach from map to force-clear any lingering renderer overlays ("transit tags"/glyphs).
  try {
    dr.setMap?.(null);
  } catch {
    // ignore
  }

  if (reattach) {
    try {
      dr.setMap?.(map);
    } catch {
      // ignore
    }
    try {
      dr.setPanel?.(panelRef?.current ?? undefined);
    } catch {
      // ignore
    }
  }
}


function clearRoute() {
  const seq = bumpRequestSeq();
  hasActiveRouteRef.current = false;

  // Prevent any pending directions_changed handler from re-drawing after clear.
  programmaticUpdateRef.current = true;

  // Hard-reset the renderer to remove any lingering on-map glyphs/lines.
  hardResetMainRenderer({ reattach: false, clearPanel: true });

  if (panelRef?.current) {
    try {
      panelRef.current.innerHTML = "";
    } catch {
      // ignore
    }
  }

  clearAlternativesState();
  clearPrimaryPolylines();
  clearHybridOverlays();
  clearRouteMarkers();

  // Release the guard after the current tick, but only if nothing newer started.
  setTimeout(() => {
    if (!isStaleSeq(seq)) programmaticUpdateRef.current = false;
  }, 0);
}


  return {
    buildRoute,
    clearRoute,
    routeOptions,
    selectedRouteIndex,
    selectRoute,
    selectedSegments,
    showGooglePanel,
  };
}
