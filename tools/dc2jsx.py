#!/usr/bin/env python3
"""dc-template -> JSX converter (one-time, mechanical).
DSL: {{ expr }} bindings · <sc-for list as> · <sc-if value> · onX="{{fn}}" · style-hover/style-active · ref="{{fn}}"
Output: a React function component receiving V (renderVals output). All style strings go through S() (css text -> object).
Elements with style-hover/style-active become <Hv as="tag" hover=... active=...>."""
import re, html, sys, json
src = open(sys.argv[1], encoding='utf-8').read()
src = re.sub(r'</?x-dc[^>]*>', '', src)  # the export's wrapper element, not part of the view
TAG = re.compile(r'<(/?)([a-zA-Z][\w:-]*)((?:\s+[\w:.-]+(?:="[^"]*")?)*)\s*(/?)>|<!--.*?-->', re.S)
ATTR = re.compile(r'([\w:.-]+)(?:="([^"]*)")?')
VOID = {'br','hr','img','input','meta','link','source','track','wbr','area','base','col','embed','param'}
SVG_KEEP = {'viewBox','preserveAspectRatio','keyPoints','keyTimes','calcMode','repeatCount','attributeName','pathLength','textLength','lengthAdjust','baseFrequency','clipPathUnits','gradientUnits','gradientTransform','patternUnits','spreadMethod','markerWidth','markerHeight','refX','refY','startOffset'}
RENAME = {'class':'className','for':'htmlFor','tabindex':'tabIndex','readonly':'readOnly','autocomplete':'autoComplete','spellcheck':'spellCheck','maxlength':'maxLength','crossorigin':'crossOrigin','autoplay':'autoPlay','playsinline':'playsInline','srcset':'srcSet','contenteditable':'contentEditable'}
def camel(k):
    if k in RENAME: return RENAME[k]
    if k in SVG_KEEP or k.startswith('data-') or k.startswith('aria-'): return k
    if '-' in k or ':' in k:
        parts = re.split(r'[-:]', k); return parts[0] + ''.join(p[:1].upper()+p[1:] for p in parts[1:])
    return k
LIT = re.compile(r'^(true|false|null|undefined|-?\d+(\.\d+)?|"[^"]*"|\'[^\']*\')$')
IDENT = re.compile(r'(?<![\w.$"\'])([A-Za-z_$][\w$]*)')
JS_KW = {'true','false','null','undefined','typeof','new','in','of','if','else','return','this','Math','String','Number','JSON','Object','Array','Boolean','Date','parseFloat','parseInt','isNaN','window','document','console'}
def expr(e, scope):
    e = e.strip()
    if LIT.match(e): return e
    def rep(m):
        n = m.group(1)
        if n in scope or n in JS_KW: return n
        return 'V.' + n
    return IDENT.sub(rep, e)
def jsx_text(t, scope):
    # split on {{ }} bindings; keep whitespace-only text collapsed
    out = []
    pos = 0
    for m in re.finditer(r'\{\{([\s\S]+?)\}\}', t):
        lit = t[pos:m.start()]
        if lit.strip(): out.append('{' + json.dumps(html.unescape(lit)) + '}')   # the design is HTML: decode &amp; etc.
        elif lit and (lit.strip(' ') != lit) and ' ' in lit and '\n' not in lit: out.append('{" "}')
        out.append('{' + expr(m.group(1), scope) + '}')
        pos = m.end()
    lit = t[pos:]
    if lit.strip(): out.append('{' + json.dumps(html.unescape(lit)) + '}')
    return ''.join(out)
def attr_val(name, v, scope):
    """returns JSX attribute string."""
    if v is None: return name
    full = re.fullmatch(r'\s*\{\{([\s\S]+?)\}\}\s*', v)
    if name == 'style':
        inner = expr(full.group(1), scope) if full else json.dumps(v)
        if not full and '{{' in v:   # mixed static + binding in style
            inner = '`' + re.sub(r'\{\{([\s\S]+?)\}\}', lambda m: '${' + expr(m.group(1), scope) + '}', v.replace('`','\\`')) + '`'
        return 'style={S(' + inner + ')}'
    if full: return f'{name}={{{expr(full.group(1), scope)}}}'
    if '{{' in v:
        tpl = re.sub(r'\{\{([\s\S]+?)\}\}', lambda m: '${' + expr(m.group(1), scope) + '}', v.replace('`','\\`'))
        return f'{name}={{`{tpl}`}}'
    return f'{name}={json.dumps(v)}'
out = []; stack = []; scopes = [set()]; unresolved = 0; stats = {'for':0,'if':0,'hover':0,'bind':0,'elems':0}
pos = 0
for m in TAG.finditer(src):
    text = src[pos:m.start()]
    if text.strip() or '{{' in text:
        stats['bind'] += text.count('{{')
        out.append(jsx_text(text, scopes[-1]))
    pos = m.end()
    if m.group(0).startswith('<!--'): continue
    closing, tag, rawattrs, selfclose = m.group(1), m.group(2), m.group(3), m.group(4)
    if closing:
        kind = stack.pop()
        if kind == 'for': out.append('</React.Fragment>))}'); scopes.pop()
        elif kind == 'if': out.append('</>) : null}')
        else: out.append(f'</{kind}>')
        continue
    attrs = dict((a, v) for a, v in ATTR.findall(rawattrs) if a)
    if tag == 'sc-for':
        stats['for'] += 1
        lst = re.fullmatch(r'\s*\{\{([\s\S]+?)\}\}\s*', attrs.get('list','')).group(1)
        var = attrs.get('as','item')
        out.append(f'{{({expr(lst, scopes[-1])} || []).map(({var}, _i{len(stack)}) => (<React.Fragment key={{_i{len(stack)}}}>')
        scopes.append(scopes[-1] | {var}); stack.append('for'); continue
    if tag == 'sc-if':
        stats['if'] += 1
        cond = re.fullmatch(r'\s*\{\{([\s\S]+?)\}\}\s*', attrs.get('value','')).group(1)
        out.append(f'{{({expr(cond, scopes[-1])}) ? (<>'); stack.append('if'); continue
    stats['elems'] += 1
    hover = attrs.pop('style-hover', None); active = attrs.pop('style-active', None)
    attrs.pop('hint-placeholder-count', None); attrs.pop('hint-placeholder-val', None)
    parts = []
    if hover is not None or active is not None:
        stats['hover'] += 1
        parts.append(f'as={json.dumps(tag)}')
        if hover is not None: parts.append(f'hover={json.dumps(hover)}')
        if active is not None: parts.append(f'active={json.dumps(active)}')
        jtag = 'Hv'
    else: jtag = tag
    for a, v in attrs.items():
        parts.append(attr_val(camel(a), v if v != '' or a in ('value','placeholder') else v, scopes[-1]))
    a = (' ' + ' '.join(parts)) if parts else ''
    if selfclose or tag.lower() in VOID:
        out.append(f'<{jtag}{a} />')
    else:
        out.append(f'<{jtag}{a}>'); stack.append(jtag)
tail = src[pos:]
if tail.strip(): out.append(jsx_text(tail, scopes[-1]))
body = ''.join(out)
jsx = ('// GENERATED by tools/dc2jsx.py from design-src/template_body.html — do not hand-edit; re-run the converter.\n'
       'import React from "react";\nimport { S, Hv } from "../../lib/ui.js";\n\n'
       'export default function DashboardTemplate({ V }) {\n  return (<>\n' + body + '\n  </>);\n}\n')
open(sys.argv[2], 'w', encoding='utf-8').write(jsx)
print('stats:', stats, '| unclosed:', stack, '| out chars:', len(jsx))
