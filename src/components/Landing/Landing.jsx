// src/components/Landing/Landing.jsx
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useLocation } from "react-router";
import styles from "./Landing.module.css";
import DirectionsSidebar from "../DirectionsSidebar/DirectionsSidebar.jsx";
import AuthSidebar from "../AuthSidebar/AuthSidebar.jsx";
import { useGoogleMapsReady } from "../../hooks/useGoogleMapsReady";
import { useGeolocation } from "../../hooks/useGeolocation";

import { useInnerMap } from "../../hooks/useInnerMap";
import { usePickerPrefill } from "../../hooks/usePickerPrefill";
import { useMapContextMenu } from "../../hooks/useMapContextMenu";
import { useRouting } from "../../hooks/useRouting/useRoutingHook";
import { ROUTE_COMBO } from "../../routing/routeCombos";
import {
  SEARCH_TRIGGER,
  buildRoutingSearch,
  historyModeForTrigger,
  parseRoutingSearch,
} from "../../routing/urlState";

import { populatePlacePickerFromLatLng, closePickerSuggestions } from "../../maps/placePicker";
import { toLatLngLiteral } from "../../maps/directionsUtils";

const FALLBACK_CENTER = { lat: 40.749933, lng: -73.98633 };

export default function Landing() {
  const location = useLocation();
  const mapRef = useRef(null);
  const mapWrapRef = useRef(null);

  const directionsPanelRef = useRef(null);

  const originPickerRef = useRef(null);
  const destPickerRef = useRef(null);

  const { loc: userLoc, resolved: geoResolved } = useGeolocation();
  const { ready: mapsReady, error: mapsError } = useGoogleMapsReady();
  const canRenderMap = mapsReady && geoResolved;

  // State used by sidebar + to enable buttons; routing uses refs for latest values
  const [origin, setOriginState] = useState(null);
  const [destination, setDestinationState] = useState(null);
  const [routeCombo, setRouteCombo] = useState(ROUTE_COMBO.TRANSIT);
  // Avoid-hills slider expressed in degrees. 25° roughly covers very steep city streets.
  const [hillMaxDeg, setHillMaxDeg] = useState(25);

  // ✅ Transit time controls
  // "NOW" | "DEPART_AT" | "ARRIVE_BY"
  const [timeKind, setTimeKind] = useState("NOW");
  const [timeValue, setTimeValue] = useState(() => new Date());

  // Keep the disabled "Leave now" timestamp fresh so the UI reflects actual now.
  // This does NOT affect routing requests (we omit transitOptions for NOW);
  // it only ensures the displayed datetime doesn't get stuck at initial page-load time.
  useEffect(() => {
    if (timeKind !== "NOW") return;
    const tick = () => setTimeValue(new Date());
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [timeKind]);

  // Tracks last directions request signature so we can “drain” the button until inputs change.
  const [lastQueryKey, setLastQueryKey] = useState("");

  const travelModeForCombo = useMemo(() => {
    switch (routeCombo) {
      case ROUTE_COMBO.BIKE:
        return "BICYCLING";
      case ROUTE_COMBO.SKATE:
        return "WALKING"; // temporary until skateboard timing override exists
      default:
        return "TRANSIT";
    }
  }, [routeCombo]);

  const llKey = (ll) => {
    const p = toLatLngLiteral(ll);
    return p ? `${p.lat.toFixed(6)},${p.lng.toFixed(6)}` : "none";
  };

  const computeQueryKey = useMemo(
    () =>
      ({ originOverride, destinationOverride } = {}) => {
        const o = originOverride ?? origin ?? userLoc ?? FALLBACK_CENTER;
        const d = destinationOverride ?? destination;

        return [
          `combo:${routeCombo}`,
          `mode:${travelModeForCombo}`,
          `o:${llKey(o)}`,
          `d:${llKey(d)}`,
          `hillDeg:${Math.round(hillMaxDeg)}`,
          `time:${timeKind}:${timeKind === "NOW" ? "now" : timeValue.toISOString()}`,
        ].join("|");
      },
    [origin, destination, userLoc, routeCombo, travelModeForCombo, hillMaxDeg, timeKind, timeValue]
  );

  const currentQueryKey = computeQueryKey();
  const directionsDirty = Boolean(destination) && currentQueryKey !== lastQueryKey;

  // Refs for stable “latest value” access inside map listeners
  const originRef = useRef(origin);
  const destinationRef = useRef(destination);
  const userLocRef = useRef(userLoc);
  const routeComboRef = useRef(routeCombo);
  const hillMaxDegRef = useRef(hillMaxDeg);
  const travelModeRef = useRef("TRANSIT");
  const initialUrlStateRef = useRef(
    typeof window !== "undefined" ? parseRoutingSearch(window.location.search) : null
  );
  const initialUrlAppliedRef = useRef(false);
  const initialPickerSeededRef = useRef(false);
  const initialGeoOriginSeededRef = useRef(false);
  const pendingAutorunRef = useRef(null);
  const autorunStartedRef = useRef(false);
  const lastHandledSearchRef = useRef(location.search || "");

  const setOrigin = useCallback((next) => {
    const resolved = typeof next === "function" ? next(originRef.current) : next;
    originRef.current = resolved;
    setOriginState(resolved);
  }, []);

  const setDestination = useCallback((next) => {
    const resolved = typeof next === "function" ? next(destinationRef.current) : next;
    destinationRef.current = resolved;
    setDestinationState(resolved);
  }, []);

  // Default origin state to geolocation for routing.
  useEffect(() => {
    if (userLoc) setOrigin((prev) => prev ?? userLoc);
  }, [userLoc, setOrigin]);

  useEffect(() => void (originRef.current = origin), [origin]);
  useEffect(() => void (destinationRef.current = destination), [destination]);
  useEffect(() => void (userLocRef.current = userLoc), [userLoc]);
  useEffect(() => void (routeComboRef.current = routeCombo), [routeCombo]);
  useEffect(() => void (hillMaxDegRef.current = hillMaxDeg), [hillMaxDeg]);

  useEffect(() => {
    travelModeRef.current = travelModeForCombo;
  }, [travelModeForCombo]);

  // ✅ transit time ref for routing
  const transitTimeRef = useRef({ kind: "NOW", date: null });

  useEffect(() => {
    transitTimeRef.current = {
      kind: timeKind,
      date: timeValue,
    };
  }, [timeKind, timeValue]);

  const commitSuccessfulSearchToUrl = useCallback((triggerType, queryState) => {
    if (typeof window === "undefined") return;
    if (!queryState?.origin || !queryState?.destination) return;

    const search = buildRoutingSearch(
      {
        ...queryState,
        hillMaxDeg: Number.isFinite(Number(queryState?.hillMaxDeg))
          ? Number(queryState.hillMaxDeg)
          : Number(hillMaxDegRef.current),
      },
      { includeWhenNow: true }
    );
    if (!search) return;

    const path = window.location.pathname || "/";
    const hash = window.location.hash || "";
    const currentUrl = `${path}${window.location.search || ""}${hash}`;
    const nextUrl = `${path}${search}${hash}`;
    if (nextUrl === currentUrl) return;

    const historyMode = historyModeForTrigger(triggerType);
    if (historyMode === "push") window.history.pushState(null, "", nextUrl);
    else window.history.replaceState(null, "", nextUrl);
  }, []);

  const handleRoutingSearchSuccess = useCallback(
    ({ triggerType, queryState } = {}) => {
      if (!queryState?.origin || !queryState?.destination) return;
      setLastQueryKey(
        computeQueryKey({
          originOverride: queryState.origin,
          destinationOverride: queryState.destination,
        })
      );
      commitSuccessfulSearchToUrl(triggerType, queryState);
    },
    [computeQueryKey, commitSuccessfulSearchToUrl]
  );

  // Set initial center on the web component itself
  useEffect(() => {
    if (!canRenderMap) return;
    const mapEl = mapRef.current;
    if (!mapEl) return;
    mapEl.center = userLoc ?? FALLBACK_CENTER;
    mapEl.zoom = 13;
  }, [canRenderMap, userLoc]);

  // Get google.maps.Map (innerMap) and set map type once it exists
  const innerMap = useInnerMap(mapRef, canRenderMap);

  useEffect(() => {
    if (!innerMap) return;
    innerMap.setMapTypeId("hybrid");
  }, [innerMap]);

  // From-picker: track “user picked” + prefill only when needed
  const fromPrefill = usePickerPrefill(originPickerRef, canRenderMap);

  // Right click menu state/behavior
  const { ctxMenu, setCtxMenu } = useMapContextMenu({
    enabled: Boolean(innerMap) && canRenderMap,
    map: innerMap,
    mapWrapRef,
  });

  // Routing engine (directions + markers + detours + alternates)
  const routing = useRouting({
    enabled: Boolean(innerMap) && canRenderMap,
    map: innerMap,
    panelRef: directionsPanelRef,

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

    markFromPicked: fromPrefill.markPicked,
    fallbackCenter: FALLBACK_CENTER,
    onSearchSuccess: handleRoutingSearchSuccess,
  });

  useEffect(() => {
    if (initialUrlAppliedRef.current) return;
    initialUrlAppliedRef.current = true;

    const parsed = initialUrlStateRef.current;
    if (!parsed) return;

    const mode = parsed.mode ?? ROUTE_COMBO.TRANSIT;
    routeComboRef.current = mode;
    setRouteCombo(mode);

    const normalizedWhen =
      parsed.when?.kind === "DEPART_AT" || parsed.when?.kind === "ARRIVE_BY"
        ? {
            kind: parsed.when.kind,
            date:
              parsed.when.date instanceof Date &&
              !Number.isNaN(parsed.when.date.getTime())
                ? parsed.when.date
                : new Date(),
          }
        : { kind: "NOW", date: null };

    transitTimeRef.current = normalizedWhen;
    setTimeKind(normalizedWhen.kind);
    if (normalizedWhen.kind === "NOW") setTimeValue(new Date());
    else setTimeValue(normalizedWhen.date);

    if (parsed.origin) {
      fromPrefill.markPicked();
      setOrigin(parsed.origin);
    }
    if (parsed.destination) {
      setDestination(parsed.destination);
    }

    if (parsed.hasValidEndpoints) {
      pendingAutorunRef.current = {
        origin: parsed.origin,
        destination: parsed.destination,
        via: parsed.via,
        mode,
        transitTime: normalizedWhen,
      };
    }
  }, [fromPrefill, setDestination, setOrigin]);

  useEffect(() => {
    if (!canRenderMap) return;
    if (initialPickerSeededRef.current) return;

    const parsed = initialUrlStateRef.current;
    if (!parsed) return;
    initialPickerSeededRef.current = true;

    if (parsed.origin) {
      populatePlacePickerFromLatLng(originPickerRef.current, parsed.origin).finally(() => {
        closePickerSuggestions(originPickerRef.current);
      });
    }

    if (parsed.destination) {
      populatePlacePickerFromLatLng(destPickerRef.current, parsed.destination).finally(() => {
        closePickerSuggestions(destPickerRef.current);
      });
    }
  }, [canRenderMap]);

  useEffect(() => {
    if (!canRenderMap || !userLoc) return;
    if (initialGeoOriginSeededRef.current) return;

    const parsed = initialUrlStateRef.current;
    if (parsed?.origin) {
      initialGeoOriginSeededRef.current = true;
      return;
    }

    initialGeoOriginSeededRef.current = true;
    fromPrefill.prefillIfEmpty(userLoc);
  }, [canRenderMap, fromPrefill, userLoc]);

  useEffect(() => {
    const nextSearch = location.search || "";
    if (nextSearch === lastHandledSearchRef.current) return;
    lastHandledSearchRef.current = nextSearch;

    const parsed = parseRoutingSearch(nextSearch);
    if (!parsed?.hasValidEndpoints) return;

    const mode = parsed.mode ?? ROUTE_COMBO.TRANSIT;
    routeComboRef.current = mode;
    setRouteCombo(mode);

    const normalizedWhen =
      parsed.when?.kind === "DEPART_AT" || parsed.when?.kind === "ARRIVE_BY"
        ? {
            kind: parsed.when.kind,
            date:
              parsed.when.date instanceof Date &&
              !Number.isNaN(parsed.when.date.getTime())
                ? parsed.when.date
                : new Date(),
          }
        : { kind: "NOW", date: null };

    transitTimeRef.current = normalizedWhen;
    setTimeKind(normalizedWhen.kind);
    if (normalizedWhen.kind === "NOW") setTimeValue(new Date());
    else setTimeValue(normalizedWhen.date);

    if (parsed.origin) {
      fromPrefill.markPicked();
      setOrigin(parsed.origin);
      populatePlacePickerFromLatLng(originPickerRef.current, parsed.origin).finally(() => {
        closePickerSuggestions(originPickerRef.current);
      });
    }

    if (parsed.destination) {
      setDestination(parsed.destination);
      populatePlacePickerFromLatLng(destPickerRef.current, parsed.destination).finally(() => {
        closePickerSuggestions(destPickerRef.current);
      });
    }

    pendingAutorunRef.current = {
      origin: parsed.origin,
      destination: parsed.destination,
      via: parsed.via,
      mode,
      transitTime: normalizedWhen,
    };
    autorunStartedRef.current = false;
  }, [fromPrefill, location.search, setDestination, setOrigin]);

  function prefillFromUserLocationIfNeeded() {
    const ul = userLocRef.current;
    if (ul && !fromPrefill.userPickedRef.current) {
      fromPrefill.prefillIfEmpty(ul);
    }
  }

  const executeSearch = useCallback(
    async ({
      triggerType,
      originOverride,
      destinationOverride,
      viaPointsOverride,
      alternatives = true,
      fitToRoutes = true,
      routeComboOverride,
      transitTimeOverride,
      suppressSuccessNotify = false,
    } = {}) => {
      const o =
        toLatLngLiteral(originOverride) ??
        toLatLngLiteral(originRef.current) ??
        toLatLngLiteral(origin) ??
        toLatLngLiteral(userLocRef.current) ??
        FALLBACK_CENTER;
      const d =
        toLatLngLiteral(destinationOverride) ??
        toLatLngLiteral(destinationRef.current) ??
        toLatLngLiteral(destination);
      if (!d) return { success: false, reason: "missing_destination" };

      return await routing.buildRoute({
        originOverride: o,
        destinationOverride: d,
        viaPointsOverride,
        alternatives,
        fitToRoutes,
        routeComboOverride,
        transitTimeOverride,
        triggerType,
        suppressSuccessNotify,
      });
    },
    [destination, origin, routing]
  );

  useEffect(() => {
    if (!canRenderMap || !routing.isReady) return;
    if (autorunStartedRef.current) return;

    const pending = pendingAutorunRef.current;
    if (!pending?.origin || !pending?.destination) return;

    autorunStartedRef.current = true;
    let cancelled = false;

    (async () => {
      const res = await executeSearch({
        triggerType: SEARCH_TRIGGER.AUTORUN,
        originOverride: pending.origin,
        destinationOverride: pending.destination,
        viaPointsOverride: pending.via,
        alternatives: pending.via?.length ? false : true,
        fitToRoutes: true,
        routeComboOverride: pending.mode,
        transitTimeOverride: pending.transitTime,
      });

      if (cancelled) return;
      if (res?.reason === "not_ready") {
        autorunStartedRef.current = false;
        return;
      }

      pendingAutorunRef.current = null;
    })().catch(() => {
      if (cancelled) return;
      autorunStartedRef.current = false;
    });

    return () => {
      cancelled = true;
    };
  }, [canRenderMap, executeSearch, routing.isReady]);

  async function onBuildRoute() {
    const o = originRef.current ?? origin ?? userLocRef.current ?? FALLBACK_CENTER;
    const d = destinationRef.current ?? destination;
    if (!d) return;

    // If the user is in "Leave now", refresh the displayed time at the moment they request directions.
    if (timeKind === "NOW") setTimeValue(new Date());

    prefillFromUserLocationIfNeeded();

    // Drain immediately; re-arms once inputs change
    setLastQueryKey(computeQueryKey({ originOverride: o, destinationOverride: d }));

    await executeSearch({
      triggerType: SEARCH_TRIGGER.EXPLICIT_GET_DIRECTIONS,
      originOverride: o,
      destinationOverride: d,
      alternatives: true,
    });
  }

  function onClearRoute() {
    routing.clearRoute();
  }

  async function directionsToHere(here) {
    setCtxMenu(null);

    if (timeKind === "NOW") setTimeValue(new Date());

    prefillFromUserLocationIfNeeded();

    closePickerSuggestions(originPickerRef.current);
    closePickerSuggestions(destPickerRef.current);

    setDestination(here);
    populatePlacePickerFromLatLng(destPickerRef.current, here).finally(() => {
      closePickerSuggestions(destPickerRef.current);
    });

    const o = originRef.current ?? origin ?? userLocRef.current ?? FALLBACK_CENTER;
    setLastQueryKey(computeQueryKey({ originOverride: o, destinationOverride: here }));

    await executeSearch({
      triggerType: SEARCH_TRIGGER.EXPLICIT_CONTEXT_SET_TO,
      originOverride: o,
      destinationOverride: here,
      alternatives: true,
    });
  }

  async function directionsFromHere(here) {
    setCtxMenu(null);

    if (timeKind === "NOW") setTimeValue(new Date());

    closePickerSuggestions(originPickerRef.current);
    closePickerSuggestions(destPickerRef.current);

    fromPrefill.markPicked();
    setOrigin(here);
    populatePlacePickerFromLatLng(originPickerRef.current, here).finally(() => {
      closePickerSuggestions(originPickerRef.current);
    });

    const d = destinationRef.current ?? destination;
    if (!d) return;

    setLastQueryKey(computeQueryKey({ originOverride: here, destinationOverride: d }));

    await executeSearch({
      triggerType: SEARCH_TRIGGER.EXPLICIT_CONTEXT_SET_FROM,
      originOverride: here,
      destinationOverride: d,
      alternatives: true,
    });
  }

  return (
    <main className={styles.container}>
      {!canRenderMap && (
        <div className={styles.loadingScreen} role="status" aria-live="polite">
          <div className={styles.loadingCard}>
            <div className={styles.spinner} aria-hidden="true" />
            <div className={styles.loadingText}>Loading map…</div>

            {mapsError && (
              <div className={styles.loadingError}>
                <strong>Map failed to load:</strong> {mapsError}
              </div>
            )}
          </div>
        </div>
      )}

      {canRenderMap && (
        <div className={styles.layout}>
          <DirectionsSidebar
            canRenderMap={canRenderMap}
            origin={origin}
            userLoc={userLoc}
            setOrigin={setOrigin}
            destination={destination}
            setDestination={setDestination}
            routeCombo={routeCombo}
            setRouteCombo={setRouteCombo}
            hillMaxDeg={hillMaxDeg}
            setHillMaxDeg={setHillMaxDeg}
            timeKind={timeKind}
            setTimeKind={setTimeKind}
            timeValue={timeValue}
            setTimeValue={setTimeValue}
            onBuildRoute={onBuildRoute}
            onClearRoute={onClearRoute}
            directionsDirty={directionsDirty}
            directionsPanelRef={directionsPanelRef}
            originPickerRef={originPickerRef}
            destPickerRef={destPickerRef}
            routeOptions={routing.routeOptions}
            isLoadingRoutes={routing.isLoading}
            routeError={routing.routeError}
            selectedRouteIndex={routing.selectedRouteIndex}
            onSelectRoute={routing.selectRoute}
            onZoomToRoute={routing.zoomToRoute}
            onZoomToAllRoutes={routing.zoomToAllRoutes}
            selectedSegments={routing.selectedSegments}
            showGooglePanel={routing.showGooglePanel}
          />

          <div className={styles.mapWrap} ref={mapWrapRef}>
            <gmp-map
              ref={mapRef}
              id="map"
              map-id="DEMO_MAP_ID"
              style={{ height: "100%", width: "100%", display: "block" }}
            />

            {ctxMenu && (
              <div
                className={styles.contextMenu}
                style={{ left: ctxMenu.x, top: ctxMenu.y }}
                data-map-contextmenu="true"
                onContextMenu={(e) => e.preventDefault()}
              >
                <button
                  type="button"
                  className={styles.contextMenuItem}
                  onClick={() => directionsFromHere(ctxMenu.here)}
                >
                  Directions from here
                </button>
                <button
                  type="button"
                  className={styles.contextMenuItem}
                  onClick={() => directionsToHere(ctxMenu.here)}
                >
                  Directions to here
                </button>
              </div>
            )}
          </div>
          <AuthSidebar />
        </div>
      )}
    </main>
  );
}
