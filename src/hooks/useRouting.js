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

  // Base polyline styles (used to normalize thickness after zoom settles)
  const polyBaseRef = useRef(new WeakMap());
  const lastRestScaleRef = useRef(1);

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
  const microShadowPolylinesRef = useRef({ first: null, last: null });
  // Visual polylines for draggable first/last micro-legs (renderer kept mostly invisible for dragging)
  const microMainPolylinesRef = useRef({ first: null, last: null });
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

      clearMicroShadow(k);

      clearMicroMain(k);
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
            fillColor: color,
            fillOpacity: 1,
            strokeOpacity: 0,
            strokeWeight: 0,
          },
          offset: "0",
          repeat,
        },
      ],
    };
  }

  function styleIsDotted(style) {
    return Boolean(style?.icons?.length);
  }




function registerPolylineBase(poly) {
  if (!poly) return;

  const wm = polyBaseRef.current;
  if (!wm) return;

  try {
    if (!wm.has(poly)) {
      wm.set(poly, { strokeWeight: poly.get("strokeWeight"), icons: poly.get("icons") });
    }

    // If the map is resting at a fractional-zoom pane scale, newly created polylines can look
    // too thin until the next idle. Immediately sync them to the last known rest scale.
    const scale = lastRestScaleRef.current ?? 1;
    if (Math.abs(scale - 1) < 0.01) return;

    const inv = 1 / (scale || 1);
    const base = wm.get(poly);
    const sw = Number(base?.strokeWeight);
    const baseIcons = base?.icons;

    const out = {};
    if (Number.isFinite(sw) && sw > 0) out.strokeWeight = Math.max(1, sw * inv);
    if (Array.isArray(baseIcons) && baseIcons.length) out.icons = scaleIconsForRest(baseIcons, inv);

    try {
      poly.setOptions(out);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

function parseScaleFromTransform(transform) {
  if (!transform || transform === "none") return 1;

  const m3 = transform.match(/^matrix3d\((.+)\)$/);
  if (m3) {
    const v = m3[1].split(",").map((x) => Number(x.trim()));
    if (v.length === 16) {
      const sx = Math.hypot(v[0], v[1], v[2]);
      const sy = Math.hypot(v[4], v[5], v[6]);
      const s = (sx + sy) / 2;
      return Number.isFinite(s) ? s : 1;
    }
  }

  const m2 = transform.match(/^matrix\((.+)\)$/);
  if (m2) {
    const v = m2[1].split(",").map((x) => Number(x.trim()));
    if (v.length >= 6) {
      const [a, b, c, d] = v;
      const sx = Math.hypot(a, b);
      const sy = Math.hypot(c, d);
      const s = (sx + sy) / 2;
      return Number.isFinite(s) ? s : 1;
    }
  }

  return 1;
}

function scalePxString(px, invScale) {
  if (typeof px !== "string") return px;
  const mm = px.trim().match(/^(-?\d+(?:\.\d+)?)px$/i);
  if (!mm) return px;
  const n = parseFloat(mm[1]);
  if (!Number.isFinite(n)) return px;
  const out = n * invScale;
  return `${Number(out.toFixed(3)).toString()}px`;
}

function scaleIconsForRest(icons, invScale) {
  if (!Array.isArray(icons) || !icons.length) return icons;

  return icons.map((item) => {
    const icon = item?.icon ?? {};
    const s = icon?.scale;
    const scaledIcon =
      Number.isFinite(s) ? { ...icon, scale: Math.max(0.5, s * invScale) } : icon;

    return {
      ...item,
      icon: scaledIcon,
      repeat: scalePxString(item?.repeat, invScale),
      offset: item?.offset,
    };
  });
}

function restScaleFromZoomFraction() {
  try {
    const z = map?.getZoom?.();
    if (!Number.isFinite(z)) return 1;
    const frac = z - Math.floor(z);
    if (Math.abs(frac) < 0.0005) return 1;
    const s = Math.pow(2, frac);
    return Number.isFinite(s) && s > 0.25 && s < 4 ? s : 1;
  } catch {
    return 1;
  }
}

function restScaleFromDom() {
  const root = map?.getDiv?.();
  if (!root) return 1;

  let bestScale = 1;
  let bestDev = 0;

  const nodes = root.querySelectorAll("div");
  const limit = Math.min(nodes.length, 450);

  for (let i = 0; i < limit; i++) {
    const el = nodes[i];
    const tf = window.getComputedStyle(el).transform;
    const s = parseScaleFromTransform(tf);
    const dev = Math.abs(s - 1);
    if (dev > bestDev + 0.01 && s > 0.25 && s < 4) {
      bestDev = dev;
      bestScale = s;
    }
  }

  return bestScale;
}

function getRestOverlayScale() {
  const dom = restScaleFromDom();
  if (Math.abs(dom - 1) > 0.02) return dom;

  const z = restScaleFromZoomFraction();
  if (Math.abs(z - 1) > 0.02) return z;

  return 1;
}

function applyRestScaleToMicroRenderers(scale) {
  // Micro-leg DirectionsRenderers are used for dragging only.
  // Keep their polylines effectively invisible so our own microMain polylines are the only visible lines.
  const applyTo = (which) => {
    const renderer =
      which === "first" ? microFirstRendererRef.current : microLastRendererRef.current;
    if (!renderer) return;

    try {
      renderer.setOptions?.({
        polylineOptions: {
          strokeOpacity: 0.01, // still hit-testable
          strokeWeight: 18,
          zIndex: 40,
        },
      });
    } catch {
      // ignore
    }
  };

  applyTo("first");
  applyTo("last");
}

function applyRestScaleToAllPolylines(scale) {
  const inv = 1 / (scale || 1);

  const all = [
    ...(primaryPolylinesRef.current ?? []),
    ...(altPolylinesRef.current ?? []),
    ...(hybridPolylinesRef.current ?? []),
    ...(hybridAltPolylinesRef.current ?? []),
  ];

  const ms = microShadowPolylinesRef.current ?? {};
  if (ms.first) all.push(ms.first);
  if (ms.last) all.push(ms.last);


  const mm = microMainPolylinesRef.current ?? {};
  if (mm.first) all.push(mm.first);
  if (mm.last) all.push(mm.last);

  for (const poly of all) {
    if (!poly?.setOptions) continue;

    try {
      registerPolylineBase(poly);
    } catch {}

    const base = polyBaseRef.current?.get?.(poly);
    const sw = Number(base?.strokeWeight);
    const baseIcons = base?.icons;

    const out = {};

    if (Number.isFinite(sw) && sw > 0) {
      out.strokeWeight = Math.max(1, sw * inv);
    }

    if (Array.isArray(baseIcons) && baseIcons.length) {
      out.icons = scaleIconsForRest(baseIcons, inv);
    }

    try {
      poly.setOptions(out);
    } catch {
      // ignore
    }
  }

  applyRestScaleToMicroRenderers(scale);
}
// --- Route line shadow / edge outline (Google-ish) ---
// Implemented as a slightly thicker, low-opacity black polyline drawn beneath the main line.
const SHADOW_COLOR = "#000000";
const SHADOW_OPACITY_PRIMARY = 0.4;
const SHADOW_OPACITY_ALT = 0.14;
const SHADOW_EXTRA_PX = 4;

// Overlap masking (alternate routes): keep a small gap for near-parallel overlaps,
// but allow crossings to draw through so we don't create awkward 'holes' at intersections.
const OVERLAP_MASK_MIN_PX = 7;
const OVERLAP_MASK_FACTOR = 0.6;
const OVERLAP_MASK_PARALLEL_DOT_MIN = 0.78; // ~39 degrees

function overlapMaskThresholdPx(strokeWeight) {
  return Math.max(OVERLAP_MASK_MIN_PX, (strokeWeight + SHADOW_EXTRA_PX) * OVERLAP_MASK_FACTOR);
}

function addShadowPolyline({ path, strokeWeight = 8, zIndex = 0, isAlt = false, skip = false }) {
  if (skip) return null;

  if (!map || !path?.length) return null;

  try {
    const poly = new window.google.maps.Polyline({
      map,
      path,
      clickable: false,
      strokeColor: SHADOW_COLOR,
      strokeOpacity: isAlt ? SHADOW_OPACITY_ALT : SHADOW_OPACITY_PRIMARY,
      strokeWeight: Math.max(1, (strokeWeight ?? 8) + SHADOW_EXTRA_PX),
      // Ensure shadow stays under the main line even when zIndex is 0.
      zIndex: (zIndex ?? 0) - 1,
    });
    registerPolylineBase(poly);
    return poly;
  } catch {
    return null;
  }
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

          const shadow = addShadowPolyline({
            path,
            strokeWeight: polylineOptions?.strokeWeight ?? 8,
            zIndex,
            isAlt: false,
            skip: styleIsDotted(polylineOptions),
          });
          if (shadow) primaryPolylinesRef.current.push(shadow);

          const poly = new window.google.maps.Polyline({
            map,
            path,
            clickable: false,
            ...polylineOptions,
            zIndex,
          });
          registerPolylineBase(poly);
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

    const shadow = addShadowPolyline({
      path,
      strokeWeight: style?.strokeWeight ?? 8,
      zIndex,
      isAlt: false,
      skip: styleIsDotted(style),
    });
    if (shadow) primaryPolylinesRef.current.push(shadow);

    const poly = new window.google.maps.Polyline({
      map,
      path,
      clickable: false,
      ...style,
      zIndex,
    });
    registerPolylineBase(poly);
    primaryPolylinesRef.current.push(poly);
  }

  function getProjectionAndZoom() {
    try {
      const proj = map?.getProjection?.();
      const zoom = map?.getZoom?.();
      if (!proj || !Number.isFinite(zoom)) return null;
      return { proj, zoom };
    } catch {
      return null;
    }
  }

  function toWorldPx(ll, proj, zoom) {
    const n = latLngToNums(ll);
    if (!n) return null;
    try {
      const latLngObj = new window.google.maps.LatLng(n.lat, n.lng);
      const pt = proj.fromLatLngToPoint(latLngObj);
      const scale = Math.pow(2, zoom);
      return { x: pt.x * scale, y: pt.y * scale };
    } catch {
      return null;
    }
  }

  function distSqPointToSeg(p, a, b) {
    // Standard closest-point-on-segment distance in 2D.
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const wx = p.x - a.x;
    const wy = p.y - a.y;

    const c1 = vx * wx + vy * wy;
    if (c1 <= 0) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2;

    const c2 = vx * vx + vy * vy;
    if (c2 <= 0.0000001) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2;

    const t = Math.min(1, Math.max(0, c1 / c2));
    const px = a.x + t * vx;
    const py = a.y + t * vy;
    return (p.x - px) ** 2 + (p.y - py) ** 2;
  }

  function densifyPath(path, maxStepMeters = 30) {
    if (!Array.isArray(path) || path.length < 2) return path ?? [];

    const out = [];
    const spherical = window.google?.maps?.geometry?.spherical;
    const canInterp = typeof spherical?.interpolate === "function";

    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      if (i === 0) out.push(a);

      const A = latLngToNums(a);
      const B = latLngToNums(b);
      if (!A || !B) {
        out.push(b);
        continue;
      }

      const d = haversineMeters(A, B);
      if (!Number.isFinite(d) || d <= maxStepMeters) {
        out.push(b);
        continue;
      }

      const steps = Math.min(60, Math.ceil(d / maxStepMeters));
      for (let s = 1; s < steps; s++) {
        const f = s / steps;
        if (canInterp) {
          try {
            out.push(spherical.interpolate(a, b, f));
            continue;
          } catch {
            // fall through
          }
        }
        out.push({ lat: A.lat + (B.lat - A.lat) * f, lng: A.lng + (B.lng - A.lng) * f });
      }
      out.push(b);
    }

    return out;
  }

  function buildOccupiedSegmentsPx(paths, proj, zoom) {
    const segs = [];
    (paths ?? []).forEach((raw) => {
      const p = densifyPath(raw, 40);
      for (let i = 0; i < p.length - 1; i++) {
        const a = toWorldPx(p[i], proj, zoom);
        const b = toWorldPx(p[i + 1], proj, zoom);
        if (!a || !b) continue;
        const minX = Math.min(a.x, b.x);
        const maxX = Math.max(a.x, b.x);
        const minY = Math.min(a.y, b.y);
        const maxY = Math.max(a.y, b.y);
        segs.push({ a, b, minX, maxX, minY, maxY });
      }
    });
    return segs;
  }

  function normalizeUnit(v) {
    const n = Math.hypot(v?.x ?? 0, v?.y ?? 0);
    if (!Number.isFinite(n) || n <= 1e-9) return null;
    return { x: v.x / n, y: v.y / n };
  }

  function nearestOccupiedSeg(px, occupiedSegs, thresholdPx) {
    const t = thresholdPx;
    const tSq = t * t;
    let best = null;
    let bestD = Infinity;

    for (const s of occupiedSegs) {
      // cheap bbox reject
      if (px.x < s.minX - t || px.x > s.maxX + t || px.y < s.minY - t || px.y > s.maxY + t) continue;
      const d = distSqPointToSeg(px, s.a, s.b);
      if (d <= tSq && d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  function isPointNearOccupied(px, dirUnit, occupiedSegs, thresholdPx) {
    const s = nearestOccupiedSeg(px, occupiedSegs, thresholdPx);
    if (!s) return false;

    // If we can't estimate direction, fall back to masking (conservative).
    if (!dirUnit) return true;

    const occDir = normalizeUnit({ x: s.b.x - s.a.x, y: s.b.y - s.a.y });
    if (!occDir) return true;

    // Only mask when paths are roughly parallel. For crossings, allow the line through.
    const dot = Math.abs(dirUnit.x * occDir.x + dirUnit.y * occDir.y);
    if (dot < OVERLAP_MASK_PARALLEL_DOT_MIN) return false;

    return true;
  }

  function visibleChunksMasked(path, occupiedSegs, proj, zoom, thresholdPx) {
    const dense = densifyPath(path, 30);
    if (!dense.length) return [];

    // Precompute px coords (we need neighbors to estimate direction).
    const pts = [];
    const pxs = [];
    for (const pt of dense) {
      const px = toWorldPx(pt, proj, zoom);
      if (!px) continue;
      pts.push(pt);
      pxs.push(px);
    }
    if (pts.length < 2) return [];

    const chunks = [];
    let cur = [];

    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      const px = pxs[i];

      const prev = pxs[i - 1] ?? px;
      const next = pxs[i + 1] ?? px;
      const dirUnit = normalizeUnit({ x: next.x - prev.x, y: next.y - prev.y });

      const hidden = isPointNearOccupied(px, dirUnit, occupiedSegs, thresholdPx);

      if (!hidden) {
        cur.push(pt);
      } else {
        if (cur.length >= 2) chunks.push(cur);
        cur = [];
      }
    }

    if (cur.length >= 2) chunks.push(cur);
    return chunks;
  }

  // For transit routes, we treat WALKING steps as "non-claiming" space.
  // This avoids alternate-route clipping creating awkward gaps on walking transfers.
  function routeStepParts(route) {
    const out = [];
    const legs = route?.legs ?? [];
    for (const leg of legs) {
      const steps = leg?.steps ?? [];
      for (const step of steps) {
        const mode = step?.travel_mode ?? null;
        const path = decodeStepPath(step);
        if (!path?.length) continue;
        // Keep the original step so we can extract transit line colors for alternates.
        out.push({ mode, path, step });
      }
    }
    // Fallback if steps are missing.
    if (!out.length && route?.overview_path?.length) {
      out.push({ mode: null, path: route.overview_path, step: null });
    }
    return out;
  }

  function routeNonWalkingPaths(route) {
    const out = [];
    const parts = routeStepParts(route);
    for (const p of parts) {
      if (p?.mode === "WALKING") continue;
      if (p?.path?.length) out.push(p.path);
    }
    // If everything is walking or modes are unknown, fall back to overview.
    if (!out.length && route?.overview_path?.length) out.push(route.overview_path);
    return out;
  }

  

  function drawAlternatePolylines(fullDirections, selectedIdx) {
    if (!map) return;

    clearAltPolylines();

    const routes = fullDirections?.routes ?? [];
    if (routes.length <= 1) return;

    // Styling for alternates (still background, but clearer)
    const ALT_COLOR = HYBRID_STYLES.ALT_GRAY;
    const ALT_OPACITY = 0.6;
    const ALT_WEIGHT = 6;

    const pz = getProjectionAndZoom();
    const thresholdPx = overlapMaskThresholdPx(ALT_WEIGHT);

    // Selected route occupies space first; alternates will be clipped under it.
    // For transit, exclude WALKING steps from the occupied set so we don't punch holes
    // in alternate routes' walking transfers.
    let occupiedSegs = [];
    if (pz) {
      const selectedRoute = routes?.[selectedIdx];
      const occPaths = routeHasTransitSteps(selectedRoute)
        ? routeNonWalkingPaths(selectedRoute)
        : [selectedRoute?.overview_path ?? []];
      occupiedSegs = buildOccupiedSegmentsPx(occPaths, pz.proj, pz.zoom);
    }

    // Draw in pane order (lowest index = highest ranked). Later routes are clipped under earlier routes.
    routes.forEach((r, idx) => {
      if (idx === selectedIdx) return;

      const isTransitRoute = routeHasTransitSteps(r);
      const parts = isTransitRoute ? routeStepParts(r) : [{ mode: null, path: r?.overview_path ?? [] }];
      if (!parts.length) return;

      const zIndex = 12 - idx; // higher rank sits on top among alternates

      // Accumulate non-walking chunks we draw for this route; add to occupied set once per route.
      const routeOccChunks = [];

      parts.forEach((part) => {
        const rawPath = part?.path;
        if (!rawPath?.length) return;

        const isWalking = part?.mode === "WALKING";
        // Don't clip walking transfers; they are visually thin and clipping creates obvious gaps.
        const chunks = pz && !isWalking
          ? visibleChunksMasked(rawPath, occupiedSegs, pz.proj, pz.zoom, thresholdPx)
          : [rawPath];

        if (!chunks.length) return;

        chunks.forEach((chunk) => {
          // For unselected transit routes, color TRANSIT legs by their line color.
          // Keep non-transit legs (walk/bike/skate connectors) in the default alternate blue.
          let strokeColor = ALT_COLOR;
          if (part?.mode === "TRANSIT") {
            const td = getTransitDetailsFromStep(part?.step);
            strokeColor = getTransitLineColor(td, ALT_COLOR);
          }

          const shadow = addShadowPolyline({
            path: chunk,
            strokeWeight: ALT_WEIGHT,
            zIndex,
            isAlt: true,
          });
          if (shadow) altPolylinesRef.current.push(shadow);

          const poly = new window.google.maps.Polyline({
            map,
            path: chunk,
            clickable: true,
            strokeColor,
            strokeOpacity: ALT_OPACITY,
            strokeWeight: ALT_WEIGHT,
            zIndex,
          });

          const listener = poly.addListener("click", () => {
            selectRoute(idx);
          });

          registerPolylineBase(poly);
          altPolylinesRef.current.push(poly);
          altPolylineListenersRef.current.push(listener);
        });

        if (!isWalking) routeOccChunks.push(...chunks);
      });

      // Feed what we actually drew into the occupied set so lower-ranked routes don't stack under it.
      // Exclude walking chunks so we don't create transfer-leg holes on lower-ranked routes.
      if (pz && routeOccChunks.length) {
        occupiedSegs.push(...buildOccupiedSegmentsPx(routeOccChunks, pz.proj, pz.zoom));
      }
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
          strokeOpacity: 0,
          strokeWeight: 0,
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

        const weight = isAlt ? 6 : 8;
        const shadow = addShadowPolyline({
          path,
          strokeWeight: weight,
          zIndex,
          isAlt,
        });
        if (shadow) (isAlt ? hybridAltPolylinesRef : hybridPolylinesRef).current.push(shadow);

        const poly = new window.google.maps.Polyline({
          map,
          path,
          clickable: false,
          // Even for alternates, keep TRANSIT legs in their line color.
          strokeColor: lineColor,
          strokeOpacity: isAlt ? 0.6 : 1,
          strokeWeight: weight,
          zIndex,
        });
        registerPolylineBase(poly);
        (isAlt ? hybridAltPolylinesRef : hybridPolylinesRef).current.push(poly);
        return;
      }

      // Micro-mobility legs (walk / bike / skate)
      if (!isAlt && skipMicroIndices && skipMicroIndices.has(segIdx)) return;

      const path = seg.route?.overview_path ?? [];
      if (!path.length) return;
      const style = polylineStyleForMode(seg.mode, { isAlt });
      const shadow = addShadowPolyline({
        path,
        strokeWeight: style?.strokeWeight ?? (isAlt ? 6 : 8),
        zIndex,
        isAlt,
        skip: styleIsDotted(style),
      });
      if (shadow) (isAlt ? hybridAltPolylinesRef : hybridPolylinesRef).current.push(shadow);

      const poly = new window.google.maps.Polyline({
        map,
        path,
        clickable: false,
        ...style,
        zIndex,
      });
      registerPolylineBase(poly);
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

    const pz = getProjectionAndZoom();
    const thresholdPx = overlapMaskThresholdPx(6);

    // Selected option occupies space first.
    let occupiedSegs = [];
    if (pz) {
      const selectedOpt = options[selectedIdx];
      const occPaths = [];
      (selectedOpt?.segments ?? []).forEach((seg) => {
        if (!seg || seg.mode === "WAIT") return;
        if (seg.mode === "TRANSIT") {
          const p = getStepPath(seg.step);
          if (p?.length) occPaths.push(p);
        } else {
          const p = seg.route?.overview_path ?? [];
          if (p?.length) occPaths.push(p);
        }
      });
      occupiedSegs = buildOccupiedSegmentsPx(occPaths, pz.proj, pz.zoom);
    }

    // Draw in pane order; clip lower-ranked options under higher-ranked ones.
    options.forEach((opt, idx) => {
      if (idx === selectedIdx) return;

      const zIndex = 12 - idx;

      const segs = opt?.segments ?? [];
      segs.forEach((seg) => {
        if (!seg || seg.mode === "WAIT") return;

        let rawPath = [];
        let polyOptions = null;
        let skipShadow = false;

        if (seg.mode === "TRANSIT") {
          rawPath = getStepPath(seg.step);
          const td = seg.transitDetails;
          const lineColor = getTransitLineColor(td, DEFAULT_TRANSIT_BLUE);
          polyOptions = {
            // Alternates: keep TRANSIT legs in their line color.
            strokeColor: lineColor,
            strokeOpacity: 0.6,
            strokeWeight: 6,
          };
        } else {
          rawPath = seg.route?.overview_path ?? [];
          polyOptions = polylineStyleForMode(seg.mode, { isAlt: true });
          skipShadow = styleIsDotted(polyOptions);
        }

        if (!rawPath?.length || !polyOptions) return;

        const chunks = pz
          ? visibleChunksMasked(rawPath, occupiedSegs, pz.proj, pz.zoom, thresholdPx)
          : [rawPath];

        if (!chunks.length) return;

        chunks.forEach((chunk) => {
          const shadow = addShadowPolyline({
            path: chunk,
            strokeWeight: polyOptions?.strokeWeight ?? 6,
            zIndex,
            isAlt: true,
            skip: skipShadow,
          });
          if (shadow) hybridAltPolylinesRef.current.push(shadow);

          const poly = new window.google.maps.Polyline({
            map,
            path: chunk,
            clickable: true,
            ...polyOptions,
            zIndex,
          });

          const listener = poly.addListener("click", () => {
            selectRoute(idx);
          });

          registerPolylineBase(poly);
          hybridAltPolylinesRef.current.push(poly);
          hybridAltListenersRef.current.push(listener);
        });

        if (pz) {
          occupiedSegs.push(...buildOccupiedSegmentsPx(chunks, pz.proj, pz.zoom));
        }
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

  function clearMicroShadow(which) {
    const cur = microShadowPolylinesRef.current?.[which] ?? null;
    if (cur) {
      try {
        cur.setMap(null);
      } catch {
        // ignore
      }
    }
    if (microShadowPolylinesRef.current) microShadowPolylinesRef.current[which] = null;
  }


function clearMicroMain(which) {
  const cur = microMainPolylinesRef.current?.[which] ?? null;
  if (cur) {
    try {
      cur.setMap(null);
    } catch {
      // ignore
    }
  }
  if (microMainPolylinesRef.current) microMainPolylinesRef.current[which] = null;
}

function syncMicroMain(which, mode, route) {
  clearMicroMain(which);

  const path = route?.overview_path ?? [];
  if (!map || !path?.length) return;

  const style = polylineStyleForMode(mode, { isAlt: false });

  try {
    const poly = new window.google.maps.Polyline({
      map,
      path,
      clickable: false, // allow drag hit-testing to fall through to the DirectionsRenderer
      ...style,
      zIndex: 41,
    });
    registerPolylineBase(poly);
    if (microMainPolylinesRef.current) microMainPolylinesRef.current[which] = poly;
  } catch {
    // ignore
  }
}

  function syncMicroShadow(which, mode, route) {
    clearMicroShadow(which);

    const path = route?.overview_path ?? [];
    if (!map || !path?.length) return;

    const style = polylineStyleForMode(mode, { isAlt: false });
    if (styleIsDotted(style)) return;

    // Draw just the outline shadow behind the draggable renderer polyline.
    const shadow = addShadowPolyline({
      path,
      strokeWeight: style?.strokeWeight ?? 8,
      zIndex: 40,
      isAlt: false,
    });

    if (microShadowPolylinesRef.current) microShadowPolylinesRef.current[which] = shadow;
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

    // Shadow/edge outline for the draggable micro leg (skip dotted WALK)
    syncMicroShadow(which, oldSeg?.mode ?? segs[segIdx]?.mode, route);
    syncMicroMain(which, oldSeg?.mode ?? segs[segIdx]?.mode, route);

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
        existing.setOptions?.({ polylineOptions: { strokeOpacity: 0.01, strokeWeight: 18, zIndex: 40 } });
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
      polylineOptions: { strokeOpacity: 0.01, strokeWeight: 18, zIndex: 40 },
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

    // Shadow/edge outline for the draggable micro leg (skip dotted WALK)
    syncMicroShadow(which, seg.mode, seg.route);
    syncMicroMain(which, seg.mode, seg.route);
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

    // Re-enable Google's transit route shields/labels for the selected hybrid option.
    // (These are provided by DirectionsRenderer; we keep its polyline invisible.)
    syncHybridTransitGlyphs(opt, seq);

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

    const combo = routeComboRef?.current ?? null;
    const isHybridCombo =
      combo === ROUTE_COMBO.TRANSIT_BIKE || combo === ROUTE_COMBO.TRANSIT_SKATE;

    // Clear all existing overlays immediately so nothing from the previous search lingers.
    // Also hard-reset the main renderer to avoid lingering transit glyphs from the prior search.
    hardResetMainRenderer({ reattach: true, clearPanel: isHybridCombo });
    if (isHybridCombo) configureMainRendererForHybrid();
    else configureMainRendererForNormal();
    clearAltPolylines();
    clearPrimaryPolylines();
    clearHybridOverlays();

    const ul = userLocRef?.current;
    const origin = originOverride ?? originRef.current ?? ul ?? fallbackCenter;
    const destination = destinationOverride ?? destinationRef.current;
    if (!destination) return;

    const viaPts = viaPointsOverride ?? viaPointsRef.current;

    // ---------------------------
    // Hybrid modes (Transit + Bike / Transit + Skate)
    // ---------------------------
    if (isHybridCombo) {
      try {
        // Clear Google renderer output (we draw our own polylines)
        clearAlternativesState();
        clearAltPolylines();
        clearPrimaryPolylines();
        clearHybridOverlays();

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

  // Re-clip alternates when zoom changes (overlap masking is in pixel-space at current zoom).
  
// Normalize stroke thickness after zoom settles.
// With fractional zoom enabled, Maps can leave the overlay pane scaled at rest.
// We compensate on 'idle' so routes look identical thickness regardless of final zoom fraction.
useEffect(() => {
  if (!enabled || !map) return;

  let idleListener = null;

  const onIdle = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scale = getRestOverlayScale();
        const last = lastRestScaleRef.current ?? 1;

        // Small deadband to avoid thrashing on tiny numeric noise.
        if (Math.abs(scale - last) < 0.01) return;

        lastRestScaleRef.current = scale;
        applyRestScaleToAllPolylines(scale);
      });
    });
  };

  try {
    idleListener = map.addListener("idle", onIdle);
  } catch {
    // ignore
  }

  // Apply once right away, in case the map is already settled at a fractional zoom.
  try {
    onIdle();
  } catch {
    // ignore
  }

  return () => {
    try {
      idleListener?.remove?.();
    } catch {}
  };
}, [enabled, map]);

useEffect(() => {
    if (!enabled || !map) return;

    let listener = null;
    let t = null;

    const scheduleAltRedraw = () => {
      try {
        if (t) clearTimeout(t);
      } catch {
        // ignore
      }

      t = setTimeout(() => {
        try {
          const hybrid = hybridOptionsRef.current;
          const sel = selectedIdxRef.current ?? 0;
          if (hybrid?.length) {
            drawHybridAlternates(hybrid, sel);
            return;
          }

          const full = fullDirectionsRef.current;
          if (full?.routes?.length > 1) {
            drawAlternatePolylines(full, sel);
          }
        } catch {
          // ignore
        }
      }, 120);
    };

    try {
      listener = map.addListener("zoom_changed", scheduleAltRedraw);
    } catch {
      // ignore
    }

    return () => {
      try {
        listener?.remove?.();
      } catch {
        // ignore
      }
      try {
        if (t) clearTimeout(t);
      } catch {
        // ignore
      }
    };
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
      // Respect clearPanel on reattach so hybrid modes can keep the panel detached.
      dr.setPanel?.(clearPanel ? null : panelRef?.current ?? undefined);
    } catch {
      // ignore
    }
  }
}

function configureMainRendererForNormal() {
  const dr = rendererRef.current;
  if (!dr) return;
  try {
    dr.setOptions?.({
      draggable: true,
      suppressMarkers: true,
      hideRouteList: true,
      preserveViewport: true,
      // Keep the renderer polyline invisible but draggable/selectable.
      polylineOptions: { strokeOpacity: 0, strokeWeight: 10 },
    });
  } catch {
    // ignore
  }
  try {
    dr.setPanel?.(panelRef?.current ?? undefined);
  } catch {
    // ignore
  }
  try {
    dr.setMap?.(map);
  } catch {
    // ignore
  }
}

function configureMainRendererForHybrid() {
  const dr = rendererRef.current;
  if (!dr) return;
  try {
    dr.setOptions?.({
      draggable: false,
      suppressMarkers: true,
      hideRouteList: true,
      preserveViewport: true,
      // We only want Google's transit glyphs/route shields; keep the underlying polyline invisible
      // and non-interactive so it doesn't interfere with our custom overlays.
      polylineOptions: { strokeOpacity: 0, strokeWeight: 10, clickable: false },
    });
  } catch {
    // ignore
  }
  // Hybrid UI hides the Google panel; keep it detached even if the renderer exists.
  try {
    dr.setPanel?.(null);
  } catch {
    // ignore
  }
  try {
    dr.setMap?.(map);
  } catch {
    // ignore
  }
}


function cloneWithProto(obj) {
  if (!obj) return obj;
  try {
    return Object.assign(Object.create(Object.getPrototypeOf(obj)), obj);
  } catch {
    // Fallback: plain clone
    try {
      return { ...obj };
    } catch {
      return obj;
    }
  }
}

// In hybrid modes we keep the main DirectionsRenderer around ONLY for Google's transit glyphs/labels.
// Unfortunately, Google also draws dotted WALK connectors for TRANSIT routes.
// To keep the transit glyphs while removing the walk dots, we feed the renderer a "transit-only"
// clone of the base route: remove WALK steps + rebuild overview_path from TRANSIT step geometry.
function buildTransitOnlyRouteForGlyphs(baseRoute) {
  try {
    const route = baseRoute;
    const legs = route?.legs ?? [];
    if (!legs.length) return route;

    const leg0 = legs[0];
    const steps = leg0?.steps ?? [];
    const transitSteps = steps.filter((s) => s?.travel_mode === "TRANSIT");
    if (!transitSteps.length) return route;

    // Build a path from TRANSIT steps only (removes all walking geometry).
    const outPath = [];
    for (const st of transitSteps) {
      const seg = decodeStepPath(st);
      if (!seg?.length) continue;
      if (!outPath.length) {
        outPath.push(...seg);
      } else {
        // Avoid duplicating the joint point if it matches.
        const last = outPath[outPath.length - 1];
        const first = seg[0];
        const joinDist = haversineMeters(last, first);
        if (Number.isFinite(joinDist) && joinDist < 0.75) outPath.push(...seg.slice(1));
        else outPath.push(...seg);
      }
    }

    const newLeg0 = cloneWithProto(leg0);
    newLeg0.steps = transitSteps;

    // Align leg start/end so the renderer doesn't try to "helpfully" draw connectors.
    const firstT = transitSteps[0];
    const lastT = transitSteps[transitSteps.length - 1];
    if (firstT?.start_location) newLeg0.start_location = firstT.start_location;
    if (lastT?.end_location) newLeg0.end_location = lastT.end_location;

    // Update summary numbers (not strictly required for glyphs, but keeps things coherent).
    const dist = transitSteps.reduce((sum, s) => sum + (s?.distance?.value ?? 0), 0);
    const dur = transitSteps.reduce((sum, s) => sum + (s?.duration?.value ?? 0), 0);
    if (Number.isFinite(dist)) newLeg0.distance = { ...(newLeg0.distance ?? {}), value: dist };
    if (Number.isFinite(dur)) newLeg0.duration = { ...(newLeg0.duration ?? {}), value: dur };

    const newRoute = cloneWithProto(route);
    newRoute.legs = [newLeg0, ...legs.slice(1)];

    if (outPath.length) {
      newRoute.overview_path = outPath;
      try {
        const enc = window.google?.maps?.geometry?.encoding?.encodePath;
        if (enc) {
          newRoute.overview_polyline = {
            ...(newRoute.overview_polyline ?? {}),
            points: enc(outPath),
          };
        }
      } catch {
        // ignore
      }
    }

    // Keep original bounds to avoid surprising viewport changes.
    newRoute.bounds = route.bounds;

    return newRoute;
  } catch {
    return baseRoute;
  }
}

function syncHybridTransitGlyphs(option, seq) {
  const dr = rendererRef.current;
  if (!dr || !map) return;

  // Only HYBRID options have a TRANSIT base route/result.
  const baseResult = option?.baseResult;
  const baseRoute = option?.baseRoute;
  const hasTransit =
    option?.kind === "HYBRID" ||
    Boolean(option?.segments?.some?.((s) => s?.mode === "TRANSIT"));

  if (!hasTransit || !baseResult || !baseRoute) {
    // Some Maps JS builds can leave transit glyphs behind unless we detach/reattach.
    hardResetMainRenderer({ reattach: true, clearPanel: true });
    configureMainRendererForHybrid();
    return;
  }

  configureMainRendererForHybrid();

  // Feed a single-route DirectionsResult to the renderer.
  // This preserves the transit "route shields"/labels on the map without us having to
  // reimplement them (and without showing Google's polylines).
  const glyphRoute = buildTransitOnlyRouteForGlyphs(baseRoute);

  const single = { ...baseResult, routes: [glyphRoute ?? baseRoute] };

  // Guard against the main directions_changed handler.
  programmaticUpdateRef.current = true;
  try {
    dr.setDirections(single);
  } catch {
    // ignore
  }

  setTimeout(() => {
    if (!isStaleSeq(seq)) programmaticUpdateRef.current = false;
  }, 0);
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
