// src/routing/routeFormat.js

export function formatDurationSec(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "";
  const mins = Math.round(totalSeconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export function formatDistanceMeters(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return "";
  const mi = meters / 1609.344;
  return mi >= 10 ? `${mi.toFixed(0)} mi` : `${mi.toFixed(1)} mi`;
}

export function formatTime(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function addSeconds(date, seconds) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  if (!Number.isFinite(seconds)) return new Date(date);
  return new Date(date.getTime() + seconds * 1000);
}

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

export function asDate(x) {
  if (!x) return null;
  if (x instanceof Date) return x;
  if (x?.value instanceof Date) return x.value;
  if (typeof x === "number") {
    // Heuristic: if it looks like seconds-since-epoch, convert.
    return x < 10_000_000_000 ? new Date(x * 1000) : new Date(x);
  }
  return null;
}
