// src/components/DirectionsSidebar/DirectionsSidebar.jsx
import { useEffect, useMemo, useRef } from "react";
import styles from "./DirectionsSidebar.module.css";
import { createStartIcon, createEndIcon } from "../../maps/markerIcons";

function placeToLatLng(place) {
  const loc = place?.location;
  if (!loc) return null;
  return typeof loc.lat === "function" ? { lat: loc.lat(), lng: loc.lng() } : loc;
}

export default function DirectionsSidebar({
  canRenderMap,
  userLoc,
  setOrigin,
  destination,
  setDestination,
  travelMode,
  setTravelMode,
  onBuildRoute,
  onClearRoute,
  directionsPanelRef,

  originPickerRef,
  destPickerRef,

  routeOptions = [],
  selectedRouteIndex = 0,
  onSelectRoute,
}) {
  const internalOriginRef = useRef(null);
  const internalDestRef = useRef(null);

  const originRef = originPickerRef ?? internalOriginRef;
  const destRef = destPickerRef ?? internalDestRef;

  // Sidebar icons that match map marker SVGs
  const startIconUrl = useMemo(() => {
    if (!canRenderMap) return null;
    try {
      return createStartIcon().url;
    } catch {
      return null;
    }
  }, [canRenderMap]);

  const endIconUrl = useMemo(() => {
    if (!canRenderMap) return null;
    try {
      return createEndIcon().url;
    } catch {
      return null;
    }
  }, [canRenderMap]);

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

  useEffect(() => {
    if (!canRenderMap) return;

    const originEl = originRef.current;
    const destEl = destRef.current;
    if (!originEl || !destEl) return;

    const onOrigin = (e) => {
      const place = e?.target?.value ?? originEl.value;
      const ll = placeToLatLng(place);
      if (ll) setOrigin(ll);
    };

    const onDest = (e) => {
      const place = e?.target?.value ?? destEl.value;
      const ll = placeToLatLng(place);
      if (ll) setDestination(ll);
    };

    originEl.addEventListener("gmpx-placechange", onOrigin);
    destEl.addEventListener("gmpx-placechange", onDest);

    return () => {
      originEl.removeEventListener("gmpx-placechange", onOrigin);
      destEl.removeEventListener("gmpx-placechange", onDest);
    };
  }, [canRenderMap, setOrigin, setDestination, originRef, destRef]);

  const showRoutes = routeOptions?.length > 1 && typeof onSelectRoute === "function";

  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarHeader}>Directions</div>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          {startIconUrl && (
            <img
              className={styles.markerIconStart}
              src={startIconUrl}
              alt=""
              aria-hidden="true"
            />
          )}
          <div className={styles.label}>From</div>
        </div>

        <gmpx-place-picker ref={originRef} for-map="map" placeholder="Start location" />

        <div className={styles.hint}>
          If you leave this blank, your current location is used (when available).
        </div>
      </div>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          {endIconUrl && (
            <img
              className={styles.markerIconEnd}
              src={endIconUrl}
              alt=""
              aria-hidden="true"
            />
          )}
          <div className={styles.label}>To</div>
        </div>

        <gmpx-place-picker ref={destRef} for-map="map" placeholder="Destination" />
      </div>

      <div className={styles.field}>
        <div className={styles.label}>Mode</div>
        <select
          className={styles.select}
          value={travelMode}
          onChange={(e) => setTravelMode(e.target.value)}
        >
          <option value="DRIVING">Driving</option>
          <option value="WALKING">Walking</option>
          <option value="BICYCLING">Biking</option>
          <option value="TRANSIT">Transit</option>
        </select>
      </div>

      {showRoutes && (
        <div className={styles.routes}>
          <div className={styles.routesTitle}>Routes</div>
          {routeOptions.map((r) => (
            <label key={r.index} className={styles.routeRow}>
              <input
                className={styles.routeRadio}
                type="radio"
                name="route"
                checked={selectedRouteIndex === r.index}
                onChange={() => onSelectRoute(r.index)}
              />
              <div className={styles.routeText}>
                <div className={styles.routeMain}>
                  {r.durationText ? r.durationText : "—"}{" "}
                  {r.distanceText ? `· ${r.distanceText}` : ""}
                </div>
                <div className={styles.routeSub}>{r.summary}</div>
              </div>
            </label>
          ))}
        </div>
      )}

      <div className={styles.actions}>
        <button
          className={styles.primaryBtn}
          onClick={onBuildRoute}
          disabled={!destination}
        >
          Get directions
        </button>
        <button className={styles.secondaryBtn} onClick={onClearRoute}>
          Clear
        </button>
      </div>

      <div ref={directionsPanelRef} className={styles.panel} />
    </aside>
  );
}
