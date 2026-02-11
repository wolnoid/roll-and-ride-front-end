import { useLayoutEffect } from "react";
import "@googlemaps/extended-component-library/api_loader.js";
import "@googlemaps/extended-component-library/place_picker.js";

export default function MapsLoader() {
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
      el.setAttribute("key", key);
      el.setAttribute("version", "quarterly");

      document.body.appendChild(el);
    } else {
      // Keep it correct if env changes
      el.setAttribute("key", key);
      el.setAttribute("version", "quarterly");
    }
  }, []);

  return null;
}
