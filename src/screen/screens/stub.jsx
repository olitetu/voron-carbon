// An honest placeholder, for any key go() is asked for that has no screen in main.jsx's SCREENS. It says
// so, and says what is known about it, rather than showing a blank panel or, worse, fake data.
import React from "react";
import { S } from "../../lib/ui.js";
import { C, F, L, mono, panel, panelHead } from "../tokens.js";
import { microLabel } from "../vm.js";

export default function Stub({ title, plan = "Not designed yet.", tag = "NOT BUILT YET" }) {
  return (
    <div style={S(`height:100%; padding:${L.pad}px; padding-bottom:${L.fab + L.fabInset}px; animation:ksFade .18s ease both`)}>
      <div style={S(panel("height:100%"))}>
        <div style={S(panelHead())}>
          <span style={S(`width:3px; height:12px; background:${C.bed}; border-radius:1px`)} />
          <span style={S(microLabel())}>{title}</span>
          <span style={S(`margin-left:auto; ${mono(F.micro, `letter-spacing:.14em; color:${C.faint}`)}`)}>{tag}</span>
        </div>
        <div style={S("flex:1; min-height:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; padding:24px")}>
          <span style={S(mono(F.val, `letter-spacing:.18em; color:${C.mute}`))}>{title}</span>
          <span style={S(`font-size:${F.body}px; color:${C.faint}; max-width:620px; text-align:center; text-wrap:pretty; line-height:1.5`)}>{plan}</span>
        </div>
      </div>
    </div>
  );
}
