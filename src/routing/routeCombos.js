export const ROUTE_COMBO = {
  TRANSIT: "TRANSIT",
  TRANSIT_BIKE: "TRANSIT_BIKE",
  BIKE: "BIKE",
  TRANSIT_SKATE: "TRANSIT_SKATE",
  SKATE: "SKATE",
};

export const SKATE_SPEED_MPH = 6;
export const MPH_TO_MPS = 1609.344 / 3600;
export const SKATE_SPEED_MPS = SKATE_SPEED_MPH * MPH_TO_MPS;

export function isTransitOn(combo) {
  return combo === ROUTE_COMBO.TRANSIT || combo === ROUTE_COMBO.TRANSIT_BIKE || combo === ROUTE_COMBO.TRANSIT_SKATE;
}
export function isBikeOn(combo) {
  return combo === ROUTE_COMBO.BIKE || combo === ROUTE_COMBO.TRANSIT_BIKE;
}
export function isSkateOn(combo) {
  return combo === ROUTE_COMBO.SKATE || combo === ROUTE_COMBO.TRANSIT_SKATE;
}

/**
 * Click behavior:
 * - Default TRANSIT
 * - Clicking Bike from TRANSIT => TRANSIT_BIKE
 * - Clicking Skate from TRANSIT => TRANSIT_SKATE
 * - If TRANSIT_BIKE active and click Transit => BIKE (drop transit)
 * - If BIKE active and click Transit => TRANSIT_BIKE (add transit)
 * - same for SKATE
 */
export function nextCombo(current, clicked) {
  const transit = isTransitOn(current);
  const bike = isBikeOn(current);
  const skate = isSkateOn(current);

  const resolve = (t, b, s) => {
    // enforce last-mile exclusivity (bike OR skate)
    if (b && s) s = false;

    if (t) {
      if (b) return ROUTE_COMBO.TRANSIT_BIKE;
      if (s) return ROUTE_COMBO.TRANSIT_SKATE;
      return ROUTE_COMBO.TRANSIT;
    } else {
      if (b) return ROUTE_COMBO.BIKE;
      if (s) return ROUTE_COMBO.SKATE;
      // safety: never allow "no mode"
      return ROUTE_COMBO.TRANSIT;
    }
  };

  if (clicked === "TRANSIT") {
    const nextTransit = !transit;

    // Don't allow turning off the last active mode.
    if (!nextTransit && !bike && !skate) return ROUTE_COMBO.TRANSIT;

    return resolve(nextTransit, bike, skate);
  }

  if (clicked === "BIKE") {
    // Bike toggle should NOT force transit on.
    // If skate is on, switch to bike (skate off).
    const nextBike = bike ? false : true;
    const nextSkate = false;

    // If transit is off and bike is the only active mode, don't allow turning it off.
    if (!transit && bike && !skate) return ROUTE_COMBO.BIKE;

    return resolve(transit, nextBike, nextSkate);
  }

  if (clicked === "SKATE") {
    const nextSkate = skate ? false : true;
    const nextBike = false;

    if (!transit && skate && !bike) return ROUTE_COMBO.SKATE;

    return resolve(transit, nextBike, nextSkate);
  }

  return current;
}

