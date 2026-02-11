import { useEffect, useRef, useState } from "react";

const DEFAULT_OPTIONS = { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 };

export function useGeolocation(options = DEFAULT_OPTIONS) {
  const requested = useRef(false);
  const [{ loc, resolved }, setState] = useState({ loc: null, resolved: false });

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;

    if (!("geolocation" in navigator)) {
      setState({ loc: null, resolved: true });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        const next = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
        setState({ loc: next, resolved: true });
      },
      () => setState({ loc: null, resolved: true }),
      options
    );
  }, [options]);

  return { loc, resolved };
}
