import { useLayoutEffect } from "react";
import "@googlemaps/extended-component-library/api_loader.js";
import "@googlemaps/extended-component-library/place_picker.js";

export function useMapsLoader() {
  useLayoutEffect(() => {
    const key = import.meta.env.VITE_GOOGLE_MAPS_KEY;
    if (!key) {
      console.error("Missing VITE_GOOGLE_MAPS_KEY");
      return;
    }

    let el = document.querySelector('gmpx-api-loader[data-app-loader="true"]');

    if (!el) {
      el = document.createElement("gmpx-api-loader");
      el.setAttribute("data-app-loader", "true");
      document.body.appendChild(el);
    }

    // Keep it correct even if env changes
    el.setAttribute("key", key);
    el.setAttribute("version", "quarterly");
  }, []);
}
