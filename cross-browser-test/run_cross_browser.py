#!/usr/bin/env python3
"""
Cross-browser render check for the CPG / Healthier Together Rewards prototype.

Renders the deployed page in three REAL engines:
  - webkit   -> the engine behind Safari (incl. Safari on iPhone/iPad)
  - firefox  -> Gecko (Firefox desktop + Android)
  - chromium -> Chrome / Edge

...at a phone size AND a desktop size, and saves screenshots to ./screens/
so you can compare them side by side and spot layout differences.

------------------------------------------------------------------
SETUP (one time):
    pip install playwright
    python -m playwright install          # downloads the 3 engines (~few hundred MB)
    #   macOS: no extra step needed.
    #   Linux: also run  sudo python -m playwright install-deps

RUN:
    python run_cross_browser.py
    # or point it at any URL (e.g. the commit-pinned mirror that skips Pages cache):
    BASE_URL="https://raw.githack.com/rgrosssunny/CPG-DEMO/main" python run_cross_browser.py
------------------------------------------------------------------
"""
import os, pathlib
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "https://rgrosssunny.github.io/CPG-DEMO").rstrip("/")
FILE = "design_preview_noclip.html"
OUT  = pathlib.Path("screens"); OUT.mkdir(exist_ok=True)

# Which screens to capture: (label, query string)
PAGES = [
    ("app",     ""),               # ABC Health app shell (Overview / Earn / Shop)
    ("rewards", "?view=cashback"), # standalone Healthier Together Rewards site
]

# Viewports. Phone ~ iPhone 13/14; desktop ~ small laptop.
PHONE   = dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True,  has_touch=True)
DESKTOP = dict(viewport={"width": 1366, "height": 900})

# The prototype has a demo login gate that stores a flag in sessionStorage.
# Pre-seed it so the script lands straight on the app instead of the sign-in screen.
SEED_AUTH = "try{sessionStorage.setItem('cpgDemoAuth','1')}catch(e){}"

def capture(browser, engine):
    for vlabel, vargs in (("phone", PHONE), ("desktop", DESKTOP)):
        ctx = browser.new_context(**vargs)
        ctx.add_init_script(SEED_AUTH)
        for plabel, query in PAGES:
            page = ctx.new_page()
            page.goto(f"{BASE}/{FILE}{query}", wait_until="load", timeout=45000)
            page.wait_for_timeout(1800)  # let offers render + carousel mount
            shot = OUT / f"{engine}__{vlabel}__{plabel}.png"
            page.screenshot(path=str(shot))            # viewport-accurate (what the user sees)
            print("  saved", shot)
            page.close()
        ctx.close()

def main():
    print(f"Base URL: {BASE}\n")
    with sync_playwright() as p:
        for engine in ("webkit", "firefox", "chromium"):
            print(f"== {engine} ==")
            try:
                b = getattr(p, engine).launch()
                capture(b, engine)
                b.close()
            except Exception as e:
                print(f"  FAILED: {str(e)[:240]}")
    print("\nDone. Open the ./screens/ folder and compare webkit (Safari) vs firefox vs chromium.")
    print("Watch especially: the bottom action bar position, sticky header, the featured carousel,")
    print("and offer-card image boxes — those use the few features with engine-specific behavior.")

if __name__ == "__main__":
    main()
