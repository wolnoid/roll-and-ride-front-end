export function createMainRendererTools({ rendererRef, panelRef, map }) {
  function inferRendererTravelMode(dr) {
    try {
      const mode = dr?.getDirections?.()?.request?.travelMode;
      if (typeof mode === "string" && mode) return mode;
    } catch {
      // ignore
    }
    try {
      const mode = dr?.getDirections?.()?.routes?.[0]?.travelMode;
      if (typeof mode === "string" && mode) return mode;
    } catch {
      // ignore
    }
    return "TRANSIT";
  }

  function clearRendererDirections(dr) {
    if (!dr) return;

    // IMPORTANT: Some Maps JS builds throw `InvalidValueError: setDirections: not an Object`
    // when clearing with null. Always clear with an object-shaped stub instead.
    try {
      if (typeof dr.setRouteIndex === "function") dr.setRouteIndex(0);
    } catch {
      // ignore
    }
    try {
      dr.set?.("routeIndex", 0);
    } catch {
      // ignore
    }
    const cleared = {
      routes: [],
      // Some Maps JS builds assume directions.request.travelMode exists.
      request: { travelMode: inferRendererTravelMode(dr) },
    };
    try {
      if (typeof dr.setDirections === "function") dr.setDirections(cleared);
    } catch {
      // ignore
    }
  }

  function hardResetMainRenderer({ reattach = true, clearPanel = false } = {}) {
    const dr = rendererRef.current;
    if (!dr) return;

    // Detach first. This is the safest way to reset renderer state across Maps JS builds.
    try {
      dr.setPanel?.(null);
    } catch {
      // ignore
    }
    try {
      dr.setMap?.(null);
    } catch {
      // ignore
    }

    // Only clear directions if we're going to keep using this renderer instance.
    // During unmount we often detach and throw the instance away.
    if (reattach) {
      clearRendererDirections(dr);
    }

    if (reattach) {
      try {
        dr.setMap?.(map);
      } catch {
        // ignore
      }
      try {
        dr.setPanel?.(clearPanel ? null : panelRef?.current ?? null);
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
      dr.setPanel?.(panelRef?.current ?? null);
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

  return {
    hardResetMainRenderer,
    configureMainRendererForNormal,
    configureMainRendererForHybrid,
  };
}
