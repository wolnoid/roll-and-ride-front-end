// src/maps/placePicker.js

export function fmtLatLng({ lat, lng }) {
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "";
  return `${a.toFixed(5)}, ${b.toFixed(5)}`;
}

// Best-effort: read visible text inside <gmpx-place-picker>
export function getPickerText(pickerEl) {
  if (!pickerEl) return "";

  const lightInput = pickerEl.querySelector?.("input");
  if (lightInput?.value) return lightInput.value;

  const srInput = pickerEl.shadowRoot?.querySelector?.("input");
  if (srInput?.value) return srInput.value;

  const nested =
    pickerEl.shadowRoot?.querySelector?.(
      "gmp-place-autocomplete, gmpx-place-autocomplete"
    );
  const nestedInput = nested?.shadowRoot?.querySelector?.("input");
  return nestedInput?.value ?? "";
}

// Set visible text WITHOUT triggering the autocomplete dropdown (best-effort)
export function forcePickerText(pickerEl, text) {
  if (!pickerEl || !text) return;

  const setOnInput = (input) => {
    input.value = text;

    // Close any open predictions UI (best-effort)
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );

    // Avoid dropdown focus/selection UI
    input.blur?.();
  };

  const lightInput = pickerEl.querySelector?.("input");
  if (lightInput) return setOnInput(lightInput);

  const srInput = pickerEl.shadowRoot?.querySelector?.("input");
  if (srInput) return setOnInput(srInput);

  const nested =
    pickerEl.shadowRoot?.querySelector?.(
      "gmp-place-autocomplete, gmpx-place-autocomplete"
    );
  const nestedInput = nested?.shadowRoot?.querySelector?.("input");
  if (nestedInput) return setOnInput(nestedInput);
}

export async function reverseGeocodeLL(ll) {
  try {
    const geocoder = new window.google.maps.Geocoder();
    const resp = await geocoder.geocode({ location: ll });
    const best = resp?.results?.[0];
    return {
      address: best?.formatted_address ?? null,
      placeId: best?.place_id ?? null,
    };
  } catch (e) {
    console.warn("Reverse geocode failed:", e);
    return { address: null, placeId: null };
  }
}

export async function populatePlacePickerFromLatLng(pickerEl, ll) {
  if (!pickerEl) return;

  // show something immediately
  forcePickerText(pickerEl, fmtLatLng(ll));

  const { address, placeId } = await reverseGeocodeLL(ll);
  if (address) forcePickerText(pickerEl, address);

  // Best-case: set pickerEl.value to a real Place object (if supported)
  if (placeId) {
    try {
      const { Place } = await window.google.maps.importLibrary("places");
      const place = new Place({ id: placeId });
      await place.fetchFields({ fields: ["location", "formattedAddress"] });

      try {
        pickerEl.value = place;
      } catch {
        // ignore; UI already set
      }
    } catch (e) {
      console.warn("Place fetch/set failed:", e);
    }
  }
}
