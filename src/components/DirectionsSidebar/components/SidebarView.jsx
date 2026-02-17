import { placeToLatLng } from "../../../maps/directionsUtils";
import styles from "../styles/styles.js";
import RouteDetails from "../../RouteDetails/RouteDetails.jsx";
import { BackIcon, ChevronLeftIcon, ChevronRightIcon, SwapIcon } from "./icons";
import { RouteCard } from "./RouteCard";
import { ItinBubble } from "./ItineraryBar";
import { toDatetimeLocalValue, fromDatetimeLocalValue } from "../utils/datetimeLocal";
import { buildRouteDetailsModel } from "../model/routeDetailsModel";
import { timeRangeTextForOption } from "../utils/sidebarFormat";

export function SidebarView(props) {
  const HILL_MAX_SLIDER_DEG = 25;

  const {
    collapsed,
    setCollapsed,
    detailsMode,
    setDetailsMode,
    showRoutes,
    transitOn,
    bikeOn,
    skateOn,
    setRouteCombo,
    nextCombo,
    routeCombo,
    startIconUrl,
    endIconUrl,
    originRef,
    destRef,
    handleSwap,
    destination,
    timeKind,
    setTimeKind,
    timeValue,
    setTimeValue,
    onBuildRoute,
    onClearRoute,
    directionsDirty,
    hillMaxDeg,
    setHillMaxDeg,
    directionsPanelRef,
    resultsScrollRef,
    inlineDetailsRef,
    isLoadingRoutes,
    routeError,
    routeOptions,
    selectedRouteIndex,
    onSelectRoute,
    onZoomToAllRoutes,
    onZoomToRoute,
    detailsRouteModelDisplay,
    selectedOption,
    detailsItinRef,
    detailsItinSegs,
    pickerSnapshotRef,
  } = props;

  const detailsTimeText = selectedOption ? timeRangeTextForOption(selectedOption) : "";

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
              onMouseDown={(e) => e.preventDefault()}
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
                title={timeKind === "NOW" ? "Current time (Leave now)" : "Select date and time"}
              />
            </div>
          </div>

          <div className={styles.field}>
            <div className={styles.labelRow}>
              <div className={styles.label}>Avoid hills</div>
              <div className={styles.hillValue}>{Math.round(hillMaxDeg ?? HILL_MAX_SLIDER_DEG)}°</div>
            </div>
            <input
              className={styles.slider}
              type="range"
              min="0"
              max={String(HILL_MAX_SLIDER_DEG)}
              step="1"
              value={HILL_MAX_SLIDER_DEG - Math.round(hillMaxDeg ?? HILL_MAX_SLIDER_DEG)}
              onChange={(e) =>
                setHillMaxDeg(
                  Math.max(
                    0,
                    Math.min(HILL_MAX_SLIDER_DEG, HILL_MAX_SLIDER_DEG - Number(e.target.value))
                  )
                )
              }
            />
            <div className={styles.hint}>
              Lower values avoid steeper inclines. 25° covers very steep city streets.
            </div>
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
          <div className={styles.detailsFull}>
            <div className={`${styles.detailsPane} ${styles.detailsPaneFull}`}>
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
                      onClick={() => {
                        onZoomToAllRoutes?.();
                        setDetailsMode("NONE");
                      }}
                      aria-label="Back"
                    >
                      <BackIcon />
                    </button>

                    <div className={styles.detailsTopRow}>
                    <div className={styles.detailsTimes}>{detailsTimeText}</div>
                      <div className={styles.detailsDuration}>{selectedOption.durationText || "—"}</div>
                    </div>
                  </div>

                  <div ref={detailsItinRef} className={styles.detailsItinBar}>
                    {detailsItinSegs.map((s) => (
                      <ItinBubble key={s.key} seg={s} />
                    ))}
                  </div>
                </div>
              </div>

              <div className={styles.detailsFullBody}>
                <RouteDetails route={detailsRouteModelDisplay} hideTop bare />
              </div>
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
                        onClick={() => {
                          onZoomToAllRoutes?.();
                          setDetailsMode("NONE");
                        }}
                        aria-label="Back"
                      >
                        <BackIcon />
                      </button>

                      <div className={styles.detailsTopRow}>
                      <div className={styles.detailsTimes}>{detailsTimeText}</div>
                        <div className={styles.detailsDuration}>{selectedOption.durationText || "—"}</div>
                      </div>
                    </div>

                    <div ref={detailsItinRef} className={styles.detailsItinBar}>
                      {detailsItinSegs.map((s) => (
                        <ItinBubble key={s.key} seg={s} />
                      ))}
                    </div>
                  </div>

                  <RouteDetails route={detailsRouteModelDisplay} hideTop />
                </div>

                <div ref={directionsPanelRef} className={styles.hiddenPanel} />
              </div>
            ) : (
              <>
                {showRoutes && (
                  <div className={styles.routesCards}>
                    {isLoadingRoutes ? (
                      <div className={styles.routesLoading}>
                        <div className={styles.routesSpinner} aria-hidden="true" />
                        <div className={styles.routesLoadingText}>Loading routes…</div>
                      </div>
                    ) : routeError ? (
                      <div className={styles.routesLoading} role="alert" aria-live="assertive">
                        <div className={styles.routesErrorIcon} aria-hidden="true">
                          X
                        </div>
                        <div className={styles.routesErrorText}>{routeError}</div>
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
                            onDetails={async () => {
                              if (selectedRouteIndex !== r.index) {
                                try {
                                  await onSelectRoute?.(r.index);
                                } catch {
                                  // ignore
                                }
                              }

                              onZoomToRoute?.(r.index);

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
