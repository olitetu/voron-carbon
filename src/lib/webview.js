// Host detection for the one embedding that behaves differently: Orca Slicer's Device tab.
//
// Orca's PrinterWebView (src/slic3r/GUI/PrinterWebView.cpp) binds NO download handler, and turns every
// new-window request into `wxLaunchDefaultBrowser(url); evt.Veto();`. So inside Orca:
//
//   same-tab navigation to a `Content-Disposition: attachment` response  -> silently dropped, no file
//   new-window request (target=_blank / window.open)                      -> the SYSTEM browser gets the
//                                                                           URL, downloads it, and this
//                                                                           page never moves
//
// A real browser is the mirror image: same-tab keeps the app where it is and saves the file, while a new
// window would leave an empty tab behind. Hence one helper that picks per host, instead of each download
// button guessing.
//
// Detected two ways, either is enough: Orca registers a "wx" WKScriptMessageHandler on the page, and its
// user agent carries the token it inherited from Bambu Studio ("BBL-Slicer/v01.10.01.50"). Every Carbon
// session in this printer's Moonraker logs carries that user agent.

export const inOrca = (() => {
  try {
    const w = typeof window !== "undefined" ? window : null;
    if (w && w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers.wx) return true;
    return /BBL-Slicer|OrcaSlicer/i.test((typeof navigator !== "undefined" && navigator.userAgent) || "");
  } catch (e) {
    return false;
  }
})();

/** Props for an <a href> that downloads its target wherever Carbon is running. */
export function downloadProps() {
  return inOrca ? { target: "_blank", rel: "noopener" } : { download: true };
}

/**
 * Download from a click handler that is not an anchor. Must be called synchronously inside the click:
 * WKWebView only honours window.open during a user gesture.
 */
export function downloadUrl(url) {
  if (inOrca) window.open(url, "_blank", "noopener");
  else location.assign(url);
}

/** What a download button should say happened, so Orca users know to look in their browser. */
export const downloadHint = inOrca ? "opens in your browser, which saves it to Downloads" : "saves to your Downloads folder";
