// src/components/Landing/Landing.jsx
import { useEffect, useRef, useState } from "react";
import styles from "./Landing.module.css";
import DirectionsSidebar from "../DirectionsSidebar/DirectionsSidebar.jsx";
import { useGoogleMapsReady } from "../../hooks/useGoogleMapsReady";
import { useGeolocation } from "../../hooks/useGeolocation";

import { useInnerMap } from "../../hooks/useInnerMap";
import { usePickerPrefill } from "../../hooks/usePickerPrefill";
import { useMapContextMenu } from "../../hooks/useMapContextMenu";
import { useRouting } from "../../hooks/useRouting";

import { populatePlacePickerFromLatLng } from "../../maps/placePicker";

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
  const [travelMode, setTravelMode] = useState("DRIVING");

  // Default origin state to geolocation for routing (no UI fill on load)
  useEffect(() => {
    if (userLoc) setOrigin((prev) => prev ?? userLoc);
  }, [userLoc]);

  // Refs for stable “latest value” access inside map listeners
  const originRef = useRef(origin);
  const destinationRef = useRef(destination);
  const travelModeRef = useRef(travelMode);
  const userLocRef = useRef(userLoc);

  useEffect(() => void (originRef.current = origin), [origin]);
  useEffect(() => void (destinationRef.current = destination), [destination]);
  useEffect(() => void (travelModeRef.current = travelMode), [travelMode]);
  useEffect(() => void (userLocRef.current = userLoc), [userLoc]);

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

    setOrigin,
    setDestination,

    originPickerRef,
    destPickerRef,

    markFromPicked: fromPrefill.markPicked,
    fallbackCenter: FALLBACK_CENTER,
  });

  async function onBuildRoute() {
    const d = destinationRef.current;
    if (!d) return;

    // If From UI is blank and user didn’t pick a From, prefill with geolocation (when available)
    const ul = userLocRef.current;
    if (ul && !fromPrefill.userPickedRef.current) {
      fromPrefill.prefillIfEmpty(ul);
    }

    await routing.buildRoute({ alternatives: true });
  }

  function onClearRoute() {
    routing.clearRoute();
  }

  async function directionsToHere(here) {
    setCtxMenu(null);

    // If From is still blank/unpicked, prefill From with geolocation (only in this scenario)
    const ul = userLocRef.current;
    if (ul && !fromPrefill.userPickedRef.current) {
      fromPrefill.prefillIfEmpty(ul);
    }

    setDestination(here);
    populatePlacePickerFromLatLng(destPickerRef.current, here);

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
            travelMode={travelMode}
            setTravelMode={setTravelMode}
            onBuildRoute={onBuildRoute}
            onClearRoute={onClearRoute}
            directionsPanelRef={directionsPanelRef}
            originPickerRef={originPickerRef}
            destPickerRef={destPickerRef}
            routeOptions={routing.routeOptions}
            selectedRouteIndex={routing.selectedRouteIndex}
            onSelectRoute={routing.selectRoute}
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
