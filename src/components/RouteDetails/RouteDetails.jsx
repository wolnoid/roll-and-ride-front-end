import styles from "./RouteDetails.module.css";
import { formatDistanceMeters, formatDurationSec, formatTime } from "../../routing/routeFormat";

function decodeHtmlEntities(s) {
  if (!s) return "";
  return String(s)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .trim();
}

function extractBoldTexts(html) {
  if (!html) return [];
  const src = String(html);
  const out = [];
  const re = /<b>([\s\S]*?)<\/b>/gi;
  let m;
  while ((m = re.exec(src))) {
    const raw = m?.[1] ?? "";
    const cleaned = decodeHtmlEntities(raw.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (cleaned) out.push(cleaned);
  }
  return out;
}

function parseDistanceToMeters(distanceText) {
  // Typical formats: "0.2 mi", "700 ft", "1.3 km", "250 m"
  if (!distanceText) return 0;
  const s = String(distanceText).toLowerCase().replace(/,/g, "").trim();
  const m = s.match(/([0-9]*\.?[0-9]+)\s*(mi|miles|km|kilometers|kilometres|m|meters|metres|ft|feet)\b/);
  if (!m) return 0;
  const val = Number(m[1]);
  const unit = m[2];
  if (!isFinite(val)) return 0;
  if (unit === "mi" || unit === "miles") return val * 1609.344;
  if (unit === "km" || unit === "kilometers" || unit === "kilometres") return val * 1000;
  if (unit === "m" || unit === "meters" || unit === "metres") return val;
  if (unit === "ft" || unit === "feet") return val * 0.3048;
  return 0;
}

function looksLikeWayName(name) {
  const s = String(name || "").trim();
  if (!s) return false;
  const low = s.toLowerCase();

  // Avoid generic tokens / directions.
  const bad = [
    "north",
    "south",
    "east",
    "west",
    "left",
    "right",
    "destination",
    "your destination",
    "continue",
    "head",
    "turn",
  ];
  if (bad.includes(low)) return false;
  if (low.startsWith("toward ")) return false;

  // Heuristic: common road/trail words, route numbers, or multi-word proper names.
  const keywords = [
    " st",
    " ave",
    " blvd",
    " rd",
    " dr",
    " ln",
    " way",
    " pkwy",
    " parkway",
    " hwy",
    " highway",
    " route",
    " trail",
    " path",
    " bikeway",
    " greenway",
    " bridge",
    " loop",
    " cir",
    " ct",
    " pl",
  ];
  if (keywords.some((k) => low.includes(k))) return true;
  if (/\b(us|ca|sr|i)-?\s?\d+\b/i.test(s)) return true;
  if (s.split(/\s+/).length >= 2) return true;
  return s.length >= 6;
}

function inferPrimaryWayName(seg) {
  const mode = String(seg?.mode || "").toUpperCase();
  if (!seg || mode === "TRANSIT" || mode === "WAIT") return "";
  if (!Array.isArray(seg.steps) || !seg.steps.length) return "";

  const scores = new Map();
  const firstSeen = new Map();

  for (let i = 0; i < seg.steps.length; i++) {
    const st = seg.steps[i] || {};
    const candidates = extractBoldTexts(st.html || "");
    if (!candidates.length) continue;

    const w = Math.max(1, parseDistanceToMeters(st.distanceText || "") || 0);
    for (const c of candidates) {
      const key = c.trim();
      if (!key) continue;
      if (!looksLikeWayName(key)) continue;
      scores.set(key, (scores.get(key) || 0) + w);
      if (!firstSeen.has(key)) firstSeen.set(key, i);
    }
  }

  if (!scores.size) {
    // Fallback: take the first bold text anywhere (even if it didn't pass the heuristic).
    for (const st of seg.steps) {
      const c = extractBoldTexts(st?.html || "")[0];
      if (c) return c;
    }
    return "";
  }

  let best = "";
  let bestScore = -1;
  let bestFirst = 1e9;
  for (const [k, sc] of scores.entries()) {
    const fs = firstSeen.get(k) ?? 1e9;
    if (sc > bestScore || (sc === bestScore && fs < bestFirst)) {
      best = k;
      bestScore = sc;
      bestFirst = fs;
    }
  }
  return best;
}

function StepHtml({ html }) {
  if (!html) return null;
  // Google provides sanitized-ish HTML (bold/line breaks). We keep it as-is.
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function SegmentHeader({ seg }) {
  const dur = formatDurationSec(seg.durationSec);
  const dist = formatDistanceMeters(seg.distanceMeters);
  const t0 = formatTime(seg.startTime);
  const t1 = formatTime(seg.endTime);

  if (seg.kind === "WAIT") {
    return (
      <div className={styles.segHeader}>
        <div className={styles.segTitle}>
          <span className={styles.badge}>Wait</span>
          <span className={styles.segMain}> {dur}</span>
        </div>
        <div className={styles.segMeta}>{seg.at ? `at ${seg.at}` : ""}</div>
      </div>
    );
  }

  if (seg.mode === "TRANSIT") {
    const t = seg.transit || {};
    const vehicleWord = String(t.vehicle || "").trim();
    const line = String(t.shortName || "").trim();
    const v = vehicleWord ? vehicleWord.toLowerCase() : "";
    const label = line ? (v ? `${line} ${v}` : line) : (v || "Transit");
    return (
      <div className={styles.segHeader}>
        <div className={styles.segTitle}>
          <span className={styles.badge}>Transit</span>
          <span className={styles.segMain}>{label ? ` ${label}` : ""}</span>
          {dur ? <span className={styles.segSecondary}> · {dur}</span> : null}
        </div>
        <div className={styles.segMeta}>
          {t.depStop && t.arrStop ? (
            <>
              {t0 ? `${t0} ` : ""}{t.depStop} → {t1 ? `${t1} ` : ""}{t.arrStop}
            </>
          ) : (
            <>
              {t0 && t1 ? `${t0} → ${t1}` : ""}
            </>
          )}
          {t.numStops ? <span className={styles.segStops}> · {t.numStops} stops</span> : null}
          {t.headsign ? <span className={styles.segHeadsign}> · {t.headsign}</span> : null}
        </div>
      </div>
    );
  }

  // Bike / Walk / Skate
  const way = inferPrimaryWayName(seg);
  const hasTimes = Boolean(t0 && t1);
  return (
    <div className={styles.segHeader}>
      <div className={styles.segTitle}>
        <span className={styles.badge}>{seg.modeLabel || seg.mode}</span>
        <span className={styles.segMain}>{dur ? ` ${dur}` : ""}</span>
        {dist ? <span className={styles.segSecondary}> · {dist}</span> : null}
      </div>
      <div className={styles.segMeta}>
        {hasTimes ? `${t0} → ${t1}` : ""}
        {way ? <span>{hasTimes ? " · " : ""}{way}</span> : null}
      </div>
    </div>
  );
}

export default function RouteDetails({ route, hideTop = false, className = "" }) {
  if (!route) return null;

  const dur = formatDurationSec(route.totalDurationSec);
  const dist = formatDistanceMeters(route.totalDistanceMeters);
  const dep = formatTime(route.departureTime);
  const arr = formatTime(route.arrivalTime);

  return (
    <section className={`${styles.wrap} ${className}`}>
      {!hideTop && (
        <div className={styles.top}>
          <div className={styles.topMain}>
            <div className={styles.big}>{dur || "—"}</div>
            <div className={styles.small}>
              {dist ? dist : ""}
              {dep && arr ? <span> · {dep} → {arr}</span> : null}
            </div>
          </div>
        </div>
      )}

      <div className={styles.list}>
        {route.segments?.map((seg) => (
          <details key={seg.id} className={styles.seg} open={seg.kind === "WAIT"}>
            <summary className={styles.summary}>
              <SegmentHeader seg={seg} />
            </summary>

            {seg.kind !== "WAIT" && seg.steps?.length ? (
              <div className={styles.steps}>
                {seg.steps.map((st, i) => (
                  <div key={i} className={styles.stepRow}>
                    <div className={styles.stepDot} aria-hidden="true" />
                    <div className={styles.stepText}>
                      <StepHtml html={st.html} />
                      <div className={styles.stepMeta}>
                        {[st.distanceText, st.durationText].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </details>
        ))}
      </div>
    </section>
  );
}
