// ---------------------------------------------------------------------------
// NOTIFICATIONS — Moonraker's announcements on the panel: the list, one entry's detail, and DISMISS / SNOOZE.
//
// What the printer and Moonraker's own source say (2026-09-23, read-only GETs against Moonraker
// v0.10.0-21-g9bceead; components/announcements.py and docs/external_api/announcements.md read at the v0.10.0 tag
// for every field and parameter used below):
//   server.announcements.list  {"entries": [], "feeds": ["moonraker", "klipper", "spoolman"]}, with and without
//                              include_dismissed. The three Moonlight RSS feeds Moonraker polls
//                              (arksine.github.io/moonlight/assets/<feed>.xml) hold no <item> at all right now, so
//                              the empty state is this screen's NORMAL state, not an edge case. "spoolman" is there
//                              because Moonraker's spoolman component calls register_feed("spoolman").
//   include_dismissed          defaults to TRUE: a bare list returns dismissed entries too, flagged dismissed:true.
//                              This screen asks for them on purpose and greys them. (main.jsx's MORE-tile count uses
//                              the bare list, so it counts dismissed ones as "unread" — see the integrator note.)
//   entry fields               entry_id (a path, e.g. "arksine/moonraker/issue/349"), url, title, description (the
//                              first paragraph of the GitHub issue, Markdown, <=512 chars), priority ("normal" |
//                              "high", from the RSS <category>, so it can be missing), date (unix s), dismissed,
//                              date_dismissed, dismiss_wake, source ("moonlight" | "internal"), feed.
//   live updates               Moonraker re-reads its feeds every 1800 s (UPDATE_CHECK_TIME) and pushes
//                              notify_announcement_update when anything changed; a dismiss and a snooze expiring
//                              push notify_announcement_dismissed / notify_announcement_wake. Each of the three
//                              re-reads the list here (coalesced), so it stays current with no polling of our own.
//   server.announcements.dismiss  reads entry_id (required) and wake_time (optional, int SECONDS) and nothing else.
//                              There is NO un-dismiss endpoint, and dismissing an entry that is already dismissed
//                              returns silently (so a snooze cannot be turned into a permanent dismiss). Without
//                              wake_time the entry stays dismissed until Moonraker DELETES it — prune_by_prefix
//                              drops it once its issue is closed and the feed no longer lists it; it never comes
//                              back un-dismissed unless the issue is re-opened. The flag lives in Moonraker's
//                              database, so the entry is hidden on every client at once (Mainsail too). That is
//                              why both DISMISS and SNOOZE go through a confirm, and the confirm says so.
//   dismiss_wake               an ABSOLUTE time (curtime + wake_time) in the source, although the API docs call it
//                              "time remaining". Moonraker re-arms the wake timer from its database on restart.
//   CLOCK SKEW                 date_dismissed, dismiss_wake and an INTERNAL entry's date are all
//                              datetime.utcnow().timestamp() — a naive UTC time read back as LOCAL time. This Pi is
//                              on UTC-4 (moonraker.log stamps 11:30:06 where nginx's Last-Modified says 15:30:06 GMT),
//                              so those three are 4 h in the future. RSS dates (parsed from a GMT pubDate) are right.
//                              (Re-checked 2026-09-23: moonraker.log's last line 12:17:10 vs Last-Modified 16:17:10
//                              GMT.) So a snooze is shown as its LENGTH (dismiss_wake - date_dismissed: the skew
//                              cancels), never as a wake clock time. An internal entry's TRUE date is recovered from
//                              its entry_id: add_internal_announcement builds it as
//                              f"{feed}/{utcnow().isoformat(timespec='seconds')}", i.e. the same instant as naive
//                              UTC text, which parses exactly with a "Z". Only when an id does not have that shape
//                              is the skewed `date` shown, with a warning and no "ago".
//   internal entries           in Moonraker v0.10.0 itself only machine.py ("Sudo Password Required" during a
//                              Moonraker self-update, feed "machine", priority high) and simplyprint (not configured
//                              here) raise them. Happy Hare v3.4.2's components/mmu_server.py raises none (its only
//                              mention of announcements is a type import). announcements.py is unchanged between
//                              v0.10.0 and this printer's 9bceead (GitHub compare: 21 commits, none touch it).
//
// URLs are TEXT, never links. This page runs in Chromium --kiosk --app on the printer (tools/kiosk); following a
// link navigates the panel away with no browser chrome to come back, so the URL is printed for the user to open on
// a phone or PC. Markdown links inside a description are flattened the same way; no HTML is ever built from it.
//
// Nothing is sent on render or mount: the only automatic request is the read-only server.announcements.list (on
// mount, on reconnect, on REFRESH and on the three notifications). DISMISS / SNOOZE are Moonraker RPCs, not g-code,
// so they do not go through act.guarded — its guards are about Klipper, and announcements work with Klipper shut
// down or mid-print. They are refused only when Moonraker itself is unreachable (or the entry is already
// dismissed), and re-checked against the latest list when CONFIRM is tapped. There is no "check feeds now"
// (server.announcements.update): Moonraker's docs call it a development aid, and it already polls every 30 minutes.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { badgeStyle, microLabel } from "../vm.js";
import { Chip, Panel, PanelBtn, Empty } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";
import { fmtAgo, fmtStamp, fmtSpan } from "../../lib/history.js";

const DASH = "—";
const ROW_H = 68;
const WEEK = 7 * 86400;
/** Snooze choices: [label, wake_time seconds]. Moonraker takes any int; these match the usual "remind me" set. */
const SNOOZE = [["1 DAY", 86400], ["1 WEEK", WEEK]];
const NOTIFY = ["notify_announcement_update", "notify_announcement_dismissed", "notify_announcement_wake"];
const TABS = [["active", "NEW"], ["dismissed", "DISMISSED"], ["all", "ALL"]];

const num = v => (typeof v === "number" && isFinite(v) ? v : null);
const errText = e => (e && e.message ? e.message : String(e || "error"));
const isHigh = e => String((e && e.priority) || "").toLowerCase() === "high";
/** add_internal_announcement's id: `<feed>/<naive UTC isoformat, seconds>`. See CLOCK SKEW in the header. */
const INTERNAL_ID = /\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})$/;
/**
 * The entry's true creation time. RSS dates are right as sent. An internal entry's `date` is
 * datetime.utcnow().timestamp() (off by the host's UTC offset), so its time is re-read from the entry_id,
 * which Moonraker writes from the same utcnow() as UTC text. `skewed` is true only when that is impossible.
 */
const dateOf = e => {
  if (e.source !== "internal") return { t: num(e.date), skewed: false };
  const m = INTERNAL_ID.exec(String(e.entry_id || ""));
  const t = m ? Date.parse(m[1] + "Z") / 1000 : NaN;
  return Number.isFinite(t) ? { t, skewed: false } : { t: num(e.date), skewed: true };
};
/** Snooze length in seconds, or null for an indefinite dismissal. Both stamps carry the same skew, so it cancels. */
const snoozeLen = e => (e.dismissed && num(e.dismiss_wake) !== null && num(e.date_dismissed) !== null
  ? Math.max(0, e.dismiss_wake - e.date_dismissed) : null);
/** "3 h ago" inside a week; past that the full date, because fmtAgo drops the year and feeds keep old issues. */
const when = e => {
  const d = dateOf(e);
  if (d.t === null) return DASH;
  if (d.skewed) return fmtStamp(d.t);
  return Date.now() / 1000 - d.t < WEEK ? fmtAgo(d.t) : fmtStamp(d.t);
};
const sourceText = s => (s === "moonlight" ? "MOONLIGHT RSS" : s === "internal" ? "MOONRAKER ITSELF" : String(s || DASH).toUpperCase());
const stateText = e => {
  if (!e.dismissed) return "NEW";
  const s = snoozeLen(e);
  return s !== null ? `SNOOZED ${fmtSpan(s)}` : "DISMISSED";
};

/**
 * A description is GitHub Markdown. Flatten the three things that appear in issue first paragraphs: a link
 * becomes its text followed by the URL as text, `code` keeps its content in mono, **bold** / __bold__ lose the
 * markers. Everything else is shown verbatim.
 */
const MD = /\[([^\]]*)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__/g;
function segments(text) {
  const src = String(text || "");
  const out = [];
  let last = 0, m;
  MD.lastIndex = 0;
  while ((m = MD.exec(src))) {
    if (m.index > last) out.push({ t: src.slice(last, m.index) });
    if (m[2]) {
      if (m[1] && m[1] !== m[2]) out.push({ t: m[1] + " " });
      out.push({ url: m[2] });
    } else if (m[3]) out.push({ code: m[3] });
    else out.push({ t: m[4] || m[5] || "" });
    last = MD.lastIndex;
  }
  if (last < src.length) out.push({ t: src.slice(last) });
  return out;
}

function Description({ text }) {
  if (!text) return <span style={S(mono(F.label, `color:${C.faint}`))}>No description in this entry.</span>;
  return (
    <>
      {segments(text).map((s, i) => s.url
        ? <span key={i} style={S(mono(F.label, `color:${C.cool}; word-break:break-all`))}>({s.url})</span>
        : s.code
          ? <span key={i} style={S(mono(F.label, `color:${C.hot}`))}>{s.code}</span>
          : <span key={i}>{s.t}</span>)}
    </>
  );
}

function Field({ k, v, color = C.body }) {
  return (
    <div style={S("min-width:0; display:flex; flex-direction:column; gap:1px")}>
      <span style={S(mono(F.micro, `letter-spacing:.14em; color:${C.faint}`))}>{k}</span>
      <span style={S(mono(F.label, `color:${color}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{v}</span>
    </div>
  );
}

export default function Notifications({ st, api, act, say }) {
  const [tab, setTab] = React.useState("active");
  const [selId, setSelId] = React.useState("");
  const [confirm, setConfirm] = React.useState(null);
  const [pending, setPending] = React.useState("");   // entry_id with a dismiss in flight
  const [feed, setFeed] = React.useState({ entries: [], feeds: [], loaded: false, loading: false, error: null, at: null });
  const feedRef = React.useRef(feed); feedRef.current = feed;
  const alive = React.useRef(true);
  // Re-armed in the body, not only in the initializer: an effect that is torn down and re-run (StrictMode, a
  // fast refresh) would otherwise leave alive=false forever and silently drop every reply.
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const seq = React.useRef(0);
  const connected = !!st.connected;

  // ---- the list: one read-only RPC. A ticket drops any reply a newer read superseded; a failed re-read keeps
  // the entries already on screen and says so rather than blanking them.
  const load = React.useCallback(() => {
    const run = ++seq.current;
    setFeed(f => ({ ...f, loading: true, error: null }));
    api.rpc("server.announcements.list", { include_dismissed: true })
      .then(r => {
        if (!alive.current || run !== seq.current) return;
        setFeed({
          entries: Array.isArray(r && r.entries) ? r.entries.filter(e => e && e.entry_id) : [],
          feeds: Array.isArray(r && r.feeds) ? r.feeds : [],
          loaded: true, loading: false, error: null, at: Date.now() / 1000,
        });
      })
      .catch(e => { if (alive.current && run === seq.current) setFeed(f => ({ ...f, loading: false, error: errText(e) })); });
  }, [api]);

  // First read, and again whenever the socket comes back (an RPC issued while disconnected just rejects).
  React.useEffect(() => { if (connected) load(); }, [connected, load]);

  // Moonraker's own pushes: new/removed entries, a dismissal (from any client), a snooze running out.
  React.useEffect(() => {
    if (!api || typeof api.on !== "function") return undefined;
    let t = 0;
    const kick = () => { clearTimeout(t); t = setTimeout(load, 300); };
    const offs = NOTIFY.map(ev => api.on(ev, kick));
    return () => { clearTimeout(t); offs.forEach(off => { if (typeof off === "function") off(); }); };
  }, [api, load]);

  // ---- derived ---------------------------------------------------------------------------------------------
  const entries = feed.entries;
  const active = entries.filter(e => !e.dismissed);
  const dismissed = entries.filter(e => e.dismissed);
  // Moonraker returns newest first. Keep that inside each group, but put high priority on top of the new ones:
  // its docs ask front-ends to make high-priority entries stand out.
  const byPriority = list => list.filter(isHigh).concat(list.filter(e => !isHigh(e)));
  const rows = tab === "active" ? byPriority(active)
    : tab === "dismissed" ? dismissed
      : byPriority(active).concat(dismissed);
  const counts = { active: active.length, dismissed: dismissed.length, all: entries.length };
  const sel = rows.find(e => e.entry_id === selId) || rows[0] || null;
  const selDate = sel ? dateOf(sel) : { t: null, skewed: false };
  const feedsText = feed.feeds.length ? feed.feeds.join(" · ") : DASH;

  // ---- DISMISS / SNOOZE ---------------------------------------------------------------------------------------
  const why = e => {
    if (!e) return "no announcement selected";
    if (!connected) return "Moonraker is not connected";
    if (e.dismissed) {
      const s = snoozeLen(e);
      return s !== null ? `snoozed for ${fmtSpan(s)} — Moonraker brings it back by itself` : "already dismissed — Moonraker has no un-dismiss";
    }
    if (pending) return pending === e.entry_id ? "dismissing…" : "another dismiss is in flight";
    return null;
  };
  const selWhy = why(sel);

  const ask = (e, label, wake) => {
    const title = e.title ? `“${e.title}”` : "this announcement";
    // Moonraker never un-dismisses by itself: it DELETES the entry once the source withdraws it.
    const gone = e.source === "moonlight"
      ? `Moonraker deletes it once its GitHub issue is closed and the ${e.feed || "RSS"} feed drops it`
      : "Moonraker deletes it when the component that raised it withdraws it";
    setConfirm({
      label: wake ? `SNOOZE ${label}` : "DISMISS",
      id: e.entry_id, wake, say: wake ? `SNOOZED ${label}` : "DISMISSED",
      confirm: wake
        ? `Hide ${title} for ${label.toLowerCase()}? Moonraker brings it back by itself afterwards. Until then it is hidden on every client, Mainsail included, and cannot be dismissed for good.`
        : `Hide ${title} for good? Moonraker has no un-dismiss: it stays hidden on every client, Mainsail included, until ${gone}.`,
      cmd: `server.announcements.dismiss entry_id=${e.entry_id}${wake ? ` wake_time=${wake}` : ""}`,
    });
  };

  const runDismiss = c => {
    // Re-decided NOW against the latest list: another client may have dismissed it, or the feed dropped it,
    // while the dialog was up.
    const cur = feedRef.current.entries.find(e => e.entry_id === c.id);
    const w = cur ? why(cur) : "it is no longer in Moonraker's list";
    if (w) { act.refuse(c.label, w); return; }
    const params = { entry_id: c.id };
    if (c.wake) params.wake_time = c.wake;
    setPending(c.id);
    api.rpc("server.announcements.dismiss", params)
      .then(() => { if (alive.current) { say(c.say); load(); } })
      // A failure usually means the list on screen is stale (e.g. "No key matching entry id": the feed dropped
      // it). Re-read, so what is shown is what Moonraker holds.
      .catch(e => { act.refuse(c.label, errText(e)); if (alive.current) load(); })
      .then(() => { if (alive.current) setPending(""); });
  };

  // ---- list body ----------------------------------------------------------------------------------------------
  const fab = L.fab + L.fabInset;
  let body;
  // Disconnected is checked FIRST: a read that died with the socket ("socket closed") is not the answer, and
  // it is retried by itself on reconnect.
  if (!feed.loaded && !connected) {
    body = <Empty title="WAITING FOR MOONRAKER" hint={`Announcements come from Moonraker, and the panel is not connected to it${feed.error ? ` (last read: ${feed.error})` : " yet"}. They are read again as soon as it is.`} />;
  } else if (!feed.loaded && feed.error) {
    body = <Empty title="ANNOUNCEMENTS UNAVAILABLE" hint={`server.announcements.list failed: ${feed.error}`} />;
  } else if (!feed.loaded) {
    body = <Empty title="READING ANNOUNCEMENTS" hint="server.announcements.list" />;
  } else if (!entries.length) {
    body = (
      <Empty title="NO ANNOUNCEMENTS"
        hint={`Moonraker follows the ${feed.feeds.length ? feed.feeds.join(", ") : "default"} feed${feed.feeds.length === 1 ? "" : "s"} and none has an open announcement. It re-checks every 30 minutes; anything new appears here by itself.`} />
    );
  } else if (!rows.length) {
    body = tab === "active"
      ? <Empty title="NOTHING NEW" hint={`${counts.dismissed} dismissed or snoozed — DISMISSED lists ${counts.dismissed === 1 ? "it" : "them"}.`} />
      : <Empty title="NOTHING DISMISSED" hint="Dismissed and snoozed announcements are listed here, greyed out." />;
  } else {
    body = (
      <div className="scroll" style={S("flex:1; min-height:0; overflow-y:auto")}>
        {rows.map(e => {
          const on = sel && e.entry_id === sel.entry_id;
          const high = isHigh(e);
          const badge = e.dismissed ? stateText(e) : high ? "HIGH" : "";
          return (
            <Hv as="div" key={e.entry_id} onClick={() => setSelId(e.entry_id)} active={`background:${C.line1}`}
              style={`position:relative; height:${ROW_H}px; display:flex; align-items:center; gap:12px; padding:0 14px; border-bottom:1px solid ${C.line0}; cursor:pointer; background:${on ? C.rowOn : "transparent"}; opacity:${e.dismissed ? 0.55 : 1}`}>
              <span style={S(`position:absolute; left:0; top:8px; bottom:8px; width:3px; border-radius:1px; background:${on ? C.accent : "transparent"}`)} />
              <span style={S(`width:8px; height:8px; flex:none; border-radius:50%; background:${e.dismissed ? C.ghost : high ? C.accent : C.cool}`)} />
              <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:4px")}>
                <span style={S(mono(F.body, `color:${on ? C.accent : e.dismissed ? C.dim : C.text}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{e.title || DASH}</span>
                <span style={S(mono(F.micro, `letter-spacing:.04em; color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
                  {[String(e.feed || DASH).toUpperCase(), when(e), e.priority ? String(e.priority).toLowerCase() : "no priority"].join(" · ")}
                </span>
              </div>
              {badge ? <span style={S(badgeStyle(e.dismissed ? "off" : "err"))}>{badge}</span> : null}
            </Hv>
          );
        })}
      </div>
    );
  }

  // ---- detail -------------------------------------------------------------------------------------------------
  const detail = sel ? (
    <Panel title="ANNOUNCEMENT"
      right={<span style={S(badgeStyle(isHigh(sel) ? "err" : "off"))}>{sel.priority ? String(sel.priority).toUpperCase() : "NO PRIORITY"}</span>}
      style="min-height:0" bodyStyle="padding:10px 12px; gap:9px">
      <span style={S(`${mono(F.val, `color:${sel.dismissed ? C.dim : C.text}; line-height:1.3; word-break:break-word`)}; flex:none; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; overflow:hidden`)}>
        {sel.title || DASH}
      </span>
      <div style={S("flex:none; display:grid; grid-template-columns:1fr 1fr; gap:7px 12px")}>
        <Field k="FEED" v={String(sel.feed || DASH).toUpperCase()} />
        <Field k="SOURCE" v={sourceText(sel.source)} />
        <Field k="DATE" v={selDate.t === null ? DASH : fmtStamp(selDate.t)} color={selDate.skewed ? C.bed : C.body} />
        <Field k="STATE" v={stateText(sel)} color={sel.dismissed ? C.mute : isHigh(sel) ? C.accent : C.cool} />
      </div>
      {selDate.skewed ? (
        <span style={S(`flex:none; ${mono(F.micro, `color:${C.bed}; line-height:1.35`)}`)}>
          INTERNAL ENTRY: MOONRAKER STAMPS IT IN UTC READ AS LOCAL TIME, SO THE DATE IS OFF BY THIS HOST&rsquo;S UTC OFFSET.
        </span>
      ) : null}
      <div className="scroll" style={S(`flex:1; min-height:0; overflow-y:auto; font-size:${F.body}px; color:${sel.dismissed ? C.dim : C.body}; line-height:1.45; white-space:pre-wrap; word-break:break-word; padding:8px 10px; border:1px solid ${C.line2}; border-radius:${L.radiusSm}px; background:${C.panelSunk}`)}>
        <Description text={sel.description} />
      </div>
      <div style={S("flex:none; display:flex; flex-direction:column; gap:3px; min-width:0")}>
        <span style={S(microLabel(C.faint))}>LINK · OPEN IT ON A PHONE OR PC</span>
        <span style={S(`${mono(F.label, `color:${sel.url ? C.cool : C.faint}; line-height:1.3; word-break:break-all`)}; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden`)}>
          {sel.url || "no link in this entry"}
        </span>
      </div>
      {selWhy ? (
        <span style={S(`flex:none; ${mono(F.micro, `letter-spacing:.06em; color:${C.bed}; line-height:1.35`)}`)}>{selWhy.toUpperCase()}</span>
      ) : null}
      <div style={S("flex:none; display:grid; grid-template-columns:1.2fr 1fr 1fr; gap:8px")}>
        <PanelBtn label="DISMISS" sub="FOR GOOD" tone="danger" h={TAP.min} disabled={!!selWhy} why={selWhy || undefined}
          onTap={() => ask(sel, "", null)} />
        {SNOOZE.map(([label, secs]) => (
          <PanelBtn key={label} label={label} sub="SNOOZE" h={TAP.min} disabled={!!selWhy} why={selWhy || undefined}
            onTap={() => ask(sel, label, secs)} />
        ))}
      </div>
    </Panel>
  ) : (
    <div style={S(panel("min-height:0"))}>
      <Empty title="NOTHING SELECTED" hint={rows.length ? "Pick an announcement on the left to read it." : "This filter is empty; the other filters list the rest."} />
    </div>
  );

  // ---- layout: list (+ detail once there is something to detail) / FAB spacer + filters + refresh -------------
  const status = feed.error
    ? (feed.loaded ? "RE-READ FAILED" : "READ FAILED")
    : feed.loading ? "READING…"
      : feed.at !== null ? `LAST READ ${fmtAgo(feed.at).toUpperCase()}` : DASH;
  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; position:relative; animation:ksFade .18s ease both`)}>

      <div style={S(`flex:1; min-height:0; display:grid; grid-template-columns:${entries.length ? "minmax(0,1fr) 420px" : "minmax(0,1fr)"}; grid-template-rows:minmax(0,1fr); gap:${L.gap}px`)}>
        <Panel title="MOONRAKER ANNOUNCEMENTS" style="min-height:0; overflow:hidden"
          right={<span style={S(mono(F.micro, `letter-spacing:.1em; color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>FEEDS {feedsText}</span>}>
          {body}
        </Panel>
        {entries.length ? detail : null}
      </div>

      <div style={S(`flex:none; display:grid; grid-template-columns:${fab}px repeat(3,150px) minmax(0,1fr) 150px; gap:8px; align-items:center`)}>
        <span />
        {TABS.map(([k, label]) => (
          <Chip key={k} label={label} sub={feed.loaded ? String(counts[k]) : DASH} on={tab === k} h={L.fab} fs={F.label}
            onTap={() => setTab(k)} />
        ))}
        <div style={S("min-width:0; display:flex; flex-direction:column; align-items:flex-end; gap:3px")}>
          <span style={S(mono(F.micro, `letter-spacing:.12em; color:${feed.error ? C.accent : C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%`))}>{status}</span>
          <span style={S(mono(F.micro, `letter-spacing:.12em; color:${C.ghost}; white-space:nowrap`))}>MOONRAKER CHECKS EVERY 30 MIN</span>
        </div>
        <PanelBtn label="REFRESH" h={L.fab} disabled={feed.loading || !connected}
          why={!connected ? "Moonraker is not connected" : feed.loading ? "a read is already in flight" : undefined}
          onTap={load} />
      </div>

      {confirm ? (
        <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
          onYes={() => { const c = confirm; setConfirm(null); runDismiss(c); }} />
      ) : null}
    </div>
  );
}
