// Store subscription for pages.
//
// A page is handed to the dashboard shell as an ELEMENT (`main.jsx` builds it, the shell renders it
// in a slot). When the store emits, the shell forceUpdates — but React bails out of re-rendering a
// child whose element reference is unchanged, so the page would keep showing stale data. Every page
// therefore subscribes for itself.
import React from "react";

/** Re-render this component whenever the store emits. Returns the current state. */
export function useStore(store) {
  const [, bump] = React.useReducer(n => n + 1, 0);
  React.useEffect(() => (store ? store.subscribe(bump) : undefined), [store]);
  return store ? store.state : {};
}

/** Run an async loader on mount (and when `deps` change). Returns { data, error, loading, reload }. */
export function useAsync(fn, deps = [], initial = null) {
  const [s, set] = React.useState({ data: initial, error: null, loading: true });
  const [n, reload] = React.useReducer(x => x + 1, 0);
  const ref = React.useRef(fn);
  ref.current = fn;
  React.useEffect(() => {
    let alive = true;
    set(p => ({ data: p.data, error: null, loading: true }));
    Promise.resolve()
      .then(() => ref.current())
      .then(d => { if (alive) set({ data: d, error: null, loading: false }); })
      .catch(e => { if (alive) set({ data: null, error: e && e.message ? e.message : String(e), loading: false }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...s, reload };
}

/**
 * Per-page state that survives a reload. Orca tears the Device tab down and rebuilds it on nearly
 * every preset change, so anything a user picked (a filter, a tab, a selected file, unsent input)
 * has to come back from localStorage rather than living only in React state.
 */
export function usePersisted(key, initial) {
  const k = "carbon." + key;
  const [v, setV] = React.useState(() => {
    try { const raw = localStorage.getItem(k); return raw === null ? initial : JSON.parse(raw); }
    catch (e) { return initial; }
  });
  const set = React.useCallback(next => {
    setV(prev => {
      const val = typeof next === "function" ? next(prev) : next;
      try { localStorage.setItem(k, JSON.stringify(val)); } catch (e) { /* private mode / quota */ }
      return val;
    });
  }, [k]);
  return [v, set];
}
