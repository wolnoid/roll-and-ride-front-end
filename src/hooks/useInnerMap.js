// src/hooks/useInnerMap.js
import { useEffect, useState } from "react";

export function useInnerMap(mapRef, enabled, maxFrames = 180) {
  const [map, setMap] = useState(null);

  useEffect(() => {
    if (!enabled) return;

    let raf = 0;
    let frames = 0;

    const tick = () => {
      const m = mapRef.current?.innerMap ?? null;
      if (m) {
        setMap(m);
        return;
      }
      if (++frames < maxFrames) raf = requestAnimationFrame(tick);
    };

    tick();
    return () => cancelAnimationFrame(raf);
  }, [enabled, mapRef, maxFrames]);

  // If disabled, clear
  useEffect(() => {
    if (!enabled) setMap(null);
  }, [enabled]);

  return map;
}
