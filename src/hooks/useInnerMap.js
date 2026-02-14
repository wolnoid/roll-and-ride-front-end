import { useEffect, useRef, useState } from "react";
import { rafPoll } from "../utils/rafPoll";

/**
 * Retrieves the underlying google.maps.Map instance from the <gmp-map> web component.
 *
 * Also forces consistent overlay appearance during zoom by disabling fractional zoom
 * (vector maps default to fractional zoom on). This reduces the "polyline thickness
 * breathes while zooming" effect caused by fractional zoom scaling.
 */
export function useInnerMap(mapRef, enabled, maxFrames = 180) {
  const [map, setMap] = useState(null);
  const fracZoomListenerRef = useRef(null);

  useEffect(() => {
    if (!enabled) return;

    return rafPoll(
      () => mapRef.current?.innerMap ?? null,
      (m) => {
        // Clean up any prior listener.
        try {
          fracZoomListenerRef.current?.remove?.();
        } catch {
          // ignore
        }
        fracZoomListenerRef.current = null;

        // Disable fractional zoom to keep overlay strokes from "breathing" while zooming.
        try {
          m?.setOptions?.({ isFractionalZoomEnabled: false });
        } catch {
          // ignore
        }

        // Some builds set the default later; enforce again when it does.
        try {
          fracZoomListenerRef.current = m?.addListener?.(
            "isfractionalzoomenabled_changed",
            () => {
              try {
                m?.setOptions?.({ isFractionalZoomEnabled: false });
              } catch {
                // ignore
              }
            }
          );
        } catch {
          // ignore
        }

        setMap(m);
      },
      { maxFrames }
    );
  }, [enabled, mapRef, maxFrames]);

  useEffect(() => {
    if (!enabled) {
      try {
        fracZoomListenerRef.current?.remove?.();
      } catch {
        // ignore
      }
      fracZoomListenerRef.current = null;
      setMap(null);
    }
  }, [enabled]);

  return map;
}
