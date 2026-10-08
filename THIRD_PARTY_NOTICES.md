# Third-Party Notices

This plugin includes third-party assets. Their licenses and attributions are below.

---

## Clawd pixel-art crab animations

The animated pixel-art crab ("Clawd") shown as the plugin's pet, and its SVG
animations embedded in `ui.html`, are adapted from the **clawd-tank** project.

- **Source:** https://github.com/marciogranzotto/clawd-tank
- **Author:** Marcio Granzotto Rodrigues
- **License:** MIT
- **Files used (adapted from `assets/svg-animations/`):**
  clawd-idle-living, clawd-sleeping, clawd-wake, clawd-working-sweeping,
  clawd-going-away, clawd-working-typing, clawd-working-building,
  clawd-working-builder, clawd-working-wizard, clawd-crab-walking,
  clawd-eureka, clawd-notification, clawd-dizzy, clawd-working-overheated.
  (viewBox normalized; `clawd-crab-walking` march sped up 2×.)

### MIT License

```
MIT License

Copyright (c) 2026 Marcio Granzotto Rodrigues

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Note on the "Clawd" character / Claude branding

"Clawd" is the mascot associated with **Claude / Anthropic**. The MIT license
above covers the clawd-tank author's code and artwork, but does **not** grant
rights to Anthropic's trademarks or the Claude brand. This plugin is not
affiliated with or endorsed by Anthropic. If distributing publicly, review
Anthropic's brand guidelines and avoid implying any official affiliation.

## Словари проверки орфографии

Вшиты в `ui.html` в сжатом виде скриптом `tools/build-dict.mjs`. Ничего не загружают
и никуда не отправляют: проверка идёт целиком внутри плагина.

- **nspell** — © Titus Wormer, MIT. Движок проверки, собран в `tools/nspell.bundle.js`.
- **dictionary-en** — © Kevin Atkinson и участники SCOWL, MIT AND BSD.
- **dictionary-ru** — © 1997–2008 Alexander I. Lebedev и участники, BSD-3-Clause.
