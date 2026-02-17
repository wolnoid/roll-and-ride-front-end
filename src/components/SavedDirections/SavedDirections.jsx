import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import styles from "./SavedDirections.module.css";

import { UserContext } from "../../contexts/UserContext";
import * as savedDirectionsService from "../../services/savedDirectionsService";
import { requestDirectionsSidebarExpand } from "../../utils/directionsSidebarState";

function safeFmtDate(value) {
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}

function formatMode(mode) {
  const raw = typeof mode === "string" ? mode.trim() : "";
  if (!raw) return "—";

  const parts = raw
    .toLowerCase()
    .split(/[_+]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  return parts.length ? parts.join(" + ") : "—";
}

function buildShareUrl(search) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const safe = typeof search === "string" ? search : "";
  return `${origin}/${safe.startsWith("?") ? safe : ""}`;
}

export default function SavedDirections({ embedded = false, showHeader = true }) {
  const { user } = useContext(UserContext);
  const navigate = useNavigate();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [editing, setEditing] = useState(null); // item
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const [copiedId, setCopiedId] = useState(null);

  useEffect(() => {
    if (user) return;
    if (embedded) return;
    navigate("/sign-in");
  }, [user, navigate, embedded]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await savedDirectionsService.index();
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e?.message || "Failed to load saved directions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    refresh();
  }, [user, refresh]);

  const countText = useMemo(() => {
    const n = items?.length ?? 0;
    return `${n} / 99`;
  }, [items]);

  async function handleDelete(id) {
    if (!id) return;
    const ok = window.confirm("Delete this saved direction?");
    if (!ok) return;

    try {
      await savedDirectionsService.remove(id);
      setItems((prev) => prev.filter((x) => x.id !== id));
    } catch (e) {
      window.alert(e?.message || "Failed to delete");
    }
  }

  async function handleCopyLink(item) {
    const url = buildShareUrl(item?.search);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(item?.id ?? null);
      window.setTimeout(() => setCopiedId(null), 1200);
    } catch {
      // fallback
      window.prompt("Copy link:", url);
    }
  }

  function handleOpen(item) {
    if (!item?.search) return;
    requestDirectionsSidebarExpand();
    // Keep the saved-id in the hash for update flow, but omit it from share links.
    navigate(`/${item.search}#sid=${item.id}`);
  }

  function beginEdit(item) {
    requestDirectionsSidebarExpand();
    setEditing(item);
    setEditName(item?.name ?? "");
    setEditDesc(item?.description ?? "");
  }

  function cancelEdit() {
    setEditing(null);
    setEditName("");
    setEditDesc("");
    setEditSaving(false);
  }

  async function submitEdit() {
    if (!editing?.id) return;
    setEditSaving(true);
    try {
      const updated = await savedDirectionsService.update(editing.id, {
        name: editName,
        description: editDesc,
      });
      setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      cancelEdit();
    } catch (e) {
      window.alert(e?.message || "Failed to update");
      setEditSaving(false);
    }
  }

  if (!user) return null;

  return (
    <div className={`${styles.page} ${embedded ? styles.embedded : ""}`}>
      {showHeader && (
        <div className={styles.header}>
          <div className={styles.headerMain}>
            <h1 className={styles.title}>Saved directions</h1>
            <p className={styles.subtitle}>Bookmarks that rerun when opened.</p>
          </div>
          <div className={styles.counter} title="Saved directions limit">
            {countText}
          </div>
        </div>
      )}

      {loading ? (
        <div className={styles.stateCard}>Loading…</div>
      ) : error ? (
        <div className={styles.stateCard} role="alert">
          <div className={styles.stateTitle}>Couldn’t load saved directions</div>
          <div className={styles.stateText}>{error}</div>
          <button className={styles.btn} onClick={refresh} type="button">
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className={styles.stateCard}>
          <div className={styles.stateTitle}>No saved directions yet</div>
          <div className={styles.stateText}>
            Get directions on the map, then use the <strong>Save</strong> button.
          </div>
          <button className={styles.btn} onClick={() => navigate("/")} type="button">
            Go to map
          </button>
        </div>
      ) : (
        <div className={styles.list}>
          {items.map((it) => (
            <div key={it.id} className={styles.card}>
              <div className={styles.cardTop}>
                <div className={styles.topRow}>
                  <div className={styles.nameRow}>
                    <div className={styles.name}>{it.name || "(untitled)"}</div>
                    <div className={styles.meta}>{safeFmtDate(it.updated_at || it.created_at)}</div>
                  </div>
                  <span className={styles.badge}>{formatMode(it.mode)}</span>
                </div>
                {!!it.description && <div className={styles.desc}>{it.description}</div>}
                <div className={styles.routeLine}>
                  <span
                    className={styles.od}
                    title={`${(it.origin_label || "Current location").trim()} → ${(it.destination_label || "").trim()}`}
                  >
                    {(it.origin_label || "Current location").trim()} → {(it.destination_label || "").trim()}
                  </span>
                </div>
              </div>

              {editing?.id === it.id ? (
                <div className={styles.inlineEditor}>
                  <label className={styles.label}>
                    Name
                    <input
                      className={styles.input}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Name"
                    />
                  </label>

                  <label className={styles.label}>
                    Description
                    <textarea
                      className={styles.textarea}
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      placeholder="Optional"
                      rows={3}
                    />
                  </label>

                  <div className={styles.inlineEditorActions}>
                    <button className={styles.btn} onClick={cancelEdit} type="button" disabled={editSaving}>
                      Cancel
                    </button>
                    <button
                      className={styles.btnPrimary}
                      onClick={submitEdit}
                      type="button"
                      disabled={editSaving}
                    >
                      {editSaving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className={styles.actions}>
                  <button className={styles.btnPrimary} onClick={() => handleOpen(it)} type="button">
                    Open
                  </button>
                  <button className={styles.btn} onClick={() => beginEdit(it)} type="button">
                    Edit
                  </button>
                  <button className={styles.btn} onClick={() => handleCopyLink(it)} type="button">
                    {copiedId === it.id ? "Copied" : "Share"}
                  </button>
                  <button className={styles.btnDanger} onClick={() => handleDelete(it.id)} type="button">
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
