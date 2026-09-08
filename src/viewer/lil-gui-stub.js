// lil-gui is gcode-preview's dev-only tweak panel. Its static import is not tree-shaken, so this stub
// replaces it at build time (see build.mjs alias) — ~31 KB raw saved for a GUI Carbon never shows.
export default class GUI { constructor() {} add() { return this; } addFolder() { return this; } addColor() { return this; } name() { return this; } onChange() { return this; } listen() { return this; } close() { return this; } open() { return this; } destroy() {} hide() { return this; } show() { return this; } }
export { GUI };
