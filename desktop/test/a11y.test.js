// Accessibility checks on the PC window that need no browser: colour contrast worked out
// from the stylesheet's own colours, and the markup rules a screen reader and a keyboard
// depend on. Run with: npm test
//
// What needs a real window (focus order, the focus ring, zoom, the calm arrival) is checked
// by hand and by test/overlay-sizes.js; docs/accessibility.md lists it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
const css = src('index.css');
const html = src('index.html');
const js = src('index.js');

// ---------- contrast, as WCAG 2 defines it ----------
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** `top` at `alpha` over `under`: what a see-through patch really looks like. */
function over(top, alpha, under) {
  const ch = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round(ch(top, i) * alpha + ch(under, i) * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
}

const tokens = Object.fromEntries([...css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2].toLowerCase()]));
const WHITE = '#ffffff';

test('the contrast sums are right', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(contrast('#777777', '#ffffff').toFixed(2), '4.48'); // the well-known near miss
  assert.equal(over('#000000', 0.5, '#ffffff'), '#808080');
});

test('every colour the checks below rely on is defined', () => {
  for (const name of ['bg', 'panel', 'panel-2', 'line', 'text', 'muted', 'accent', 'accent-2', 'ok', 'warn', 'bad', 'edge', 'on-accent', 'focus']) {
    assert.match(tokens[name] || '', /^#[0-9a-f]{6}$/, `--${name}`);
  }
});

test('text reaches 4.5:1 on every surface it is drawn on', () => {
  const pairs = [
    ['text', 'bg'], ['text', 'panel'], ['text', 'panel-2'],
    ['muted', 'bg'], ['muted', 'panel'], ['muted', 'panel-2'], // small print, hints, headings
    ['on-accent', 'accent'], ['on-accent', 'accent-2'], // the filled buttons, which are a gradient in places
    ['bg', 'ok'], ['bg', 'warn'], ['bg', 'bad'], // the check marks, the badge and the summary line use the page colour as ink
  ];
  for (const [ink, paper] of pairs) {
    const ratio = contrast(tokens[ink], tokens[paper]);
    assert.ok(ratio >= 4.5, `--${ink} on --${paper} is ${ratio.toFixed(2)}:1`);
  }
});

test('light text on the accent colour would fail, which is why buttons use dark text', () => {
  assert.ok(contrast(tokens.text, tokens.accent) < 4.5);
  assert.match(css, /button\s*\{[^}]*color:\s*var\(--on-accent\)/);
});

test('outlines of fields and switches, the focus ring and status marks reach 3:1', () => {
  const pairs = [
    ['edge', 'bg'], ['edge', 'panel'], ['edge', 'panel-2'],
    ['focus', 'bg'], ['focus', 'panel'], ['focus', 'panel-2'], // the ring stands off, so these are what it is seen against
    ['accent', 'line'], // a progress bar on its track
    ['ok', 'panel'], ['warn', 'panel'], ['bad', 'panel'], ['ok', 'bg'], ['warn', 'bg'], // status dots and borders
  ];
  for (const [mark, behind] of pairs) {
    const ratio = contrast(tokens[mark], tokens[behind]);
    assert.ok(ratio >= 3, `--${mark} against --${behind} is ${ratio.toFixed(2)}:1`);
  }
  assert.ok(contrast(WHITE, tokens.accent) >= 3, 'the knob of a switch that is on');
  assert.ok(contrast(WHITE, tokens.line) >= 3, 'the knob of a switch that is off');
});

test('the name of an effect reads on the brightest part of any effect picture', () => {
  // The label sits on its own dark patch. Take the lightest colour used in the pictures behind it.
  const patch = /\.effect span\s*\{[^}]*background:\s*rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([.\d]+)\s*\)/.exec(css);
  assert.ok(patch, 'the label has a patch behind it');
  const dark = `#${[1, 2, 3].map((i) => Number(patch[i]).toString(16).padStart(2, '0')).join('')}`;
  const pictures = [...css.matchAll(/\.effect\[data-effect="[a-z]+"\]\s*\{([^}]*)\}/g)].map((m) => m[1]).join(' ');
  const colours = [...pictures.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase());
  assert.ok(colours.length >= 8, 'found the pictures');
  for (const c of colours) {
    const ratio = contrast(WHITE, over(dark, Number(patch[4]), c));
    assert.ok(ratio >= 4.5, `white on the patch over ${c} is ${ratio.toFixed(2)}:1`);
  }
});

// ---------- what a keyboard needs ----------
test('everything the keyboard can reach shows a focus ring, and nothing removes it', () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\); outline-offset: 2px/);
  assert.doesNotMatch(css, /:focus-visible[^{]*\{[^}]*outline-offset:\s*-/, 'a ring drawn inside a picture can disappear into it');
  assert.doesNotMatch(css, /outline:\s*(none|0)\b/);
  assert.match(css, /\.toggle input:focus-visible \+ \.switch\s*\{[^}]*outline:/, 'the hidden checkbox passes its ring to the switch that is seen');
});

test('nothing takes focus out of its natural order', () => {
  for (const m of html.matchAll(/tabindex="(-?\d+)"/g)) assert.ok(Number(m[1]) <= 0, `tabindex ${m[1]}`);
});

test('the QR code, the one thing drawn on a canvas, works from the keyboard', () => {
  const qr = /<canvas id="qr"[^>]*>/.exec(html)[0];
  assert.match(qr, /role="button"/);
  assert.match(qr, /tabindex="0"/);
  assert.match(qr, /aria-label="[^"]{10,}"/);
  assert.match(js, /\$\('qr'\)\.onkeydown[\s\S]{0,200}Escape[\s\S]{0,200}Enter/);
});

test('buttons stay at least 24 points tall', () => {
  const m = /\nbutton\s*\{[^}]*min-height:\s*(\d+)px/.exec(css);
  assert.ok(m && Number(m[1]) >= 24, 'min-height on button');
});

// ---------- what a screen reader needs ----------
test('the page says what language it is in', () => {
  assert.match(html, /<html lang="en">/);
});

test('every button in the page has words', () => {
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const words = m[2].replace(/<span[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '').trim();
    // Two buttons get their words when the page is drawn.
    const filledLater = /id="(update-go)"/.test(m[1]);
    assert.ok(words || /aria-label="/.test(m[1]) || filledLater, `button${m[1]}`);
  }
});

test('every field has a label', () => {
  const labelled = (tag, attrs, at) => {
    if (/aria-label="/.test(attrs)) return true;
    const id = /id="([^"]+)"/.exec(attrs)?.[1];
    if (id && new RegExp(`<label[^>]*for="${id}"`).test(html)) return true;
    // inside a <label> element: the nearest label tag before it is an opening one
    const before = html.slice(0, at);
    return before.lastIndexOf('<label') > before.lastIndexOf('</label>');
  };
  for (const m of html.matchAll(/<(input|select)\b([^>]*)>/g)) assert.ok(labelled(m[1], m[2], m.index), `<${m[1]}${m[2]}> has no label`);
});

test('every on/off control is announced as a switch', () => {
  const boxes = [...html.matchAll(/<input type="checkbox"([^>]*)>/g)];
  assert.ok(boxes.length >= 6);
  for (const m of boxes) assert.match(m[1], /role="switch"/, m[0]);
});

test('pictures that say nothing are hidden from a screen reader', () => {
  for (const m of html.matchAll(/<span class="(logo|logo big|dot|tab-icon|lock-icon)"([^>]*)>/g)) assert.match(m[2], /aria-hidden="true"/, m[0]);
  assert.match(js, /el\('img', \{ src: h\.url, alt: ''/, 'a thumbnail has empty alt text: its name is beside it');
});

test('progress is not read out at every step', () => {
  // The list of cards changes many times a second, so it must not be a live region itself.
  assert.doesNotMatch(/<div id="transfers"[^>]*>/.exec(html)[0], /aria-live|role="status"|role="alert"/);
  assert.match(html, /<div class="sr-only" id="announcer" role="status" aria-live="polite">/);
  assert.match(html, /<div class="sr-only" id="alerts" role="alert">/);
  // Spoken only when a card changes state, not when its number moves.
  assert.match(js, /if \(card\.state !== row\.state\) \{[\s\S]{0,400}say\(/);
  assert.match(js, /role: 'progressbar'/);
});

test('a status mark is a shape and a word, not a colour alone', () => {
  assert.match(js, /MARK = \{ ok: '✓', warn: '!', fail: '✕', manual: '☐' \}/);
  assert.match(js, /MARK_WORDS = \{ ok: '[^']+', warn: '[^']+', fail: '[^']+', manual: '[^']+' \}/);
  assert.match(js, /role: 'img', ariaLabel: MARK_WORDS\[i\.status\]/);
});

test('a card about something that went wrong stays until it is dismissed', () => {
  assert.match(js, /row\.cancel\.textContent = 'Dismiss'/);
  assert.doesNotMatch(js, /noticeTimer/, 'the "no phone paired" notice has no clock either');
});

// ---------- movement, zoom and high contrast ----------
test('reduced movement stops every animation and transition in the window', () => {
  assert.match(css, /body\.calm \*, body\.calm \*::before, body\.calm \*::after\s*\{\s*animation: none !important; transition: none !important;/);
  assert.match(js, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  assert.match(js, /classList\.toggle\('calm', wantsCalm\(s\)\)/);
  for (const value of ['system', 'reduce', 'full']) assert.match(html, new RegExp(`<option value="${value}">`));
});

test('the arrival screen has a calm version and takes the setting with every message', () => {
  const overlay = src('overlay.js');
  assert.match(overlay, /if \(f\.calm\) \{[\s\S]{0,300}scale: 1, rot: 0/);
  assert.match(overlay, /if \(item\.motion\) motion = item\.motion/);
  assert.match(overlay, /if \(card\.motion\) motion = card\.motion/);
  assert.match(src('main.js'), /send\('arrive', \{ \.\.\.item, sound: settings\.sound, motion: settings\.motion \}\)/);
});

test('a narrow or zoomed window becomes one column instead of cutting text off', () => {
  assert.match(css, /@media \(max-width: 720px\)\s*\{[\s\S]*\.shell \{ flex-direction: column; \}/);
});

test('high-contrast themes get real colours for the parts drawn with a background alone', () => {
  assert.match(css, /@media \(forced-colors: active\)\s*\{[\s\S]*\.switch \{[^}]*ButtonText/);
});
