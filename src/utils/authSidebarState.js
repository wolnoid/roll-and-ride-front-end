export const AUTH_SIDEBAR_LS_KEY = "rollnride.authSidebarCollapsed";
export const AUTH_SIDEBAR_EXPAND_EVENT = "rollnride:auth-sidebar-expand";

export function requestAuthSidebarExpand() {
  if (typeof window === "undefined") return;

  try {
    window.localStorage?.setItem(AUTH_SIDEBAR_LS_KEY, "0");
  } catch {
    // ignore storage errors
  }

  window.dispatchEvent(new Event(AUTH_SIDEBAR_EXPAND_EVENT));
}
