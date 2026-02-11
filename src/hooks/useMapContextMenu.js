// src/hooks/useMapContextMenu.js
import { useEffect, useState } from "react";

export function useMapContextMenu({
  enabled,
  map,
  mapWrapRef,
  menuWidth = 220,
  menuHeight = 84,
  pad = 8,
}) {
  const [ctxMenu, setCtxMenu] = useState(null);

  // bind right click + click-to-close
  useEffect(() => {
    if (!enabled || !map) return;

    let ctxListener = null;
    let clickListener = null;

    ctxListener = map.addListener("contextmenu", (e) => {
      e?.domEvent?.preventDefault?.();

      const latLng = e?.latLng;
      if (!latLng) return;

      const wrap = mapWrapRef.current;
      const rect = wrap?.getBoundingClientRect();
      if (!wrap || !rect) return;

      const clientX = e?.domEvent?.clientX ?? rect.left + rect.width / 2;
      const clientY = e?.domEvent?.clientY ?? rect.top + rect.height / 2;

      const rawX = clientX - rect.left;
      const rawY = clientY - rect.top;

      const x = Math.max(pad, Math.min(rawX, rect.width - menuWidth - pad));
      const y = Math.max(pad, Math.min(rawY, rect.height - menuHeight - pad));

      setCtxMenu({
        x,
        y,
        here: { lat: latLng.lat(), lng: latLng.lng() },
      });
    });

    clickListener = map.addListener("click", () => setCtxMenu(null));

    return () => {
      ctxListener?.remove?.();
      clickListener?.remove?.();
    };
  }, [enabled, map, mapWrapRef, menuWidth, menuHeight, pad]);

  // ESC + outside click
  useEffect(() => {
    if (!ctxMenu) return;

    const onKey = (e) => {
      if (e.key === "Escape") setCtxMenu(null);
    };

    const onMouseDown = (e) => {
      if (e.target?.closest?.('[data-map-contextmenu="true"]')) return;
      setCtxMenu(null);
    };

    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);

    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [ctxMenu]);

  return { ctxMenu, setCtxMenu };
}
