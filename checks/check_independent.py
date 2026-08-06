#!/usr/bin/env python3
"""Independent re-measurement of what legible-docs claims.

This file imports NOTHING from the package under test. It does not import the JavaScript, it
does not shell out to `node`, and it does not read the tool's own report as though it were
evidence. It reads the same HTML a browser would and works the numbers out again, in a
different language, with a second implementation of the sRGB contrast maths and a second
implementation of the small CSS cascade needed to find out what colour a run of text is
painted in.

scripts/prove_independence.py walks this file's import graph with `ast` and fails if any of
that stops being true.

Why a second implementation rather than a second call: a checker that shares code with the
thing it checks inherits its bugs and reports clean on output that is not. The specific bug
this is aimed at is a simplified relative-luminance formula. Dropping the sRGB linearisation
shifts #767676 on white from 4.54:1 to 2.05:1, and a shared helper would report the same wrong
number twice and call it agreement.

What it checks:
  1. Its own contrast function against three ratios computed by hand, so a bug HERE is caught
     before it is used to judge anything.
  2. Every ratio the tool reported, recomputed from the colour pair the tool reported.
  3. Every source document, measured from scratch, and the tool's headline minimum contrast
     required to be one of the ratios this file independently found.
  4. Every remediated document, measured from scratch, required to pass the WCAG threshold for
     its own size and weight, and required to pass the checks the original failed.

Usage:
    check_independent.py --corpus <dir> --work <dir>
Exit code 0 means every claim held. Any other exit code means at least one did not.
"""

import argparse
import json
import math
import os
import re
import sys
from html.parser import HTMLParser

# --------------------------------------------------------------------------------------
# sRGB and WCAG 2.1, written out from the specification.
# --------------------------------------------------------------------------------------

WCAG_NORMAL = 4.5
WCAG_LARGE = 3.0
PX_PER_PT = 96.0 / 72.0
LARGE_PX = 18.0 * PX_PER_PT          # 18pt = 24px
LARGE_BOLD_PX = 14.0 * PX_PER_PT     # 14pt = 18.6666...px


def channel_to_linear(c8):
    """One 0..255 channel to linear light, WCAG 2.1 relative luminance definition."""
    c = c8 / 255.0
    if c <= 0.03928:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def relative_luminance(rgb):
    r, g, b = rgb[0], rgb[1], rgb[2]
    return (0.2126 * channel_to_linear(r)
            + 0.7152 * channel_to_linear(g)
            + 0.0722 * channel_to_linear(b))


def contrast_ratio(fg, bg):
    l1 = relative_luminance(fg)
    l2 = relative_luminance(bg)
    lighter, darker = (l1, l2) if l1 >= l2 else (l2, l1)
    return (lighter + 0.05) / (darker + 0.05)


def is_large_text(px, weight):
    if px >= LARGE_PX:
        return True
    return weight >= 700 and px >= LARGE_BOLD_PX


def required_ratio(px, weight):
    return WCAG_LARGE if is_large_text(px, weight) else WCAG_NORMAL


# --------------------------------------------------------------------------------------
# Colour parsing, independent of the tool's parser.
# --------------------------------------------------------------------------------------

NAMED = {
    'black': (0, 0, 0), 'white': (255, 255, 255), 'silver': (192, 192, 192),
    'gray': (128, 128, 128), 'grey': (128, 128, 128), 'red': (255, 0, 0),
    'green': (0, 128, 0), 'blue': (0, 0, 255), 'navy': (0, 0, 128),
    'yellow': (255, 255, 0), 'maroon': (128, 0, 0), 'olive': (128, 128, 0),
    'lime': (0, 255, 0), 'teal': (0, 128, 128), 'aqua': (0, 255, 255),
    'fuchsia': (255, 0, 255), 'purple': (128, 0, 128), 'orange': (255, 165, 0),
    'whitesmoke': (245, 245, 245), 'gainsboro': (220, 220, 220),
    'lightgray': (211, 211, 211), 'lightgrey': (211, 211, 211),
    'darkgray': (169, 169, 169), 'darkgrey': (169, 169, 169),
    'dimgray': (105, 105, 105), 'dimgrey': (105, 105, 105),
}

_HSL_RE = re.compile(r'^hsla?\s*\(([^)]*)\)$')
_RGB_RE = re.compile(r'^rgba?\s*\(([^)]*)\)$')


def _hue_to_rgb(p, q, t):
    t = t % 1.0
    if t < 1 / 6:
        return p + (q - p) * 6 * t
    if t < 1 / 2:
        return q
    if t < 2 / 3:
        return p + (q - p) * (2 / 3 - t) * 6
    return p


def parse_color(text):
    """Returns (r, g, b, a) with r/g/b in 0..255, or None.

    None means "this value could not be read", and it must never be confused with black.
    Silently substituting black would turn an unmeasurable colour into the highest contrast
    colour there is, and a failing document into a passing one.
    """
    if text is None:
        return None
    s = str(text).strip().lower()
    if not s:
        return None
    if s == 'transparent':
        return (0, 0, 0, 0.0)
    if s in NAMED:
        r, g, b = NAMED[s]
        return (r, g, b, 1.0)
    if s.startswith('#'):
        h = s[1:]
        if not re.fullmatch(r'[0-9a-f]+', h):
            return None
        if len(h) == 3:
            return (int(h[0] * 2, 16), int(h[1] * 2, 16), int(h[2] * 2, 16), 1.0)
        if len(h) == 6:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 1.0)
        if len(h) == 8:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16) / 255.0)
        return None
    m = _RGB_RE.match(s)
    if m:
        parts = [p for p in re.split(r'[\s,/]+', m.group(1)) if p]
        if len(parts) < 3:
            return None
        vals = []
        for p in parts[:3]:
            try:
                v = float(p.rstrip('%'))
            except ValueError:
                return None
            vals.append(max(0, min(255, round(v * 255 / 100 if p.endswith('%') else v))))
        alpha = 1.0
        if len(parts) >= 4:
            try:
                a = float(parts[3].rstrip('%'))
            except ValueError:
                return None
            alpha = max(0.0, min(1.0, a / 100 if parts[3].endswith('%') else a))
        return (vals[0], vals[1], vals[2], alpha)
    m = _HSL_RE.match(s)
    if m:
        parts = [p for p in re.split(r'[\s,/]+', m.group(1)) if p]
        if len(parts) < 3:
            return None
        try:
            h = (float(parts[0]) % 360) / 360.0
            sat = float(parts[1].rstrip('%')) / 100.0
            light = float(parts[2].rstrip('%')) / 100.0
        except ValueError:
            return None
        if sat == 0:
            r = g = b = light
        else:
            q = light * (1 + sat) if light < 0.5 else light + sat - light * sat
            p = 2 * light - q
            r = _hue_to_rgb(p, q, h + 1 / 3)
            g = _hue_to_rgb(p, q, h)
            b = _hue_to_rgb(p, q, h - 1 / 3)
        alpha = 1.0
        if len(parts) >= 4:
            try:
                alpha = max(0.0, min(1.0, float(parts[3].rstrip('%')) / (100 if parts[3].endswith('%') else 1)))
            except ValueError:
                return None
        return (max(0, min(255, round(r * 255))), max(0, min(255, round(g * 255))),
                max(0, min(255, round(b * 255))), alpha)
    return None


def composite(over, under):
    """Source-over. A translucent colour is measured as painted, not as declared."""
    a = over[3]
    if a >= 1:
        return (over[0], over[1], over[2], 1.0)
    return (over[0] * a + under[0] * (1 - a),
            over[1] * a + under[1] * (1 - a),
            over[2] * a + under[2] * (1 - a),
            1.0)


def to_hex(rgb):
    return '#%02x%02x%02x' % tuple(max(0, min(255, int(round(c)))) for c in rgb[:3])


# --------------------------------------------------------------------------------------
# A small independent HTML tree and CSS cascade.
# --------------------------------------------------------------------------------------

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param',
        'source', 'track', 'wbr'}
NON_RENDERED = {'head', 'title', 'meta', 'link', 'script', 'style', 'noscript', 'template', 'base'}
# Tags that implicitly close an open tag of the listed kinds when they start.
IMPLICIT = {'p': {'p'}, 'li': {'li'}, 'dt': {'dt', 'dd'}, 'dd': {'dt', 'dd'},
            'tr': {'td', 'th', 'tr'}, 'td': {'td', 'th'}, 'th': {'td', 'th'},
            'option': {'option'}, 'thead': {'td', 'th', 'tr'}, 'tbody': {'td', 'th', 'tr'},
            'tfoot': {'td', 'th', 'tr'}}
BLOCK_CLOSES_P = {'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figure',
                  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main',
                  'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul'}


class Node:
    __slots__ = ('tag', 'attrs', 'children', 'parent', 'text')

    def __init__(self, tag, attrs=None, parent=None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children = []
        self.parent = parent
        self.text = []          # direct text only, the text this element paints itself


class TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node('#root')
        self.cur = self.root
        self.raw = None

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        closes = IMPLICIT.get(tag, set())
        while self.cur is not self.root and (
                self.cur.tag in closes or (self.cur.tag == 'p' and tag in BLOCK_CLOSES_P)):
            self.cur = self.cur.parent
        node = Node(tag, {k.lower(): (v if v is not None else '') for k, v in attrs}, self.cur)
        self.cur.children.append(node)
        if tag in ('script', 'style'):
            self.raw = node
        if tag not in VOID:
            self.cur = node

    def handle_startendtag(self, tag, attrs):
        tag = tag.lower()
        node = Node(tag, {k.lower(): (v if v is not None else '') for k, v in attrs}, self.cur)
        self.cur.children.append(node)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if self.raw is not None and tag in ('script', 'style'):
            self.raw = None
        node = self.cur
        while node is not self.root and node.tag != tag:
            node = node.parent
        if node is not self.root and node.tag == tag:
            self.cur = node.parent

    def handle_data(self, data):
        self.cur.text.append(data)


def build_tree(html):
    b = TreeBuilder()
    b.feed(html)
    b.close()
    return b.root


def walk(node):
    yield node
    for child in node.children:
        yield from walk(child)


def raw_text_of(node):
    return ''.join(node.text)


# --- CSS ------------------------------------------------------------------------------

def strip_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)


def parse_declarations(body):
    out = {}
    important = set()
    for chunk in body.split(';'):
        if ':' not in chunk:
            continue
        prop, _, value = chunk.partition(':')
        prop = prop.strip().lower()
        value = value.strip()
        if not prop or not value:
            continue
        if re.search(r'!important\s*$', value, re.I):
            important.add(prop)
            value = re.sub(r'\s*!important\s*$', '', value, flags=re.I)
        out[prop] = value
    return out, important


def parse_stylesheet(css):
    """Top level rules only. An at-rule's contents are skipped and reported, never guessed at."""
    rules = []
    skipped = []
    src = strip_comments(css)
    i = 0
    order = 0
    while i < len(src):
        brace = src.find('{', i)
        if brace == -1:
            break
        prelude = src[i:brace].strip()
        depth = 1
        j = brace + 1
        while j < len(src) and depth:
            if src[j] == '{':
                depth += 1
            elif src[j] == '}':
                depth -= 1
            j += 1
        body = src[brace + 1:j - 1]
        if prelude.startswith('@'):
            skipped.append(prelude.split('{')[0].strip())
        elif prelude:
            decls, important = parse_declarations(body)
            for sel in prelude.split(','):
                sel = sel.strip()
                if not sel:
                    continue
                rules.append({'selector': sel, 'decls': decls, 'important': important,
                              'spec': specificity(sel), 'order': order})
                order += 1
        i = j
    return rules, skipped


def specificity(sel):
    ids = len(re.findall(r'#[\w-]+', sel))
    classes = len(re.findall(r'\.[\w-]+', sel)) + len(re.findall(r'\[[^\]]+\]', sel))
    types = len(re.findall(r'\b[a-zA-Z][\w-]*\b', re.sub(r'[#.][\w-]+', ' ', sel)))
    return (ids, classes, types)


_SIMPLE_RE = re.compile(r'^([a-zA-Z][\w-]*)?((?:[#.][\w-]+)*)$')


def matches_simple(node, simple):
    if simple == '*':
        return True
    m = _SIMPLE_RE.match(simple)
    if not m:
        return False
    if m.group(1) and node.tag != m.group(1).lower():
        return False
    classes = (node.attrs.get('class') or '').split()
    for part in re.findall(r'[#.][\w-]+', m.group(2) or ''):
        if part[0] == '#':
            if node.attrs.get('id') != part[1:]:
                return False
        elif part[1:] not in classes:
            return False
    return True


def selector_matches(node, selector):
    # A pseudo-class describes a state this file cannot observe (:focus, :hover). Rules using
    # one are not applied, which is the conservative direction: a :focus colour is not the
    # colour the reader normally sees.
    if ':' in selector:
        return False
    parts = selector.split()
    idx = len(parts) - 1
    if not matches_simple(node, parts[idx]):
        return False
    idx -= 1
    cursor = node
    child_combinator = False
    while idx >= 0:
        part = parts[idx]
        if part == '>':
            child_combinator = True
            idx -= 1
            continue
        walker = cursor.parent
        found = False
        while walker is not None and walker.tag != '#root':
            if matches_simple(walker, part):
                cursor = walker
                found = True
                break
            if child_combinator:
                return False
            walker = walker.parent
        if not found:
            return False
        child_combinator = False
        idx -= 1
    return True


def resolve_vars(value, variables):
    """Substitute var(--name), which the remediated stylesheet uses for the page and band."""
    for _ in range(4):
        m = re.search(r'var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)', value)
        if not m:
            break
        replacement = variables.get(m.group(1), (m.group(2) or '').strip())
        value = value[:m.start()] + replacement + value[m.end():]
    return value


def declared_styles(node, rules, variables):
    winners = {}
    strength = {}

    def apply(decls, important, spec, order, inline):
        for prop, value in decls.items():
            rank = (1 if prop in important else 0, 1 if inline else 0, spec[0], spec[1], spec[2], order)
            if prop not in strength or rank >= strength[prop]:
                strength[prop] = rank
                winners[prop] = resolve_vars(value, variables)

    for rule in rules:
        if selector_matches(node, rule['selector']):
            apply(rule['decls'], rule['important'], rule['spec'], rule['order'], False)
    if node.attrs.get('style'):
        decls, important = parse_declarations(node.attrs['style'])
        apply(decls, important, (0, 0, 0), 0, True)
    # Presentational attributes, which the corpus documents still use.
    if node.attrs.get('bgcolor') and 'background-color' not in winners:
        winners['background-color'] = node.attrs['bgcolor']
    if node.attrs.get('color') and 'color' not in winners:
        winners['color'] = node.attrs['color']
    if node.attrs.get('align') and 'text-align' not in winners:
        winners['text-align'] = node.attrs['align']
    return winners


UA_SCALE = {'h1': 2.0, 'h2': 1.5, 'h3': 1.17, 'h4': 1.0, 'h5': 0.83, 'h6': 0.67,
            'small': 0.8125, 'big': 1.17}
UA_BOLD = {'b', 'strong', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}
FONT_SIZE_ATTR = {'1': 10.0, '2': 13.0, '3': 16.0, '4': 18.0, '5': 24.0, '6': 32.0, '7': 48.0}
ABSOLUTE = {'xx-small': 9.0, 'x-small': 10.0, 'small': 13.0, 'medium': 16.0, 'large': 18.0,
            'x-large': 24.0, 'xx-large': 32.0}


def length_to_px(value, parent_px, root_px=16.0):
    if value is None:
        return None
    v = str(value).strip().lower()
    if not v:
        return None
    if v in ABSOLUTE:
        return ABSOLUTE[v]
    if v == 'smaller':
        return parent_px * 0.833
    if v == 'larger':
        return parent_px * 1.2
    m = re.fullmatch(r'(-?[\d.]+)(px|pt|em|rem|%)?', v)
    if not m:
        return None
    try:
        n = float(m.group(1))
    except ValueError:
        return None
    unit = m.group(2)
    if unit == 'pt':
        return n * PX_PER_PT
    if unit == 'em':
        return n * parent_px
    if unit == 'rem':
        return n * root_px
    if unit == '%':
        return n * parent_px / 100.0
    return n


def weight_of(value, parent_weight):
    if value is None:
        return None
    v = str(value).strip().lower()
    if v == 'bold':
        return 700
    if v == 'normal':
        return 400
    if v == 'bolder':
        return min(900, parent_weight + 300)
    if v == 'lighter':
        return max(100, parent_weight - 300)
    try:
        return int(float(v))
    except ValueError:
        return None


def background_of(decls):
    if decls.get('background-color'):
        return parse_color(decls['background-color'])
    if decls.get('background'):
        for token in decls['background'].split():
            c = parse_color(token)
            if c:
                return c
        m = re.search(r'(rgba?|hsla?)\([^)]*\)', decls['background'], re.I)
        if m:
            return parse_color(m.group(0))
    return None


def collect_css(root):
    css_parts = []
    for node in walk(root):
        if node.tag == 'style':
            css_parts.append(raw_text_of(node))
    rules, skipped = parse_stylesheet('\n'.join(css_parts))
    variables = {}
    for rule in rules:
        if rule['selector'] in (':root', 'html'):
            for prop, value in rule['decls'].items():
                if prop.startswith('--'):
                    variables[prop] = value
    external = [n.attrs.get('href', '(no href)') for n in walk(root)
                if n.tag == 'link' and 'stylesheet' in (n.attrs.get('rel') or '').lower()]
    return rules, variables, skipped, external


def measure_document(html, page_hex='#ffffff'):
    """Every run of text with the colour it is actually painted in.

    A run is the text an element paints itself. Text inside a nested span belongs to the span,
    which is the element whose colour and size the browser uses.
    """
    root = build_tree(html)
    rules, variables, skipped_at_rules, external = collect_css(root)
    page = parse_color(page_hex)
    runs = []
    unreadable = []

    def visit(node, inherited):
        if node.tag in NON_RENDERED:
            return
        decls = declared_styles(node, rules, variables) if node.tag != '#root' else {}
        parent_px = inherited['px']

        px = parent_px
        if node.tag in UA_SCALE:
            px = 16.0 * UA_SCALE[node.tag]
        if node.tag == 'font' and node.attrs.get('size') in FONT_SIZE_ATTR:
            px = FONT_SIZE_ATTR[node.attrs['size']]
        if decls.get('font-size'):
            got = length_to_px(decls['font-size'], parent_px)
            if got is None:
                unreadable.append('font-size %r on <%s>' % (decls['font-size'], node.tag))
            else:
                px = got

        weight = inherited['weight']
        if node.tag in UA_BOLD:
            weight = 700
        w = weight_of(decls.get('font-weight'), inherited['weight'])
        if w is not None:
            weight = w

        background = inherited['bg']
        own_bg = background_of(decls)
        if own_bg:
            background = composite(own_bg, inherited['bg'])

        color = inherited['color']
        raw_color = decls.get('color')
        if node.tag == 'font' and node.attrs.get('color') and not raw_color:
            raw_color = node.attrs['color']
        if raw_color and raw_color.strip().lower() != 'inherit':
            got = parse_color(raw_color)
            if got is None:
                unreadable.append('color %r on <%s>' % (raw_color, node.tag))
            else:
                color = composite(got, background)

        align = inherited['align']
        if node.tag in ('th', 'caption', 'center'):
            align = 'center'
        if decls.get('text-align'):
            align = decls['text-align'].strip().lower()

        hidden = (inherited['hidden']
                  or decls.get('display', '').strip().lower() == 'none'
                  or decls.get('visibility', '').strip().lower() == 'hidden')

        own = ' '.join(raw_text_of(node).split())
        if own and not hidden and node.tag != '#root':
            runs.append({
                'tag': node.tag,
                'sample': own[:60],
                'fg': to_hex(color),
                'bg': to_hex(background),
                'px': round(px, 2),
                'weight': weight,
                'align': align,
                'ratio': contrast_ratio(color, background),
                'required': required_ratio(px, weight),
            })

        nxt = {'color': color, 'bg': background, 'px': px, 'weight': weight,
               'align': align, 'hidden': hidden}
        for child in node.children:
            visit(child, nxt)

    visit(root, {'color': (0, 0, 0, 1.0), 'bg': page, 'px': 16.0, 'weight': 400,
                 'align': 'start', 'hidden': False})
    return {'runs': runs, 'unreadable': unreadable, 'skippedAtRules': skipped_at_rules,
            'externalStylesheets': external}


# --------------------------------------------------------------------------------------
# Checks
# --------------------------------------------------------------------------------------

class Report:
    def __init__(self):
        self.failures = []
        self.checks = 0

    def check(self, ok, message):
        self.checks += 1
        if not ok:
            self.failures.append(message)
        return ok


def check_self(rep):
    """Three ratios computed by hand, so a bug in THIS file cannot pass judgement on the tool."""
    # 1. Black on white.
    #    L(black) = 0. L(white) = 1 (every channel 255/255 = 1, and 1 linearises to 1).
    #    ratio = (1 + 0.05) / (0 + 0.05) = 1.05 / 0.05 = 21 exactly.
    got = contrast_ratio((0, 0, 0), (255, 255, 255))
    rep.check(abs(got - 21.0) < 1e-12, 'hand check 1: black on white is %r, expected 21' % got)

    # 2. #767676 on white. 0x76 = 118. 118/255 = 0.4627450980, above 0.03928, so
    #    linear = ((0.4627450980 + 0.055) / 1.055) ** 2.4 = 0.1811642442
    #    the three weights sum to 1, so L = 0.1811642442
    #    ratio = (1 + 0.05) / (0.1811642442 + 0.05) = 1.05 / 0.2311642442 = 4.5422247
    lum = ((118 / 255.0 + 0.055) / 1.055) ** 2.4
    rep.check(abs(relative_luminance((118, 118, 118)) - lum) < 1e-12,
              'hand check 2a: luminance of #767676 disagrees with the written out arithmetic')
    got = contrast_ratio((118, 118, 118), (255, 255, 255))
    rep.check(abs(got - 1.05 / (lum + 0.05)) < 1e-12, 'hand check 2b: arithmetic mismatch')
    rep.check(abs(got - 4.5422247) < 1e-6, 'hand check 2c: #767676 on white is %r, expected 4.5422247' % got)

    # 3. #0000ff on white. Red and green are 0. Blue is 255, which linearises to 1.
    #    L = 0.0722 * 1 = 0.0722 exactly, so ratio = 1.05 / 0.1222 = 8.5924713...
    got = contrast_ratio((0, 0, 255), (255, 255, 255))
    rep.check(abs(got - 1.05 / 0.1222) < 1e-12, 'hand check 3a: arithmetic mismatch')
    rep.check(abs(got - 8.5924714) < 1e-6, 'hand check 3b: #0000ff on white is %r, expected 8.5924714' % got)

    # The 0.03928 branch has to be present. Channel 10 is on the linear segment (0.03928*255 =
    # 10.0164) and channel 11 is not. If the branch were dropped the two would both use the
    # gamma curve and channel 10 would come out at 0.0030282 rather than 0.0030353.
    rep.check(abs(channel_to_linear(10) - (10 / 255.0) / 12.92) < 1e-15,
              'the sRGB linear segment is missing: channel 10 should use c/12.92')
    rep.check(abs(channel_to_linear(11) - ((11 / 255.0 + 0.055) / 1.055) ** 2.4) < 1e-15,
              'channel 11 should use the gamma curve')

    # And the large text rule, at both thresholds.
    rep.check(required_ratio(23.99, 400) == 4.5 and required_ratio(24.0, 400) == 3.0,
              'the 18pt threshold is wrong')
    rep.check(required_ratio(18.66, 700) == 4.5 and required_ratio(18.67, 700) == 3.0,
              'the 14pt bold threshold is wrong')
    rep.check(required_ratio(24.0, 400) == 3.0 and required_ratio(20.0, 600) == 4.5,
              'weight below 700 must not get the bold allowance')


def check_reported_ratios(rep, label, report_json):
    """Recompute every ratio the tool printed, from the colour pair the tool printed.

    This catches a wrong luminance formula and a wrong large-text rule. It cannot catch the
    tool reading the wrong colour off the page, which is what check_source and check_output
    below are for.
    """
    runs = report_json.get('textRuns', [])
    rep.check(len(runs) > 0, '%s: the report contains no text runs at all' % label)
    for run in runs:
        fg = parse_color(run['foreground'])
        bg = parse_color(run['background'])
        if not rep.check(fg is not None and bg is not None,
                         '%s: unreadable colour pair %r / %r' % (label, run['foreground'], run['background'])):
            continue
        mine = contrast_ratio(fg, bg)
        rep.check(abs(mine - run['ratio']) < 5e-4,
                  '%s: %r reported ratio %.4f, independently %.4f'
                  % (label, run['sample'][:40], run['ratio'], mine))
        want = required_ratio(run['fontSizePx'], run['fontWeight'])
        rep.check(want == run['required'],
                  '%s: %r at %spx weight %s requires %s, tool said %s'
                  % (label, run['sample'][:40], run['fontSizePx'], run['fontWeight'], want, run['required']))
        rep.check(run['pass'] == (mine >= want),
                  '%s: %r pass=%s but %.4f against a %s requirement says %s'
                  % (label, run['sample'][:40], run['pass'], mine, want, mine >= want))
        rep.check(run['large'] == is_large_text(run['fontSizePx'], run['fontWeight']),
                  '%s: %r large=%s disagrees' % (label, run['sample'][:40], run['large']))


def check_source(rep, label, html, report_json):
    """Measure the source from scratch and hold the tool's headline number to it."""
    mine = measure_document(html)
    rep.check(len(mine['runs']) > 0, '%s: independent measurement found no text' % label)
    my_ratios = sorted(r['ratio'] for r in mine['runs'])
    my_min = my_ratios[0]
    tool_min = report_json['summary']['minContrast']

    # The two implementations linearise the document slightly differently (which element owns a
    # run of whitespace, for one), so the comparison is that the tool's reported minimum is one
    # of the ratios this file independently computed, and that it is not better than the worst
    # thing this file found. A tool quietly reporting a rosier minimum than the document has is
    # exactly the failure being guarded against.
    rep.check(any(abs(tool_min - r) < 5e-4 for r in my_ratios),
              '%s: tool reports minimum contrast %.4f, which is not among the %d ratios found '
              'independently (independent minimum %.4f)' % (label, tool_min, len(my_ratios), my_min))
    rep.check(tool_min <= my_min + 5e-4,
              '%s: tool reports %.4f as its minimum but an independent pass found %.4f, which is worse'
              % (label, tool_min, my_min))

    my_failing = [r for r in mine['runs'] if r['ratio'] < r['required']]
    rep.check(len(my_failing) > 0,
              '%s: this source document is supposed to be a bad one, but an independent pass '
              'found no contrast failures' % label)
    return {'failing': len(my_failing), 'min': my_min, 'runs': len(mine['runs'])}


def check_output(rep, label, html, source_facts):
    """Measure the remediated document from scratch. This is the claim that matters."""
    mine = measure_document(html)
    rep.check(len(mine['runs']) > 0, '%s: the remediated document has no measurable text' % label)
    rep.check(not mine['unreadable'],
              '%s: the remediated document contains colours that cannot be read: %s'
              % (label, '; '.join(mine['unreadable'][:5])))
    rep.check(not mine['externalStylesheets'],
              '%s: the remediated document still depends on an external stylesheet: %s'
              % (label, mine['externalStylesheets']))

    failing = [r for r in mine['runs'] if r['ratio'] < r['required']]
    rep.check(not failing,
              '%s: %d run(s) still fail WCAG after remediation, worst is %r at %.4f:1 needing %s'
              % (label, len(failing),
                 failing[0]['sample'][:40] if failing else '', failing[0]['ratio'] if failing else 0,
                 failing[0]['required'] if failing else 0))

    # The tool's own promise is stricter than WCAG: 4.5:1 for everything, including large text
    # that WCAG would let through at 3:1. Held to its own promise here.
    under_target = [r for r in mine['runs'] if r['ratio'] < WCAG_NORMAL - 5e-4]
    rep.check(not under_target,
              '%s: %d run(s) below the tool\'s stated 4.5:1 target, worst %r at %.4f:1'
              % (label, len(under_target),
                 under_target[0]['sample'][:40] if under_target else '',
                 under_target[0]['ratio'] if under_target else 0))

    # The remediation has to have actually done something. If the source had no failures there
    # was nothing to prove, and this file said so in check_source.
    rep.check(source_facts['failing'] > 0 and not failing,
              '%s: the source had %d failing run(s) and the output has %d, so nothing was proved'
              % (label, source_facts['failing'], len(failing)))

    justified = [r for r in mine['runs'] if r['align'] == 'justify']
    rep.check(not justified, '%s: %d run(s) are still justified' % (label, len(justified)))
    small = [r for r in mine['runs'] if r['px'] < 16]
    rep.check(not small, '%s: %d run(s) are still under 16px, smallest %.2f'
              % (label, len(small), min((r['px'] for r in small), default=0)))
    return {'runs': len(mine['runs']), 'min': min(r['ratio'] for r in mine['runs'])}


def check_alt_text(rep, label, report_json):
    """Alt text has to SAY something, and an empty alt must not be treated as a pass."""
    for finding in report_json.get('details', {}).get('images', []):
        alt = finding.get('alt')
        status = finding['status']
        if alt is None:
            rep.check(status in ('needs-human', 'auto-decorative'),
                      '%s: image %r has no alt attribute but is %r' % (label, finding['src'], status))
        elif alt.strip() == '':
            rep.check(status == 'declared-decorative',
                      '%s: image %r has an empty alt but is %r' % (label, finding['src'], status))
            rep.check(status != 'described',
                      '%s: image %r has an empty alt and was counted as described' % (label, finding['src']))
        else:
            stripped = alt.strip()
            looks_useless = (
                stripped.lower() in {'image', 'photo', 'picture', 'graphic', 'icon', 'logo',
                                     'img', 'untitled', 'banner', 'spacer', 'photograph'}
                or re.search(r'\.(jpe?g|png|gif|webp|svg|bmp|tiff?)\s*$', stripped, re.I)
                or stripped == finding['src'].split('/')[-1]
                or len(stripped) < 3)
            if looks_useless:
                rep.check(status == 'needs-human',
                          '%s: image %r has useless alt %r but was accepted as %r'
                          % (label, finding['src'], alt, status))
            else:
                rep.check(status == 'described',
                          '%s: image %r has real alt text but was reported as %r'
                          % (label, finding['src'], status))


def check_reading_order(rep, label, before_json, after_json):
    b = before_json['summary'].get('readingOrder')
    a = after_json['summary'].get('readingOrder')
    if b is None:
        return
    rep.check(b['inversions'] > 0,
              '%s: the source is supposed to have a reading order defect, but none was reported' % label)
    rep.check(a is not None and a['inversions'] == 0,
              '%s: reading order still has %s inverted pair(s) after remediation'
              % (label, a['inversions'] if a else 'an unmeasured number'))
    rep.check(a is not None and a['missing'] == 0,
              '%s: %s ground truth line(s) went missing from the remediated document'
              % (label, a['missing'] if a else '?'))
    # Kendall tau distance recomputed from the two counts the tool reported.
    for name, m in (('before', b), ('after', a)):
        if m and m['pairs']:
            rep.check(abs(m['tauDistance'] - m['inversions'] / m['pairs']) < 1e-4,
                      '%s: %s tau distance %.4f does not equal %d/%d'
                      % (label, name, m['tauDistance'], m['inversions'], m['pairs']))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--corpus', required=True)
    ap.add_argument('--work', required=True)
    args = ap.parse_args()

    rep = Report()
    check_self(rep)
    if rep.failures:
        print('INDEPENDENT CHECK ABORTED: this checker failed its own hand computations.')
        for f in rep.failures:
            print('  %s' % f)
        return 2

    docs = sorted(f for f in os.listdir(args.corpus) if f.lower().endswith(('.html', '.htm')))
    if len(docs) < 2:
        print('INDEPENDENT CHECK FAILED: found %d corpus documents, expected at least 2' % len(docs))
        return 1

    examined = 0
    for name in docs:
        stem = os.path.splitext(name)[0]
        before_path = os.path.join(args.work, '%s.before.json' % stem)
        after_path = os.path.join(args.work, '%s.after.json' % stem)
        out_path = os.path.join(args.work, '%s.out.html' % stem)
        missing = [p for p in (before_path, after_path, out_path) if not os.path.exists(p)]
        if missing:
            print('INDEPENDENT CHECK FAILED: %s did not produce %s'
                  % (name, ', '.join(os.path.basename(p) for p in missing)))
            return 1

        with open(before_path, encoding='utf-8') as fh:
            before_json = json.load(fh)
        with open(after_path, encoding='utf-8') as fh:
            after_json = json.load(fh)
        with open(os.path.join(args.corpus, name), encoding='utf-8') as fh:
            source_html = fh.read()
        with open(out_path, encoding='utf-8') as fh:
            output_html = fh.read()

        check_reported_ratios(rep, '%s before' % name, before_json)
        check_reported_ratios(rep, '%s after' % name, after_json)
        check_alt_text(rep, '%s before' % name, before_json)

        # The clean control document is here to prove the checker does not cry wolf. It has no
        # failures to fix, so it is measured but exempt from "the source must be bad".
        control = 'accessible-control' in name
        if control:
            mine = measure_document(source_html)
            bad = [r for r in mine['runs'] if r['ratio'] < r['required']]
            rep.check(not bad,
                      '%s: the control document is supposed to already pass, independently found '
                      '%d failing run(s)' % (name, len(bad)))
        else:
            facts = check_source(rep, name, source_html, before_json)
            check_output(rep, '%s remediated' % name, output_html, facts)
            check_reading_order(rep, name, before_json, after_json)
        examined += 1

    if examined < 2:
        print('INDEPENDENT CHECK FAILED: examined only %d document(s)' % examined)
        return 1

    print('independent check: %d assertions over %d documents' % (rep.checks, examined))
    if rep.failures:
        print('INDEPENDENT CHECK FAILED: %d of %d assertions did not hold' % (len(rep.failures), rep.checks))
        for f in rep.failures:
            print('  %s' % f)
        return 1
    print('INDEPENDENT CHECK PASSED: all %d assertions held' % rep.checks)
    return 0


if __name__ == '__main__':
    sys.exit(main())
