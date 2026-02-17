import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { getStartIconUrl, getEndIconUrl } from "../../maps/markerIconSvgs";
import { placeToLatLng } from "../../maps/directionsUtils";
import { getPickerText, closePickerSuggestions } from "../../maps/placePicker";
import { usePlacePickerChange } from "../../hooks/usePlacePickerChange";

import { ROUTE_COMBO, isTransitOn, isBikeOn, isSkateOn, nextCombo } from "../../routing/routeCombos";
import { buildRoutingSearch, parseRoutingSearch } from "../../routing/urlState";
import { UserContext } from "../../contexts/UserContext";
import * as savedDirectionsService from "../../services/savedDirectionsService";

import { SidebarView } from "./components/SidebarView";
import { SaveDirectionModal } from "./components/SaveDirectionModal";
import { useSidebarPickers } from "./hooks/useSidebarPickers";
import { buildRouteDetailsModel } from "./model/routeDetailsModel";
import { buildSidebarSegments } from "./utils/sidebarSegments";
import { carryHiddenMinuteMovesExceptEnds, useItinerarySegmentsFit } from "./utils/itineraryFit";
import {
  DIRECTIONS_SIDEBAR_EXPAND_EVENT,
  DIRECTIONS_SIDEBAR_LS_KEY,
  DIRECTIONS_SIDEBAR_OPEN_SAVE_EVENT,
} from "../../utils/directionsSidebarState";

export default function DirectionsSidebar({
  canRenderMap,
  origin,
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
  routeError = null,
  selectedRouteIndex = 0,
  onSelectRoute,

  // Map viewport helpers
  onZoomToRoute,
  onZoomToAllRoutes,
}) {

  const { user } = useContext(UserContext);

  const {
    originRef,
    destRef,
    originLLRef,
    destLLRef,
    pickerSnapshotRef,
    snapshotPickers,
    restorePickers,
    handleSwap,
  } = useSidebarPickers({
    origin,
    userLoc,
    destination,
    setOrigin,
    setDestination,
    originPickerRef,
    destPickerRef,
  });

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage?.getItem(DIRECTIONS_SIDEBAR_LS_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage?.setItem(DIRECTIONS_SIDEBAR_LS_KEY, collapsed ? "1" : "0");
    } catch {
      // ignore
    }
  }, [collapsed]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handleExpandRequest = () => setCollapsed(false);
    window.addEventListener(DIRECTIONS_SIDEBAR_EXPAND_EVENT, handleExpandRequest);
    return () => window.removeEventListener(DIRECTIONS_SIDEBAR_EXPAND_EVENT, handleExpandRequest);
  }, []);

  const startIconUrl = getStartIconUrl();
  const endIconUrl = getEndIconUrl();

  // Bias autocomplete toward the user's location.
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
        closePickerSuggestions(originEl);
        return;
      }

      // If user cleared the field, fall back to user location (if available).
      const txt = (getPickerText(originEl) || "").trim();
      if (!txt) {
        const fallback = userLoc ?? null;
        originLLRef.current = fallback;
        if (fallback) setOrigin(fallback);
      }
    },
    [setOrigin, userLoc, originLLRef]
  );

  const handleDestPlaceChange = useCallback(
    (e, destEl) => {
      const place = e?.target?.value ?? destEl.value;
      const ll = placeToLatLng(place);

      if (ll) {
        destLLRef.current = ll;
        setDestination(ll);
        closePickerSuggestions(destEl);
        return;
      }

      // If the user cleared the destination field, clear destination state too.
      const txt = (getPickerText(destEl) || "").trim();
      if (!txt) {
        destLLRef.current = null;
        setDestination(null);
      }
    },
    [setDestination, destLLRef]
  );

  usePlacePickerChange(originRef, canRenderMap, handleOriginPlaceChange);
  usePlacePickerChange(destRef, canRenderMap, handleDestPlaceChange);

  const canShowRoutes = typeof onSelectRoute === "function";
  const showRoutes =
    canShowRoutes &&
    (((routeOptions?.length ?? 0) >= 1) || isLoadingRoutes || Boolean(routeError));

  const transitOn = isTransitOn(routeCombo);
  const bikeOn = isBikeOn(routeCombo);
  const skateOn = isSkateOn(routeCombo);


  const [detailsMode, setDetailsMode] = useState("NONE");

  // ---- Save directions (bookmark) ----
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDesc, setSaveDesc] = useState("");
  const [saveAutoName, setSaveAutoName] = useState("");
  const [saveError, setSaveError] = useState(null);
  const [saveSaving, setSaveSaving] = useState(false);
  const [activeSavedId, setActiveSavedId] = useState(null);

  const readSavedIdFromHash = useCallback(() => {
    try {
      const hash = typeof window !== "undefined" ? window.location.hash || "" : "";
      const params = new URLSearchParams(hash.replace(/^#/, ""));
      const raw = params.get("sid");
      const n = raw ? Number(raw) : null;
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }, []);

  const buildBookmarkSearch = useCallback(() => {
    const parsed = typeof window !== "undefined" ? parseRoutingSearch(window.location.search) : null;
    const via = parsed?.via ?? [];

    const o = origin ?? userLoc ?? null;
    const d = destination ?? null;

    const when =
      timeKind === "DEPART_AT" || timeKind === "ARRIVE_BY"
        ? { kind: timeKind, date: timeValue }
        : { kind: "NOW", date: null };

    return buildRoutingSearch(
      {
        origin: o,
        destination: d,
        mode: routeCombo,
        via,
        when,
        hillMaxDeg,
      },
      { includeWhenNow: true }
    );
  }, [origin, userLoc, destination, routeCombo, timeKind, timeValue, hillMaxDeg]);

  const getPickerLabel = useCallback((pickerEl) => {
    try {
      return (getPickerText(pickerEl) || "").trim();
    } catch {
      return "";
    }
  }, []);

  const shortAddressLabel = useCallback((rawLabel, fallback) => {
    const raw = String(rawLabel || fallback || "").trim();
    if (!raw) return "";
    const [head] = raw.split(",");
    const trimmed = String(head || "").trim();
    return trimmed || raw;
  }, []);

  const formatModeLabel = useCallback((combo) => {
    const raw = String(combo || ROUTE_COMBO.TRANSIT).trim();
    if (!raw) return "transit";
    return raw
      .toLowerCase()
      .split(/[_+]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" + ");
  }, []);

  const computeAutoName = useCallback(() => {
    const oText = shortAddressLabel(getPickerLabel(originRef.current), "Current location");
    const dText = shortAddressLabel(getPickerLabel(destRef.current), "Destination");
    const modeText = formatModeLabel(routeCombo);
    return `${oText} → ${dText} by ${modeText}`;
  }, [getPickerLabel, shortAddressLabel, formatModeLabel, originRef, destRef, routeCombo]);

  const openSave = useCallback(() => {
    if (!user) return;
    const autoName = computeAutoName();
    setSaveAutoName(autoName);
    setSaveName(autoName);
    setSaveDesc("");
    setSaveError(null);
    setSaveSaving(false);
    setActiveSavedId(readSavedIdFromHash());
    setSaveOpen(true);
  }, [user, computeAutoName, readSavedIdFromHash]);

  const closeSave = useCallback(() => {
    setSaveOpen(false);
    setSaveError(null);
    setSaveSaving(false);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handleOpenSaveRequest = () => openSave();
    window.addEventListener(DIRECTIONS_SIDEBAR_OPEN_SAVE_EVENT, handleOpenSaveRequest);
    return () => window.removeEventListener(DIRECTIONS_SIDEBAR_OPEN_SAVE_EVENT, handleOpenSaveRequest);
  }, [openSave]);

  const persistHashSid = useCallback((sid, searchOverride) => {
    if (typeof window === "undefined") return;
    const path = window.location.pathname || "/";
    const search = searchOverride ?? window.location.search ?? "";
    const next = `${path}${search}${sid ? `#sid=${sid}` : ""}`;
    window.history.replaceState(null, "", next);
  }, []);

  const doSave = useCallback(
    async ({ update = false } = {}) => {
      if (!user) return;
      setSaveSaving(true);
      setSaveError(null);

      try {
        const origin_label = getPickerLabel(originRef.current) || "Current location";
        const destination_label = getPickerLabel(destRef.current) || "";
        const search = buildBookmarkSearch();
        if (!search) throw new Error("Missing origin or destination");

        const payload = {
          name: saveName,
          description: saveDesc,
          origin_label,
          destination_label,
          mode: routeCombo,
          search,
        };

        if (update) {
          const sid = activeSavedId;
          if (!sid) throw new Error("No saved direction selected to update");
          const updated = await savedDirectionsService.update(sid, payload);
          persistHashSid(updated?.id ?? sid, search);
        } else {
          const created = await savedDirectionsService.create(payload);
          persistHashSid(created?.id, search);
          setActiveSavedId(created?.id ?? null);
        }

        setSaveOpen(false);
      } catch (e) {
        setSaveError(e?.message || "Failed to save");
      } finally {
        setSaveSaving(false);
      }
    },
    [
      user,
      getPickerLabel,
      originRef,
      destRef,
      buildBookmarkSearch,
      saveName,
      saveDesc,
      routeCombo,
      activeSavedId,
      persistHashSid,
    ]
  );

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

  // Ensure loading state is always visible in the routes list (not hidden behind details mode).
  useEffect(() => {
    if (isLoadingRoutes) setDetailsMode("NONE");
  }, [isLoadingRoutes]);

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

  const detailsItinBaseSegs = useMemo(() => {
    if (!selectedOption) return [];
    return carryHiddenMinuteMovesExceptEnds(buildSidebarSegments(selectedOption, routeCombo));
  }, [selectedOption, routeCombo]);

  const { barRef: detailsItinRef, segs: detailsItinSegs } = useItinerarySegmentsFit(detailsItinBaseSegs);

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

  // While already viewing route details, selecting a different route on the map should
  // zoom/focus to that newly-selected route. Outside of details view, map clicks should
  // NOT change the current viewport.
  const prevDetailsModeForZoomRef = useRef(detailsMode);
  const prevSelectedIdxForZoomRef = useRef(selectedRouteIndex);
  useEffect(() => {
    const prevMode = prevDetailsModeForZoomRef.current;
    const prevIdx = prevSelectedIdxForZoomRef.current;

    // Update refs first for the next run.
    prevDetailsModeForZoomRef.current = detailsMode;
    prevSelectedIdxForZoomRef.current = selectedRouteIndex;

    const wasInDetails = prevMode !== "NONE";
    const isInDetails = detailsMode !== "NONE";
    if (!wasInDetails || !isInDetails) return;
    if (prevIdx === selectedRouteIndex) return;

    if (typeof onZoomToRoute === "function") onZoomToRoute(selectedRouteIndex);
  }, [detailsMode, selectedRouteIndex, onZoomToRoute]);


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


  return (
    <>
      <SidebarView
      collapsed={collapsed}
      setCollapsed={setCollapsed}
      detailsMode={detailsMode}
      setDetailsMode={setDetailsMode}
      showRoutes={showRoutes}
      transitOn={transitOn}
      bikeOn={bikeOn}
      skateOn={skateOn}
      setRouteCombo={setRouteCombo}
      nextCombo={nextCombo}
      routeCombo={routeCombo}
      startIconUrl={startIconUrl}
      endIconUrl={endIconUrl}
      originRef={originRef}
      destRef={destRef}
      handleSwap={handleSwap}
      destination={destination}
      timeKind={timeKind}
      setTimeKind={setTimeKind}
      timeValue={timeValue}
      setTimeValue={setTimeValue}
      onBuildRoute={onBuildRoute}
      onClearRoute={onClearRoute}
      directionsDirty={directionsDirty}
      hillMaxDeg={hillMaxDeg}
      setHillMaxDeg={setHillMaxDeg}
      canRenderMap={canRenderMap}
      directionsPanelRef={directionsPanelRef}
      resultsScrollRef={resultsScrollRef}
      inlineDetailsRef={inlineDetailsRef}
      isLoadingRoutes={isLoadingRoutes}
      routeError={routeError}
      routeOptions={routeOptions}
      selectedRouteIndex={selectedRouteIndex}
      onSelectRoute={onSelectRoute}
      onZoomToAllRoutes={onZoomToAllRoutes}
      onZoomToRoute={onZoomToRoute}
      detailsRouteModelDisplay={detailsRouteModelDisplay}
      selectedOption={selectedOption}
      detailsItinRef={detailsItinRef}
      detailsItinSegs={detailsItinSegs}
      pickerSnapshotRef={pickerSnapshotRef}
    />
      <SaveDirectionModal
        open={saveOpen}
        name={saveName}
        setName={setSaveName}
        description={saveDesc}
        setDescription={setSaveDesc}
        autoName={saveAutoName}
        canUpdate={Boolean(activeSavedId)}
        saving={saveSaving}
        error={saveError}
        onCancel={closeSave}
        onSaveNew={() => doSave({ update: false })}
        onUpdate={() => doSave({ update: true })}
      />
    </>
  );
}
