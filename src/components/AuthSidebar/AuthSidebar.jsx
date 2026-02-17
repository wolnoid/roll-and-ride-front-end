import { useCallback, useContext, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { UserContext } from '../../contexts/UserContext';
import SavedDirections from '../SavedDirections/SavedDirections';
import SignInForm from '../SignInForm/SignInForm';
import SignUpForm from '../SignUpForm/SignUpForm';
import { AUTH_SIDEBAR_EXPAND_EVENT, AUTH_SIDEBAR_LS_KEY } from '../../utils/authSidebarState';
import { ROUTE_COMBO } from '../../routing/routeCombos';
import { buildRoutingSearch, parseRoutingSearch } from '../../routing/urlState';
import { getPickerText } from '../../maps/placePicker';
import * as savedDirectionsService from '../../services/savedDirectionsService';
import styles from './AuthSidebar.module.css';

function ChevronLeftIcon() {
  return (
    <svg viewBox='0 0 24 24' width='18' height='18' aria-hidden='true'>
      <path
        d='M14.5 5.5L8 12l6.5 6.5'
        fill='none'
        stroke='currentColor'
        strokeWidth='2.4'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox='0 0 24 24' width='18' height='18' aria-hidden='true'>
      <path
        d='M9.5 5.5L16 12l-6.5 6.5'
        fill='none'
        stroke='currentColor'
        strokeWidth='2.4'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </svg>
  );
}

const AuthSidebar = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useContext(UserContext);

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage?.getItem(AUTH_SIDEBAR_LS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [view, setView] = useState(() => (user ? 'profile' : 'signin'));
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDesc, setSaveDesc] = useState('');
  const [saveAutoName, setSaveAutoName] = useState('');
  const [saveError, setSaveError] = useState(null);
  const [saveSaving, setSaveSaving] = useState(false);
  const [activeSavedId, setActiveSavedId] = useState(null);
  const [savedListKey, setSavedListKey] = useState(0);

  useEffect(() => {
    try {
      window.localStorage?.setItem(AUTH_SIDEBAR_LS_KEY, collapsed ? '1' : '0');
    } catch {
      // ignore
    }
  }, [collapsed]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleExpandRequest = () => setCollapsed(false);
    window.addEventListener(AUTH_SIDEBAR_EXPAND_EVENT, handleExpandRequest);
    return () => window.removeEventListener(AUTH_SIDEBAR_EXPAND_EVENT, handleExpandRequest);
  }, []);

  useEffect(() => {
    const path = location.pathname;

    if (!user) {
      if (path === '/saved') {
        navigate('/sign-in');
        return;
      }
      if (path === '/sign-up') {
        setView('signup');
        setCollapsed(false);
        return;
      }
      setView('signin');
      if (path === '/sign-in') setCollapsed(false);
      return;
    }

    setView('profile');
    if (path === '/saved') setCollapsed(false);
  }, [location.pathname, navigate, user]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const id = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
    return () => window.cancelAnimationFrame(id);
  }, [collapsed]);

  const showProfile = user && view === 'profile';
  const showSignIn = !user && view === 'signin';
  const showSignUp = !user && view === 'signup';
  const showAuthForm = showSignIn || showSignUp;

  const readSavedIdFromHash = useCallback(() => {
    try {
      const hash = typeof window !== 'undefined' ? window.location.hash || '' : '';
      const params = new URLSearchParams(hash.replace(/^#/, ''));
      const raw = params.get('sid');
      const n = raw ? Number(raw) : null;
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }, []);

  const getPickerLabel = useCallback((selector, fallback = '') => {
    try {
      if (typeof document === 'undefined') return fallback;
      const picker = document.querySelector(selector);
      const text = (getPickerText(picker) || '').trim();
      return text || fallback;
    } catch {
      return fallback;
    }
  }, []);

  const shortAddressLabel = useCallback((rawLabel, fallback = '') => {
    const raw = String(rawLabel || fallback || '').trim();
    if (!raw) return '';
    const [head] = raw.split(',');
    const trimmed = String(head || '').trim();
    return trimmed || raw;
  }, []);

  const formatModeLabel = useCallback((combo) => {
    const raw = String(combo || ROUTE_COMBO.TRANSIT).trim();
    if (!raw) return 'transit';
    return raw
      .toLowerCase()
      .split(/[_+]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' + ');
  }, []);

  const getRouteState = useCallback(() => {
    if (typeof window === 'undefined') return null;
    const parsed = parseRoutingSearch(window.location.search || '');
    if (!parsed?.hasValidEndpoints) return null;

    const search = buildRoutingSearch(
      {
        origin: parsed.origin,
        destination: parsed.destination,
        mode: parsed.mode ?? ROUTE_COMBO.TRANSIT,
        via: parsed.via ?? [],
        when: parsed.when ?? { kind: 'NOW', date: null },
        hill: parsed.hill,
      },
      { includeWhenNow: true }
    );

    return search ? { parsed, search } : null;
  }, []);

  const persistHashSid = useCallback((sid, searchOverride) => {
    if (typeof window === 'undefined') return;
    const path = window.location.pathname || '/';
    const search = searchOverride ?? window.location.search ?? '';
    const next = `${path}${search}${sid ? `#sid=${sid}` : ''}`;
    window.history.replaceState(null, '', next);
  }, []);

  const handleSaveCurrentRoute = useCallback(() => {
    const originFull = getPickerLabel('gmpx-place-picker[placeholder="Choose origin"]', 'Current location');
    const destinationFull = getPickerLabel('gmpx-place-picker[placeholder="Choose destination"]', 'Destination');
    const routeState = getRouteState();
    const modeLabel = formatModeLabel(routeState?.parsed?.mode);

    const autoName = `${shortAddressLabel(originFull, 'Current location')} → ${shortAddressLabel(destinationFull, 'Destination')} by ${modeLabel}`;
    setSaveAutoName(autoName);
    setSaveName(autoName);
    setSaveDesc('');
    setSaveSaving(false);
    setSaveError(routeState ? null : 'Get directions first');
    setActiveSavedId(readSavedIdFromHash());
    setSaveOpen(true);
  }, [formatModeLabel, getPickerLabel, getRouteState, readSavedIdFromHash, shortAddressLabel]);

  const cancelSave = useCallback(() => {
    setSaveOpen(false);
    setSaveError(null);
    setSaveSaving(false);
  }, []);

  const submitSave = useCallback(
    async ({ update = false } = {}) => {
      if (!user) return;
      setSaveSaving(true);
      setSaveError(null);

      try {
        const routeState = getRouteState();
        if (!routeState?.search) throw new Error('Get directions first');

        const origin_label = getPickerLabel(
          'gmpx-place-picker[placeholder="Choose origin"]',
          'Current location'
        );
        const destination_label = getPickerLabel(
          'gmpx-place-picker[placeholder="Choose destination"]',
          ''
        );

        const payload = {
          name: String(saveName || saveAutoName || 'Saved directions').trim(),
          description: saveDesc,
          origin_label,
          destination_label,
          mode: routeState.parsed?.mode ?? ROUTE_COMBO.TRANSIT,
          search: routeState.search,
        };

        if (update) {
          const sid = activeSavedId;
          if (!sid) throw new Error('No saved direction selected to update');
          const updated = await savedDirectionsService.update(sid, payload);
          persistHashSid(updated?.id ?? sid, routeState.search);
        } else {
          const created = await savedDirectionsService.create(payload);
          persistHashSid(created?.id, routeState.search);
          setActiveSavedId(created?.id ?? null);
        }

        setSaveOpen(false);
        setSavedListKey((prev) => prev + 1);
      } catch (e) {
        setSaveError(e?.message || 'Failed to save');
      } finally {
        setSaveSaving(false);
      }
    },
    [activeSavedId, getPickerLabel, getRouteState, persistHashSid, saveAutoName, saveDesc, saveName, user]
  );

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.sidebarCollapsed : ''}`} aria-label='Account navigation'>
      <button
        type='button'
        className={styles.collapseNub}
        onClick={() => setCollapsed((prev) => !prev)}
        aria-label={collapsed ? 'Open account sidebar' : 'Collapse account sidebar'}
        title={collapsed ? 'Open account sidebar' : 'Collapse account sidebar'}
      >
        <span className={styles.collapseNubIcon} aria-hidden='true'>
          {collapsed ? <ChevronLeftIcon /> : <ChevronRightIcon />}
        </span>
      </button>

      <div className={styles.sidebarBody}>
        {showProfile && (
          <div className={styles.profilePanel}>
            <div className={styles.profileHeader}>
              <h2 className={styles.profileTitle}>Your Routes</h2>
              <button type='button' className={styles.saveRouteBtn} onClick={handleSaveCurrentRoute}>
                save current route
              </button>
            </div>

            {saveOpen && (
              <div className={styles.savePrompt} role='region' aria-label='Save current route'>
                <div className={styles.savePromptTitle}>Save current route</div>

                <label className={styles.saveField}>
                  Name
                  <input
                    className={styles.saveInput}
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    placeholder={saveAutoName || 'Saved directions'}
                    disabled={saveSaving}
                  />
                </label>

                <label className={styles.saveField}>
                  Description
                  <textarea
                    className={styles.saveTextarea}
                    value={saveDesc}
                    onChange={(e) => setSaveDesc(e.target.value)}
                    placeholder='Optional'
                    rows={3}
                    disabled={saveSaving}
                  />
                </label>

                {saveError && <div className={styles.saveError}>{saveError}</div>}

                <div className={styles.saveActions}>
                  <button
                    type='button'
                    className={styles.saveActionSecondary}
                    onClick={cancelSave}
                    disabled={saveSaving}
                  >
                    Cancel
                  </button>
                  <button
                    type='button'
                    className={styles.saveActionPrimary}
                    onClick={() => submitSave({ update: false })}
                    disabled={saveSaving}
                  >
                    {saveSaving ? 'Saving…' : 'Save'}
                  </button>
                  {Boolean(activeSavedId) && (
                    <button
                      type='button'
                      className={styles.saveActionPrimary}
                      onClick={() => submitSave({ update: true })}
                      disabled={saveSaving}
                    >
                      {saveSaving ? 'Saving…' : 'Update'}
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className={styles.profileContent}>
              <SavedDirections key={savedListKey} embedded showHeader={false} />
            </div>
          </div>
        )}

        {showAuthForm && (
          <div className={styles.authPanel}>
            <div className={styles.profileContent}>
              {showSignIn ? (
                <SignInForm
                  embedded
                  onCancel={() => navigate('/')}
                  onSuccess={() => navigate('/')}
                  onSwitchToSignUp={() => navigate('/sign-up')}
                />
              ) : (
                <SignUpForm
                  embedded
                  onCancel={() => navigate('/')}
                  onSuccess={() => navigate('/')}
                  onSwitchToSignIn={() => navigate('/sign-in')}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};

export default AuthSidebar;
