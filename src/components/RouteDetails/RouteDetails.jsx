import styles from "./RouteDetails.module.css";
import { formatDistanceMeters, formatDurationSec, formatTime } from "../../routing/routeFormat";

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
    const label = [t.vehicle, t.shortName].filter(Boolean).join(" ");
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
  return (
    <div className={styles.segHeader}>
      <div className={styles.segTitle}>
        <span className={styles.badge}>{seg.modeLabel || seg.mode}</span>
        <span className={styles.segMain}>{dur ? ` ${dur}` : ""}</span>
        {dist ? <span className={styles.segSecondary}> · {dist}</span> : null}
      </div>
      <div className={styles.segMeta}>{t0 && t1 ? `${t0} → ${t1}` : ""}</div>
    </div>
  );
}

export default function RouteDetails({ route }) {
  if (!route) return null;

  const dur = formatDurationSec(route.totalDurationSec);
  const dist = formatDistanceMeters(route.totalDistanceMeters);
  const dep = formatTime(route.departureTime);
  const arr = formatTime(route.arrivalTime);

  return (
    <section className={styles.wrap}>
      <div className={styles.top}>
        <div className={styles.topMain}>
          <div className={styles.big}>{dur || "—"}</div>
          <div className={styles.small}>
            {dist ? dist : ""}
            {dep && arr ? <span> · {dep} → {arr}</span> : null}
          </div>
        </div>
      </div>

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
