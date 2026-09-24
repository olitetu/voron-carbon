// ---------------------------------------------------------------------------
// Client for the Carbon Screen host helper (tools/helper/carbon_helper.py).
//
// The helper does the handful of things a browser page cannot: wifi scan and
// connect, and the panel backlight. It is OPTIONAL -- the app must work without
// it, showing read-only network facts from Moonraker and hiding the controls it
// cannot honour. Hence probe() and the `available` flag: nothing here should
// ever render a control that will fail.
//
// It is reachable only over loopback (nginx: allow 127.0.0.1; deny all), so on
// the panel Chromium must open http://127.0.0.1:8767/screen.html. Opened as
// voron.local the probe fails, `available` stays false, and the UI correctly
// falls back to read-only.
// ---------------------------------------------------------------------------

const BASE = "/helper";
const TIMEOUT = 8000;

// How long the helper can take. These mirror carbon_helper.py's CONNECT_CEILING and QUICK_CEILING, the sums
// of its nmcli timeouts, and must move with them, as must nginx's /helper/ proxy_read_timeout (210 s, in
// tools/install.sh and tools/helper/nginx-helper.conf).
/** Worst case of one /wifi/connect with its rollback: CONNECT_CEILING is 182 s. Until this much time has
 *  passed since it was sent, a connect whose answer was lost may still be running under the helper's lock. */
export const CONNECT_CEILING_MS = 185000;
/** helper.connect() gives up after this. It is above CONNECT_CEILING_MS, so the helper's own answer, success
 *  or rollback, always arrives first, and an abort means the helper has already finished or died. */
export const CONNECT_TIMEOUT_MS = 210000;
/** Worst case of a forget or radio change (QUICK_CEILING, 55 s: the active-profile check, then one nmcli
 *  run). helper.js gives up on those after TIMEOUT, long before, so a lost answer may still be acted on. */
export const CHANGE_CEILING_MS = 60000;

async function call(path, { method = "GET", body, timeout = TIMEOUT } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(BASE + path, {
      method,
      signal: ctl.signal,
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON: treat as empty */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `helper ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

export const helper = {
  /** null until probed, then true/false. Read this before rendering a control. */
  available: null,
  /** /health's `nmcli`: the helper found nmcli. Without it the helper answers but can neither read nor change
   *  wifi (every /net says state unknown), so the network screen stays read-only and says nmcli is missing. */
  nmcli: false,
  /** true when this nmcli would not take the wifi secret on stdin (see the daemon). */
  pskViaArgv: false,
  /** true when a writable /sys/class/backlight device exists. FALSE on this printer:
   *  the panel is HDMI, which has no backlight node, so there is no software
   *  brightness at all. The settings screen must hide the control, not grey it. */
  backlight: false,
  /** true when the X server has DPMS, i.e. the screen can be switched off.
   *  This DOES work on HDMI and is the only screen-power control it has. */
  canBlank: false,

  async probe() {
    try {
      const h = await call("/health", { timeout: 2500 });
      this.available = !!(h && h.ok);
      this.nmcli = !!(h && h.nmcli);
      this.pskViaArgv = !!(h && h.psk_via_argv);
      if (this.available) {
        try {
          const d = await call("/display", { timeout: 2500 });
          this.backlight = !!(d && d.brightness_supported);
          this.canBlank = !!(d && d.blank_supported);
        } catch (e) { this.backlight = false; this.canBlank = false; }
      }
    } catch (e) {
      this.available = false;
      this.nmcli = false;
    }
    return this.available;
  },

  net()                 { return call("/net"); },
  wifi()                { return call("/wifi", { timeout: 70000 }); },   // worst case ~65 s: radio 10 + rescan 45 + profiles 10
  radio(on)             { return call("/wifi/radio", { method: "POST", body: { on } }); },
  forget(ssid)          { return call("/wifi/forget", { method: "POST", body: { ssid } }); },
  connect(ssid, psk, hidden = false) {
    return call("/wifi/connect", {
      method: "POST", body: { ssid, psk, hidden }, timeout: CONNECT_TIMEOUT_MS,
    });
  },
  display()             { return call("/display"); },
  brightness(pct)       { return call("/display/brightness", { method: "POST", body: { pct } }); },
  blank(on)             { return call("/display/blank", { method: "POST", body: { on } }); },
};

/** Signal strength -> 0..4 bars, matching the design's block glyphs. */
export function bars(signal) {
  const s = Number(signal) || 0;
  return s >= 75 ? 4 : s >= 55 ? 3 : s >= 35 ? 2 : s > 0 ? 1 : 0;
}

/** Read-only network facts from Moonraker, for when the helper is absent. */
export function netFromMoonraker(st) {
  const n = (st.systemInfo || {}).network || {};
  const iface = Object.keys(n)[0];
  if (!iface) return null;
  const v4 = (n[iface].ip_addresses || []).find(a => a.family === "ipv4");
  return { iface, ip: v4 ? v4.address : null, mac: n[iface].mac_address || null, readOnly: true };
}
