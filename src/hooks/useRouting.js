// src/hooks/useRouting.js
import { useEffect, useRef, useState } from "react";
import {
  extractViaPointsFromRoute,
  summarizeDirectionsRoutes,
  toLatLngLiteral,
} from "../maps/directionsUtils";
import {
  createDetourIcon,
  createEndIcon,
  createStartIcon,
} from "../maps/markerIcons";
import { populatePlacePickerFromLatLng } from "../maps/placePicker";

// Robustly dispose either google.maps.Marker or AdvancedMarkerElement
function disposeAnyMarker(m) {
  if (!m) return;

  try {
    if (window.google?.maps?.event?.clearInstanceListeners) {
      window.google.maps.event.clearInstanceListeners(m);
    }
  } catch {
    // ignore
  }

  // Marker
  if (typeof m.setMap === "function") {
    try {
      m.setMap(null);
    } catch {
      // ignore
    }
    return;
  }

  // AdvancedMarkerElement
  if ("map" in m) {
    try {
      m.map = null;
    } catch {
      // ignore
    }
  }
}

function latLngToNums(p) {
  if (!p) return null;
  // google.maps.LatLng
  if (typeof p.lat === "function" && typeof p.lng === "function") {
    const lat = p.lat();
    const lng = p.lng();
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }
  // literal
  const { lat, lng } = p;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

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

  const [routeOptions, setRouteOptions] = useState([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const selectedIdxRef = useRef(0);

  // When we call setDirections ourselves, ignore the next directions_changed
  const programmaticUpdateRef = useRef(false);

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

  function drawAlternatePolylines(fullDirections, selectedIdx) {
    if (!map) return;

    clearAltPolylines();

    const routes = fullDirections?.routes ?? [];
    if (routes.length <= 1) return;

    // Purple-ish hue for alternates
    const ALT_COLOR = "#A142F4";
    const ALT_OPACITY = 0.28;
    const ALT_WEIGHT = 7;

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
        zIndex: 1,
      });

      const listener = poly.addListener("click", () => {
        selectRoute(idx);
      });

      altPolylinesRef.current.push(poly);
      altPolylineListenersRef.current.push(listener);
    });
  }

  function ensureEndpointMarker({
    currentMarker,
    position,
    icon,
    title,
    onDragEnd,
  }) {
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

    // START marker
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

    // END marker
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

    // DETOUR markers
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

        clearAlternativesState();
        await buildRoute({
          viaPointsOverride: next,
          alternatives: false,
          fitToRoutes: true,
        });
      });

      marker.addListener("dragend", async (e) => {
        const ll = toLatLngLiteral(e?.latLng);
        if (!ll) return;

        const next = [...viaPointsRef.current];
        next[idx] = ll;
        viaPointsRef.current = next;

        clearAlternativesState();
        await buildRoute({
          viaPointsOverride: next,
          alternatives: false,
          fitToRoutes: true,
        });
      });

      return marker;
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

    const ul = userLocRef.current;
    const origin = originOverride ?? originRef.current ?? ul ?? fallbackCenter;
    const destination = destinationOverride ?? destinationRef.current;
    if (!destination) return;

    const viaPts = viaPointsOverride ?? viaPointsRef.current;

    const req = {
      origin,
      destination,
      travelMode: travelModeRef.current,
      provideRouteAlternatives: Boolean(alternatives),
    };

    if (viaPts?.length) {
      req.waypoints = viaPts.map((p) => ({ location: p, stopover: false }));
      req.optimizeWaypoints = false;
    }

    try {
      const result = await ds.route(req);
      const routesCount = result?.routes?.length ?? 0;

      if (alternatives && routesCount > 1) {
        fullDirectionsRef.current = result;

        const idx = 0;
        setSelectedRouteIndex(idx);
        selectedIdxRef.current = idx;
        setRouteOptions(summarizeDirectionsRoutes(result));

        renderPrimaryOnlyFromFull(result, idx);
        syncMarkersFromRoute(result.routes[idx]);
        drawAlternatePolylines(result, idx);

        if (fitToRoutes) {
          // Wait for layout to settle (helps after resizing window / split-screen)
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              fitAllRoutesInView(result, idx);
            });
          });
        }
      } else {
        clearAlternativesState();

        programmaticUpdateRef.current = true;
        dr.setDirections(result);

        const route = result?.routes?.[0];
        if (route) syncMarkersFromRoute(route);

        if (fitToRoutes) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              fitAllRoutesInView(result, 0);
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

  function selectRoute(idx) {
    const full = fullDirectionsRef.current;
    if (!full?.routes?.length) return;

    const maxIdx = full.routes.length - 1;
    const clamped = Math.max(0, Math.min(idx, maxIdx));

    setSelectedRouteIndex(clamped);
    selectedIdxRef.current = clamped;

    renderPrimaryOnlyFromFull(full, clamped);
    syncMarkersFromRoute(full.routes[clamped]);
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

        // Prevent renderer from auto-fitting viewport to the primary route
        preserveViewport: true,
      });

      rendererRef.current = renderer;

      changedListener = renderer.addListener("directions_changed", () => {
        if (programmaticUpdateRef.current) return;

        const dir = renderer.getDirections?.();
        const route = dir?.routes?.[0];
        if (!route) return;

        // User dragging/editing invalidates alternatives
        if (fullDirectionsRef.current) {
          clearAlternativesState();
        }

        syncMarkersFromRoute(route);
      });
    })();

    return () => {
      cancelled = true;

      changedListener?.remove?.();

      rendererRef.current?.setMap(null);
      rendererRef.current = null;
      serviceRef.current = null;

      clearAltPolylines();
      clearRouteMarkers();
      iconsRef.current = { detour: null, start: null, end: null };
      fullDirectionsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, map]);

  function clearRoute() {
    rendererRef.current?.setDirections({ routes: [] });

    if (panelRef?.current) {
      try {
        panelRef.current.innerHTML = "";
      } catch {
        // ignore
      }
    }

    clearAltPolylines();
    clearRouteMarkers();
    clearAlternativesState();
  }

  return {
    buildRoute,
    clearRoute,
    routeOptions,
    selectedRouteIndex,
    selectRoute,
  };
}
