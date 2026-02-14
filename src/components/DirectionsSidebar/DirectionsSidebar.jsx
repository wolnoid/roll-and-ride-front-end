import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./DirectionsSidebar.module.css";
import { getStartIconUrl, getEndIconUrl } from "../../maps/markerIconSvgs";
import { placeToLatLng } from "../../maps/directionsUtils";
import { usePlacePickerChange } from "../../hooks/usePlacePickerChange";
import {
  populatePlacePickerFromLatLng,
  forcePickerText,
} from "../../maps/placePicker";
import {
  isTransitOn,
  isBikeOn,
  isSkateOn,
  nextCombo,
} from "../../routing/routeCombos";

const LS_KEY = "carpool.sidebarCollapsed";

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
  selectedRouteIndex = 0,
  onSelectRoute,

  selectedSegments = null,
  showGooglePanel = true,
}) {
  const internalOriginRef = useRef(null);
  const internalDestRef = useRef(null);

  const originRef = originPickerRef ?? internalOriginRef;
  const destRef = destPickerRef ?? internalDestRef;

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
      if (ll) setOrigin(ll);
    },
    [setOrigin]
  );

  const handleDestPlaceChange = useCallback(
    (e, destEl) => {
      const place = e?.target?.value ?? destEl.value;
      const ll = placeToLatLng(place);
      if (ll) setDestination(ll);
    },
    [setDestination]
  );

  usePlacePickerChange(originRef, canRenderMap, handleOriginPlaceChange);
  usePlacePickerChange(destRef, canRenderMap, handleDestPlaceChange);

  const showRoutes =
    routeOptions?.length > 1 && typeof onSelectRoute === "function";

  const transitOn = isTransitOn(routeCombo);
  const bikeOn = isBikeOn(routeCombo);
  const skateOn = isSkateOn(routeCombo);

  const handleSwap = useCallback(async () => {
    const originPlace = originRef.current?.value ?? null;
    const destPlace = destRef.current?.value ?? null;

    const currentOriginLL = placeToLatLng(originPlace) ?? userLoc ?? null;
    const currentDestLL = destination ?? placeToLatLng(destPlace) ?? null;

    if (!currentDestLL) return;

    setOrigin(currentDestLL);
    if (currentOriginLL) setDestination(currentOriginLL);
    else setDestination(null);

    if (originRef.current) {
      await populatePlacePickerFromLatLng(originRef.current, currentDestLL);
    }
    if (destRef.current) {
      if (currentOriginLL)
        await populatePlacePickerFromLatLng(destRef.current, currentOriginLL);
      else forcePickerText(destRef.current, "");
    }
  }, [originRef, destRef, destination, setOrigin, setDestination, userLoc]);

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
        <div className={styles.topControls}>
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

                  // If switching to NOW, the effect above will set timeValue to current time.
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
        </div>

        <div className={styles.resultsScroll}>
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
                    {(r.timeRangeText || (r.departTimeText && r.arriveTimeText)) && (
                      <div className={styles.routeTimes}>
                        {r.timeRangeText || `${r.departTimeText}–${r.arriveTimeText}`}
                      </div>
                    )}
                    <div className={styles.routeSub}>{r.summary}</div>
                  </div>
                </label>
              ))}
            </div>
          )}

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

          {selectedSegments && (
            <div className={styles.segments}>
              <div className={styles.routesTitle}>Itinerary</div>
              {selectedSegments.map((s, i) => (
                <div key={i} className={styles.segmentRow}>
                  <strong>{s.mode}</strong> · {s.durationText}
                </div>
              ))}
            </div>
          )}

          {showGooglePanel && <div ref={directionsPanelRef} className={styles.panel} />}
        </div>
      </div>
    </aside>
  );
}
