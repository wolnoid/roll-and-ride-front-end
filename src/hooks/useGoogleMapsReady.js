import { useEffect, useState } from "react";

export function useGoogleMapsReady(timeoutMs = 15000) {
  const isReadyNow = () =>
    Boolean(window.google?.maps?.importLibrary); // better signal than just google.maps

  const [ready, setReady] = useState(isReadyNow());
  const [error, setError] = useState(null);

  useEffect(() => {
    if (ready || error) return;

    let cancelled = false;
    const start = performance.now();

    const prevAuthFailure = window.gm_authFailure;
    const authFailureHandler = () => {
      if (cancelled) return;
      setError(
        "Google Maps authentication failed (API key restriction, billing not enabled, or required APIs not enabled)."
      );
      if (typeof prevAuthFailure === "function") prevAuthFailure();
    };

    window.gm_authFailure = authFailureHandler;

    const timer = setInterval(() => {
      if (isReadyNow()) {
        if (!cancelled) setReady(true);
        clearInterval(timer);
        return;
      }

      if (performance.now() - start > timeoutMs) {
        clearInterval(timer);

        const loader = document.querySelector(
          'gmpx-api-loader[data-app-loader="true"]'
        );
        const keyAttr = loader?.getAttribute("key");

        const msg = !loader
          ? "Maps loader <gmpx-api-loader> was not found in the DOM (loader hook not running/imported)."
          : !keyAttr
          ? "Maps loader exists but has no 'key' attribute (env var missing/not applied)."
          : "Maps loader exists and has a key, but Maps JS API never became ready (blocked by extension/CSP/network, or API not enabled).";

        console.error("Google Maps API did not become ready:", msg);
        if (!cancelled) setError(msg);
      }
    }, 50);

    return () => {
      cancelled = true;
      clearInterval(timer);
      if (window.gm_authFailure === authFailureHandler) {
        window.gm_authFailure = prevAuthFailure;
      }
    };
  }, [ready, error, timeoutMs]);

  return { ready, error };
}
