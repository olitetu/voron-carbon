// Tiny observable store. `raw` mirrors Moonraker's printer objects (deep-merged status updates),
// plus a few host/side channels. Pages read raw fields directly; adapters derive view-models.
import React from "react";
export class Store {
  constructor() {
    this.state = {
      connected: false, klippy: "unknown", serverInfo: null, printerInfo: null,
      raw: {},                 // printer objects: raw.toolhead, raw.extruder, raw["fan_generic Chamber"], raw.mmu, …
      objects: [],             // printer.objects.list
      procStats: null,         // machine.proc_stats
      tempHistory: null,       // server.temperature_store snapshot (+ appended live)
      log: [],                 // gcode_store + live responses, newest first: {time, message, type}
      webcams: [],
      spools: {},              // spoolman spools by id
      activeSpool: null,
      macros: [],              // public gcode_macro names
      config: null,            // configfile.settings (large, static; fetched once beside hydration)
      commands: null,          // printer.gcode.commands — every registered command -> {help?}
      commandsStale: false,    // true while klippy is not ready (the catalogue collapses on shutdown)
      prefs: {},               // persisted UI prefs (carbon namespace)
      ui: { route: "/" },
      uiPhase: null,          // transient motion hint (see signalMotion)
      cutter: null,           // live EREC cutter state (see setCutter) — driven by the macro's own events
    };
    this.listeners = new Set();
  }
  get() { return this.state; }
  set(patch) { this.state = Object.assign({}, this.state, patch); this._emit(); }
  update(fn) { const p = fn(this.state); if (p) this.set(p); }
  mergeStatus(partial) {
    const raw = Object.assign({}, this.state.raw);
    for (const [obj, fields] of Object.entries(partial || {})) raw[obj] = Object.assign({}, raw[obj] || {}, fields || {});
    this.set({ raw });
  }
  /**
   * Optimistic update. Moonraker acknowledges a command in ~6 ms but the status push that
   * confirms it lands ~270 ms later (p90 ~480 ms), so a UI that waits for confirmation feels
   * laggy on every slider and toggle. This applies the expected value at once; the next real
   * status update for those fields overwrites it, so a rejected command self-corrects.
   */
  predict(patch) { this.mergeStatus(patch); }

  /**
   * Transient motion hint.
   *
   * Happy Hare only publishes `mmu.action` during ITS OWN sequences, so a manual retract or a manual
   * `EREC_CUTTER_ACTION` leaves it "Idle" and the design's animations (which are phase-driven) never
   * play. Actions announce what they are doing here; commonVals() prefers HH's real action whenever it
   * reports one and falls back to this. Auto-clears so a failed command cannot strand the animation.
   *
   * phase:  'cutting' | 'presenting' | 'storing' | 'extruding' | 'retracting' | 'loading' | 'unloading'
   * dir:    +1 toward the nozzle, -1 back toward the gate
   * travel: optional 0..1 override for where the filament head should sit. Needed for the cut
   *         choreography: the blade shears at the GATE, so the head has to be drawn there too —
   *         otherwise the blade cuts thin air while the filament is still drawn at the nozzle.
   */
  signalMotion(phase, dir, ms, travel) {
    clearTimeout(this._motionT);
    const d = ms || 1200;
    this.set({ uiPhase: { phase, dir, travel: travel === undefined ? null : travel, endsAt: Date.now() + d } });
    this._motionT = setTimeout(() => this.set({ uiPhase: null }), d);
  }

  /**
   * Live gate-cutter state, driven by the EREC macro's own console output rather than a guess.
   * `mmu/addons/mmu_erec_cutter.cfg` emits RESPOND "EREC Cutter open" / "EREC Cutter closed" around
   * every servo move, so the animation can follow the real hardware: blade parked-and-still while
   * open, shearing while closed, once per configured cut attempt.
   *
   * state: 'open' | 'closed' | null (not cutting)
   * baseMm: filament_position when the cut began, so the feed can be shown as a relative advance
   *         (HH's filament_position is a running value and is NOT zeroed at the gate).
   */
  setCutter(state, filamentPositionMm) {
    const cur = this.state.cutter;
    if (state === null) { if (cur) this.set({ cutter: null }); return; }
    const base = cur && Number.isFinite(cur.baseMm) ? cur.baseMm : (Number.isFinite(filamentPositionMm) ? filamentPositionMm : 0);
    const cuts = (cur ? cur.cuts : 0) + (state === "closed" ? 1 : 0);
    this.set({ cutter: { state, cuts, baseMm: base, at: Date.now() } });
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() {
    if (typeof window !== "undefined") { const p = (window.__perf = window.__perf || { renders: 0, ms: 0, max: 0, emits: 0, byAdapter: {} }); p.emits = (p.emits || 0) + 1; }
    for (const fn of this.listeners) fn(this.state);
  }
}
/** React hook: re-renders when selector(state) changes (shallow-equal for objects/arrays by reference). */
export function useStore(store, selector = s => s) {
  return React.useSyncExternalStore(cb => store.subscribe(cb), () => selector(store.state), () => selector(store.state));
}
