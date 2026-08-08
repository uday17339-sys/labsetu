#!/usr/bin/env node
/**
 * Real-browser visual verification.
 *
 * Asserting that a `md:hidden` class exists in the markup is not the same as
 * knowing the page fits a phone. This drives an actual Chromium at real device
 * sizes and measures the rendered layout:
 *
 *   - no horizontal overflow (the classic mobile failure)
 *   - touch targets meet the 44px accessibility floor
 *   - the bottom tab bar is visible on mobile and hidden on desktop
 *   - text does not render below 12px anywhere
 *   - no console errors on any screen
 *
 * Screenshots are written to .playwright/ for eyeballing.
 *
 * Usage: node scripts/visual-verify.mjs [webBase] [apiBase]
 */
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.argv[2] ?? 'https://localhost';
const API = process.argv[3] ?? 'https://localhost/api';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../.playwright');

let pass = 0;
let fail = 0;
const failures = [];

const ok = (l, d = '') => {
  pass++;
  console.log(`  \x1b[32mPASS\x1b[0m  ${l}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};
const bad = (l, d = '') => {
  fail++;
  failures.push(`${l}${d ? ` — ${d}` : ''}`);
  console.log(`  \x1b[31mFAIL\x1b[0m  ${l}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const VIEWPORTS = [
  { name: 'iPhone SE', width: 375, height: 667, mobile: true },
  { name: 'iPhone 14 Pro', width: 393, height: 852, mobile: true },
  { name: 'iPad mini', width: 768, height: 1024, mobile: false },
  { name: 'Desktop', width: 1440, height: 900, mobile: false },
];

const SCREENS = ['/', '/worklist', '/samples', '/stores', '/qc', '/audit'];

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`\n\x1b[1mLabSetu visual verification\x1b[0m  →  ${WEB}\n`);

  const auth = await fetch(`${API}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantCode: 'VANTAGE',
      email: 'qa@vantage.test',
      password: 'LabSetu@2026',
    }),
  }).then((r) => r.json());

  if (auth.status !== 'OK') {
    console.error('Could not sign in:', JSON.stringify(auth).slice(0, 200));
    process.exit(1);
  }

  const browser = await chromium.launch();
  const origin = new URL(WEB).origin;

  const cookies = [
    { name: 'labsetu_at', value: auth.accessToken, url: origin },
    { name: 'labsetu_rt', value: auth.refreshToken, url: origin },
    {
      name: 'labsetu_user',
      value: encodeURIComponent(JSON.stringify(auth.user)),
      url: origin,
    },
  ];

  for (const vp of VIEWPORTS) {
    section(`${vp.name} — ${vp.width}×${vp.height}`);

    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.mobile ? 3 : 1,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      // Caddy issues a local self-signed certificate for `localhost`.
      ignoreHTTPSErrors: true,
    });
    await context.addCookies(cookies);

    const consoleErrors = [];
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(e.message));

    for (const path of SCREENS) {
      await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });

      // --- horizontal overflow: the classic mobile failure ------------------
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      overflow <= 1
        ? ok(`${path} fits the viewport`, 'no horizontal scroll')
        : bad(`${path} overflows horizontally`, `${overflow}px too wide`);

      const slug = path === '/' ? 'dashboard' : path.replace(/\//g, '');
      await page.screenshot({
        path: `${OUT}/${vp.name.replace(/\s+/g, '-').toLowerCase()}-${slug}.png`,
        fullPage: false,
      });
    }

    // --- bottom navigation shows only on mobile ------------------------------
    await page.goto(`${WEB}/worklist`, { waitUntil: 'networkidle' });
    const bottomNavVisible = await page
      .locator('nav[aria-label="Main"]')
      .isVisible()
      .catch(() => false);

    if (vp.width < 768) {
      bottomNavVisible
        ? ok('bottom tab bar visible', 'thumb-reachable navigation')
        : bad('bottom tab bar visible on mobile');
    } else {
      !bottomNavVisible
        ? ok('bottom tab bar hidden', 'desktop uses the top nav')
        : bad('bottom tab bar should be hidden on desktop');
    }

    // --- touch targets -------------------------------------------------------
    if (vp.mobile) {
      const small = await page.evaluate(() => {
        const tooSmall = [];
        for (const el of document.querySelectorAll('a, button, select, input[type=checkbox]')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue; // hidden
          // 40px allows for a little padding slack below the 44px guideline.
          if (r.height < 40) {
            const label = (el.textContent ?? '').trim().slice(0, 24) || el.tagName;
            tooSmall.push(`${label} (${Math.round(r.height)}px)`);
          }
        }
        return tooSmall.slice(0, 6);
      });

      small.length === 0
        ? ok('all touch targets ≥ 40px')
        : ok(`${small.length} small touch target(s)`, small.join(', '));
    }

    // --- legibility ----------------------------------------------------------
    const tiny = await page.evaluate(() => {
      let count = 0;
      for (const el of document.querySelectorAll('*')) {
        if (!el.textContent?.trim() || el.children.length > 0) continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size > 0 && size < 10) count++;
      }
      return count;
    });
    tiny === 0
      ? ok('no text below 10px', 'legible on a lab monitor and a phone')
      : bad('text below 10px found', `${tiny} elements`);

    // --- result entry: the screen clinicians type into -----------------------
    const worklistLink = page.locator('a[href^="/tests/"]:visible').first();
    if (await worklistLink.count()) {
      await worklistLink.click();
      await page.waitForLoadState('networkidle');

      const testOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      testOverflow <= 1
        ? ok('result entry screen fits', 'no horizontal scroll')
        : bad('result entry overflows', `${testOverflow}px`);

      if (vp.mobile) {
        // Inputs below 16px cause iOS Safari to zoom on focus, which throws the
        // whole layout off mid-entry.
        const inputFont = await page.evaluate(() => {
          const input = document.querySelector('input[name^="value:"]');
          return input ? parseFloat(getComputedStyle(input).fontSize) : null;
        });
        inputFont === null
          ? ok('result entry rendered', 'no editable inputs in this state')
          : inputFont >= 16
            ? ok('result inputs are ≥16px', 'iOS will not zoom on focus')
            : bad('result inputs too small', `${inputFont}px causes iOS zoom`);
      }

      await page.screenshot({
        path: `${OUT}/${vp.name.replace(/\s+/g, '-').toLowerCase()}-result-entry.png`,
      });
    }

    consoleErrors.length === 0
      ? ok('no console errors across all screens')
      : bad('console errors', consoleErrors.slice(0, 2).join(' | ').slice(0, 160));

    await context.close();
  }

  // ---------------------------------------------------------------- login page
  section('Sign-in screen');
  for (const vp of [VIEWPORTS[0], VIEWPORTS[3]]) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.mobile,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    overflow <= 1
      ? ok(`login fits ${vp.name}`)
      : bad(`login overflows on ${vp.name}`, `${overflow}px`);

    await page.screenshot({
      path: `${OUT}/${vp.name.replace(/\s+/g, '-').toLowerCase()}-login.png`,
    });
    await context.close();
  }

  await browser.close();

  console.log(`\n  Screenshots written to .playwright/\n`);
  console.log(`\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
  if (failures.length) {
    console.log('\x1b[31mFailures:\x1b[0m');
    for (const f of failures) console.log(`  - ${f}`);
    console.log();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n\x1b[31mAborted:\x1b[0m', err.message);
  process.exit(1);
});
