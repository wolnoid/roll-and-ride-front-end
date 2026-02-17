export const DIRECTIONS_SIDEBAR_LS_KEY = "carpool.sidebarCollapsed";
export const DIRECTIONS_SIDEBAR_EXPAND_EVENT = "rollnride:directions-sidebar-expand";
export const DIRECTIONS_SIDEBAR_OPEN_SAVE_EVENT = "rollnride:directions-sidebar-open-save";

export function requestDirectionsSidebarExpand() {
  if (typeof window === "undefined") return;

  try {
    window.localStorage?.setItem(DIRECTIONS_SIDEBAR_LS_KEY, "0");
  } catch {
    // ignore storage errors
  }

  window.dispatchEvent(new Event(DIRECTIONS_SIDEBAR_EXPAND_EVENT));
}

export function requestDirectionsSidebarOpenSave() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(DIRECTIONS_SIDEBAR_OPEN_SAVE_EVENT));
}
