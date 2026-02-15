import { useEffect, useState } from "react";
import { rafPoll } from "../utils/rafPoll";

export function useInnerMap(mapRef, enabled, maxFrames = 180) {
  const [map, setMap] = useState(null);

  useEffect(() => {
    if (!enabled) return;

    return rafPoll(
      () => mapRef.current?.innerMap ?? null,
      (m) => setMap(m),
      { maxFrames }
    );
  }, [enabled, mapRef, maxFrames]);

  useEffect(() => {
    if (!enabled) setMap(null);
  }, [enabled]);

  return map;
}