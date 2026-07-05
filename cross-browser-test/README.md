# Cross-browser check — Healthier Together Rewards prototype

A one-command way to render the prototype in the **real Safari (WebKit), Firefox (Gecko),
and Chrome (Chromium)** engines at phone and desktop sizes, so you can confirm the layout
holds up before sharing it.

## Run it

```bash
cd cross-browser-test
pip install playwright
python -m playwright install          # macOS: done. Linux: also `sudo python -m playwright install-deps`
python run_cross_browser.py
```

Screenshots land in `cross-browser-test/screens/`, named `engine__viewport__page.png`
(e.g. `webkit__phone__rewards.png`). Compare the `webkit`, `firefox`, and `chromium`
versions of the same screen side by side.

By default it points at the GitHub Pages URL. Because Pages can lag behind a push,
you can test the exact current code via the commit mirror instead:

```bash
BASE_URL="https://raw.githack.com/rgrosssunny/CPG-DEMO/main" python run_cross_browser.py
```

## What to look at (the only features with engine-specific behavior)

This prototype intentionally avoids the usual cross-browser troublemakers
(`:has()`, `backdrop-filter`, `clamp()`, container queries, CSS nesting). The few
things worth eyeballing:

1. **Bottom action bar (`Snap a receipt` / `Check a product`)** — sized with `100dvh`
   and `env(safe-area-inset-bottom)`. On **iOS Safari** the toolbar grows/shrinks as you
   scroll, which can shift bottom-pinned UI. This is the #1 thing to verify on a real iPhone.
2. **Sticky header + tabs** (`position: sticky`) — Safari has historically been picky about
   sticky inside a scroll container. Confirm the header stays put while content scrolls.
3. **Featured-rewards carousel** — pure `transform: translateX` + JS, no `scroll-snap`,
   so it should be identical everywhere; just confirm the arrows/dots work and it auto-advances.
4. **Offer image boxes** (`aspect-ratio: 4/5`) and **clamped names** (`-webkit-line-clamp`) —
   fully supported in current Safari/Firefox/Chrome; only a concern on quite old versions.
5. **Camera capture** (`getUserMedia`) — *behaves differently by design*, not a layout bug:
   requires HTTPS; iOS only allows it in real Safari (not in-app webviews like the
   Instagram/Facebook browser); desktop Firefox/Chrome prompt normally.

## Highest-fidelity option (real devices)

WebKit-via-Playwright is the same rendering engine as Safari, but it does **not** reproduce
real-iPhone behaviors like the moving Safari toolbar, the home-bar inset, or camera
permission flows. For that, run the same two URLs (`...design_preview_noclip.html` and
`...?view=cashback`) on a real-device cloud such as **BrowserStack** or **LambdaTest**:
iPhone Safari (current + one older iOS), Android Chrome, Firefox desktop, Safari desktop.
Demo login: `DemoCPG` / `deMo2026CpG!`.
