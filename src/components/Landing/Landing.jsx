// src/components/Landing/Landing.jsx
import { useEffect, useRef, useState, useMemo } from "react";
import styles from "./Landing.module.css";
import DirectionsSidebar from "../DirectionsSidebar/DirectionsSidebar.jsx";
import { useGoogleMapsReady } from "../../hooks/useGoogleMapsReady";
import { useGeolocation } from "../../hooks/useGeolocation";

import { useInnerMap } from "../../hooks/useInnerMap";
import { usePickerPrefill } from "../../hooks/usePickerPrefill";
import { useMapContextMenu } from "../../hooks/useMapContextMenu";
import { useRouting } from "../../hooks/useRouting";
import { ROUTE_COMBO } from "../../routing/routeCombos";

import { populatePlacePickerFromLatLng } from "../../maps/placePicker";
import { toLatLngLiteral } from "../../maps/directionsUtils";

const FALLBACK_CENTER = { lat: 40.749933, lng: -73.98633 };

export default function Landing() {
  const mapRef = useRef(null);
  const mapWrapRef = useRef(null);

  const directionsPanelRef = useRef(null);

  const originPickerRef = useRef(null);
  const destPickerRef = useRef(null);

  const { loc: userLoc, resolved: geoResolved } = useGeolocation();
  const { ready: mapsReady, error: mapsError } = useGoogleMapsReady();
  const canRenderMap = mapsReady && geoResolved;

  // State used by sidebar + to enable buttons; routing uses refs for latest values
  const [origin, setOrigin] = useState(null);
  const [destination, setDestination] = useState(null);
  const [routeCombo, setRouteCombo] = useState(ROUTE_COMBO.TRANSIT);
  // Avoid-hills slider expressed in degrees. 25° roughly covers very steep city streets.
  const [hillMaxDeg, setHillMaxDeg] = useState(25);

  // ✅ Transit time controls
  // "NOW" | "DEPART_AT" | "ARRIVE_BY"
  const [timeKind, setTimeKind] = useState("NOW");
  const [timeValue, setTimeValue] = useState(() => new Date());

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

  // Default origin state to geolocation for routing (no UI fill on load)
  useEffect(() => {
    if (userLoc) setOrigin((prev) => prev ?? userLoc);
  }, [userLoc]);

  // Refs for stable “latest value” access inside map listeners
  const originRef = useRef(origin);
  const destinationRef = useRef(destination);
  const userLocRef = useRef(userLoc);
  const routeComboRef = useRef(routeCombo);
  const hillMaxDegRef = useRef(hillMaxDeg);
  const travelModeRef = useRef("TRANSIT");

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
      date: timeKind === "NOW" ? null : timeValue,
    };
  }, [timeKind, timeValue]);

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
  });

  function prefillFromUserLocationIfNeeded() {
    const ul = userLocRef.current;
    if (ul && !fromPrefill.userPickedRef.current) {
      fromPrefill.prefillIfEmpty(ul);
    }
  }

  async function onBuildRoute() {
    const d = destination;
    if (!d) return;

    prefillFromUserLocationIfNeeded();

    // Drain immediately; re-arms once inputs change
    setLastQueryKey(computeQueryKey());

    await routing.buildRoute({ destinationOverride: d, alternatives: true });
  }

  function onClearRoute() {
    routing.clearRoute();
  }

  async function directionsToHere(here) {
    setCtxMenu(null);

    prefillFromUserLocationIfNeeded();

    setDestination(here);
    populatePlacePickerFromLatLng(destPickerRef.current, here);

    setLastQueryKey(computeQueryKey({ destinationOverride: here }));

    await routing.buildRoute({
      destinationOverride: here,
      alternatives: true,
    });
  }

  async function directionsFromHere(here) {
    setCtxMenu(null);

    fromPrefill.markPicked();
    setOrigin(here);
    populatePlacePickerFromLatLng(originPickerRef.current, here);

    const d = destinationRef.current;
    if (!d) return;

    setLastQueryKey(computeQueryKey({ originOverride: here }));

    await routing.buildRoute({
      originOverride: here,
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
            selectedRouteIndex={routing.selectedRouteIndex}
            onSelectRoute={routing.selectRoute}
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
        </div>
      )}
    </main>
  );
}
