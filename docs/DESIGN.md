# Inklet design notes

## Goals

1. **Free** — no server to pay for, hostable on GitHub Pages or any static host.
2. **Private** — documents are processed entirely in the browser tab.
3. **Easy** — a small, obvious toolset (text, draw, highlight, sign, image,
   erase) rather than a full DTP suite.
4. **Mobile compatible** — every interaction works with one finger; the layout
   reflows for small screens.

## Architecture

```
index.html            static shell (toolbar, sidebar, viewer, modals)
css/styles.css        responsive styles; <760px switches to the mobile layout
js/app.js             all application logic (~1k lines, no build step)
vendor/pdf.min.js     pdf.js 3.11 — page rendering (vendored, works offline)
vendor/pdf.worker.min.js
vendor/pdf-lib.min.js pdf-lib 1.17 — document assembly & export
```

Two canvases per page:

- **pdf layer** — pdf.js renders the original page content, lazily via an
  `IntersectionObserver` (only pages near the viewport are rasterized), with a
  backing-store cap so huge zoom levels can't exceed canvas limits.
- **overlay layer** — the user's annotations, redrawn from the model on every
  change. When the pan tool is active the overlay gets `pointer-events: none`
  so native scrolling works; for every other tool it gets `touch-action: none`
  so a finger draws instead of scrolling.

### Data model

```js
state.sources = [{ bytes, doc }]        // original PDFs (merge keeps several)
state.pages   = [{
  src, srcIndex,                        // which source page (src -1 = blank)
  intrinsicRot, userRot,                // /Rotate from the file + user rotation
  baseW, baseH,                         // displayed size in PDF points
  annots: [
    { type: 'ink',   points, color, width, opacity },
    { type: 'text',  x, y, text, size, color },
    { type: 'image', dataUrl, x, y, w, h },
    { type: 'rect',  x, y, w, h, color },   // whiteout / cover patch
  ],
}]
```

Annotation coordinates are stored in **display space**: PDF points in the
page's current displayed orientation (a scale-1 pdf.js viewport), y-down.
This makes input handling trivial (screen px ÷ scale) and keeps annotations
resolution-independent.

### Export pipeline (`exportPdf`)

pdf.js only reads; pdf-lib writes. On save we:

1. Create a fresh `PDFDocument` and `copyPages` from each source in the
   user's page order (blank pages become real blank pages).
2. Apply rotation: `setRotation(intrinsic + userRot)`.
3. Map every annotation from display space back to unrotated PDF user space.
   For total rotation `R` and crop box `W×H`:

   | R | px | py |
   |---|----|----|
   | 0   | dx     | H − dy |
   | 90  | dy     | dx     |
   | 180 | W − dx | dy     |
   | 270 | W − dy | H − dx |

   (plus the crop-box origin offset).
4. Draw ink as a single stroked path per stroke (`drawSvgPath`, round caps —
   one path so translucent highlighter ink doesn't double up at segment
   joints), text via embedded Helvetica with a `rotate: degrees(R)`
   counter-rotation so it reads upright, and images via `embedPng/embedJpg`
   anchored at their display bottom-left corner.

The result is a real, vector PDF — text stays selectable, ink stays sharp.

### Rotating a page with annotations

Ink points are mapped through the 90° transform so drawings turn with the
page content. Text and images keep their upright orientation but follow
their center point — the practical behavior for stamps and form-filling text.

### Undo

A single global stack of `{kind: add|del|mod, page, annot, before}` entries,
capped at 100. `mod` stores a deep copy taken before a drag/resize/edit.

## Mobile strategy

- Pointer Events everywhere — one code path for mouse, touch, and stylus.
- Toolbar docks to the bottom (thumb reach) below 760px; the page sidebar
  becomes a slide-in drawer; labels collapse to icons.
- Pinch-to-zoom tracks two touch pointers on the viewer with live CSS-scale
  feedback during the gesture and a single crisp re-render on release,
  anchored so the content between your fingers stays put
  (`touch-action: pan-x pan-y` keeps the browser from eating the gesture).
  A second finger during a stroke cancels the stroke and becomes pan/zoom,
  so you can navigate while a drawing tool is active. Desktop gets
  ctrl+wheel / trackpad-pinch zoom around the cursor.
- `env(safe-area-inset-*)` padding for notched phones.
- Tap-to-type text uses a real `<textarea>` so the on-screen keyboard,
  autocorrect, and IME all behave natively.

## Verified behavior

An automated Playwright smoke test (headless Chromium) exercises: open a
generated 2-page PDF (one page intrinsically rotated 90°), pen, highlighter,
multi-line text, select + drag + undo, page rotation via thumbnails, drawing
on the rotated page, signature capture/placement, blank page, zoom, export,
and re-opening the exported file (page count and /Rotate verified, pages
rasterized and visually checked).

Whiteout rectangles are drawn last-wins in annotation order, so text typed
after a cover patch renders above it — in the editor and in the export.
Note they cover content visually; they do not remove it from the file
(true redaction would require content-stream rewriting).

## Roadmap ideas

- True redaction (strip covered text from the content stream)
- Shape tools (arrow, box, ellipse)
- Reuse the last signature (localStorage)
- Form-field filling (AcroForm) via pdf-lib's form API
- Unicode text via a subsetted embedded font (e.g. Noto Sans + fontkit)
- Extract/export single pages; drag-to-reorder thumbnails
- PWA manifest + service worker for installable offline use
