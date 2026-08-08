#!/usr/bin/env node
/**
 * Extended responsiveness audit — the cases the main visual suite does not cover.
 *
 *   - 320px, the narrowest phone still in real use on Indian networks
 *   - landscape orientation (a phone lying on a bench)
 *   - 200% browser zoom (accessibility, and older eyes under lab lighting)
 *   - the deep screens: report, order confirmation, test detail
 *   - form state: does a validation error break the layout?
 *
 * Usage: node scripts/responsive-audit.mjs [webBase] [apiBase]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.argv[2] ?? 'https://localhost';
const API = process.argv[3] ?? 'https://localhost/api';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../.playwright');

let pass = 0;
let fail = 0;
const failures = [];
const notes = [];

const ok = (l, d = '') => {
  pass++;
  console.log(`  \x1b[32mPASS\x1b[0m  ${l}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};
const bad = (l, d = '') => {
  fail++;
  failures.push(`${l}${d ? ` — ${d}` : ''}`);
  console.log(`  \x1b[31mFAIL\x1b[0m  ${l}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};
const note = (l) => {
  notes.push(l);
  console.log(`  \x1b[33mNOTE\x1b[0m  ${l}`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const overflowOf = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Signs in, backing off if the auth rate limiter says no.
 *
 * The limiter is 10/minute per IP and this suite signs in twice. Run back to
 * back with the other suites, the second login gets throttled, the cookie built
 * from the error body is nonsense, and every page then redirects to /login —
 * which surfaces as "form field not found" thirty seconds later. That is a
 * false alarm with an expensive-looking failure mode.
 */
async function signIn(email, attempt = 0) {
  const res = await fetch(`${API}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantCode: 'VANTAGE', email, password: 'LabSetu@2026' }),
  });
  if (res.status === 429 && attempt < 4) {
    await sleep(21_000);
    return signIn(email, attempt + 1);
  }
  return res.json();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`\n\x1b[1mLabSetu extended responsiveness audit\x1b[0m  →  ${WEB}\n`);

  const auth = await signIn('qa@vantage.test');

  if (auth.status !== 'OK') {
    console.error('Could not sign in:', JSON.stringify(auth).slice(0, 200));
    process.exit(1);
  }

  const origin = new URL(WEB).origin;
  const cookies = [
    { name: 'labsetu_at', value: auth.accessToken, url: origin },
    { name: 'labsetu_rt', value: auth.refreshToken, url: origin },
    { name: 'labsetu_user', value: encodeURIComponent(JSON.stringify(auth.user)), url: origin },
  ];

  const browser = await chromium.launch();

  // Resolve concrete deep-link targets from live data.
  const headers = { authorization: `Bearer ${auth.accessToken}` };
  const worklist = await fetch(`${API}/v1/worklist?limit=20`, { headers }).then((r) => r.json());
  const samples = await fetch(`${API}/v1/samples?limit=20`, { headers }).then((r) => r.json());

  // A test that is still open for entry. Taking items[0] landed on whichever
  // test sorted first, which after a full verification run is usually one that
  // is already authorised — its form is read-only, so the long-text overflow
  // check silently skipped the very layout it exists to protect.
  const EDITABLE = new Set(['PENDING', 'IN_PROGRESS', 'RESULT_ENTERED', 'RERUN_REQUESTED']);
  const editable = (worklist.items ?? []).find((t) => EDITABLE.has(t.status));
  const testId = (editable ?? worklist.items?.[0])?.id;
  const sampleId = samples.items?.[0]?.id;
  const orderId = samples.items?.[0]?.orderId ?? null;

  // The Certificate of Analysis is the heaviest screen in the pharma product —
  // a full specification table with a result and a verdict per row, and the one
  // page that also has to print. If any screen overflows at 320px it is this.
  const coaList = await fetch(`${API}/v1/qa/coa?limit=1`, { headers })
    .then((r) => r.json())
    .catch(() => ({ items: [] }));
  const coaId = coaList.items?.[0]?.id ?? null;

  // A batch under QA review: the densest table an approver reads on a phone.
  const batches = await fetch(`${API}/v1/stores/batches?limit=20`, { headers })
    .then((r) => r.json())
    .catch(() => ({ items: [] }));
  const batchId = (batches.items ?? batches)?.[0]?.id ?? null;

  const DEEP = [
    ['/worklist', 'Worklist'],
    testId ? [`/tests/${testId}`, 'Test detail / result entry'] : null,
    sampleId ? [`/samples/${sampleId}`, 'Sample detail'] : null,
    orderId ? [`/orders/${orderId}`, 'Sampling record'] : null,
    ['/coa', 'Certificate register'],
    coaId ? [`/coa/${coaId}`, 'Certificate of Analysis (heaviest screen)'] : null,
    batchId ? [`/qa/${batchId}`, 'Batch review'] : null,
    ['/qc', 'Quality control'],
    ['/stores', 'Stores'],
    ['/audit', 'Audit trail'],
  ].filter(Boolean);

  // ------------------------------------------------------- 320px, the floor
  section('320px — the narrowest phone still in real use');

  {
    const ctx = await browser.newContext({
      viewport: { width: 320, height: 568 },
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
    });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();

    for (const [path, label] of DEEP) {
      await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
      const o = await overflowOf(page);
      o <= 1
        ? ok(`${label} fits 320px`)
        : bad(`${label} overflows at 320px`, `${o}px too wide`);
    }

    await page.goto(`${WEB}/worklist`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${OUT}/320-worklist.png` });
    await ctx.close();
  }

  // ------------------------------------------------------------- landscape
  section('Landscape — a phone lying on the bench');

  {
    const ctx = await browser.newContext({
      // iPhone SE landscape: 667px is BELOW the md breakpoint, so the bottom
      // tab bar is actually present. The earlier 844px viewport was above it,
      // and the check was measuring a display:none element.
      viewport: { width: 667, height: 375 },
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
    });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();

    for (const [path, label] of DEEP) {
      await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
      const o = await overflowOf(page);
      o <= 1 ? ok(`${label} fits landscape`) : bad(`${label} overflows in landscape`, `${o}px`);
    }

    // In landscape the bottom bar eats scarce vertical space; confirm content
    // is not hidden behind it.
    await page.goto(`${WEB}/worklist`, { waitUntil: 'networkidle' });
    const clearance = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Main"]');
      const main = document.querySelector('main');
      if (!nav || !main) return { applicable: false };
      // A hidden bar obscures nothing — the check only applies when it renders.
      if (getComputedStyle(nav).display === 'none') return { applicable: false };
      const navHeight = nav.getBoundingClientRect().height;
      const padBottom = parseFloat(getComputedStyle(main).paddingBottom);
      return { applicable: true, navHeight, padBottom };
    });

    if (!clearance.applicable) {
      note('bottom bar hidden at this width — clearance check not applicable');
    } else {
      clearance.padBottom >= clearance.navHeight
        ? ok(
            'content clears the bottom bar in landscape',
            `${Math.round(clearance.padBottom)}px padding vs ${Math.round(clearance.navHeight)}px bar`,
          )
        : bad(
            'content sits behind the bottom bar',
            `${Math.round(clearance.padBottom)}px padding vs ${Math.round(clearance.navHeight)}px bar`,
          );
    }

    await page.screenshot({ path: `${OUT}/landscape-worklist.png` });
    await ctx.close();
  }

  // ----------------------------------------------------------------- zoom
  section('200% zoom — accessibility, and lab lighting');

  {
    // Emulating zoom by halving the viewport: 200% zoom on a 1280px screen
    // presents the same 640 CSS pixels to the layout.
    const ctx = await browser.newContext({
      viewport: { width: 640, height: 450 },
      ignoreHTTPSErrors: true,
    });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();

    for (const [path, label] of DEEP) {
      await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
      const o = await overflowOf(page);
      o <= 1 ? ok(`${label} fits at 200% zoom`) : bad(`${label} overflows at 200% zoom`, `${o}px`);
    }
    await ctx.close();
  }

  // ------------------------------------------------------------ form state
  section('Form states');

  {
    const ctx = await browser.newContext({
      viewport: { width: 375, height: 667 },
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
    });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();

    // The consignment form needs stores:manage, which QA does not hold — that
    // separation is deliberate. So this section signs in as the stores officer
    // rather than reusing the QA session the rest of the audit runs under.
    const storesAuth = await signIn('stores@vantage.test');
    if (storesAuth.status !== 'OK') {
      bad('stores sign-in for the form test', JSON.stringify(storesAuth).slice(0, 90));
    }

    await ctx.clearCookies();
    await ctx.addCookies([
      { name: 'labsetu_at', value: storesAuth.accessToken, url: origin },
      { name: 'labsetu_rt', value: storesAuth.refreshToken, url: origin },
      {
        name: 'labsetu_user',
        value: encodeURIComponent(JSON.stringify(storesAuth.user)),
        url: origin,
      },
    ]);

    // Goods receipt submitted with the required fields missing: does the error
    // path break the layout? (Patient registration no longer exists on a pharma
    // deployment, so the equivalent form is the stores consignment receipt.)
    await page.goto(`${WEB}/stores`, { waitUntil: 'networkidle' });
    await page.fill('input[name="batchNumber"]', `RESP-${Date.now()}`);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');

    const o = await overflowOf(page);
    o <= 1
      ? ok('goods receipt error state fits', 'required fields missing')
      : bad('goods receipt error state overflows', `${o}px`);

    const errorShown =
      (await page.locator('[role="alert"]').count()) > 0 ||
      (await page.locator('input:invalid').count()) > 0;
    errorShown
      ? ok('validation is surfaced to the user')
      : note('no visible validation on an incomplete receipt — check UX manually');

    await page.screenshot({ path: `${OUT}/375-stores-error.png` });

    // The result form belongs to the analyst, not to QA. QA holds result:verify
    // and result:authorize but NOT result:write, so for them the form renders
    // read-only and the interpretation field does not exist — which made this
    // check quietly skip itself every run. Signing in as the person who
    // actually types into the form is the only way to test the form.
    const analystAuth = await signIn('qc@vantage.test');
    if (analystAuth.status !== 'OK') {
      bad('analyst sign-in for the result form test', JSON.stringify(analystAuth).slice(0, 90));
    }
    await ctx.clearCookies();
    await ctx.addCookies([
      { name: 'labsetu_at', value: analystAuth.accessToken, url: origin },
      { name: 'labsetu_rt', value: analystAuth.refreshToken, url: origin },
      {
        name: 'labsetu_user',
        value: encodeURIComponent(JSON.stringify(analystAuth.user)),
        url: origin,
      },
    ]);

    // Long content: an interpretation field with a lot of text must not blow out.
    if (testId) {
      await page.goto(`${WEB}/tests/${testId}`, { waitUntil: 'networkidle' });
      const ta = page.locator('textarea[name="interpretation"]');
      if (await ta.count()) {
        await ta.fill(
          'Chromatogram reviewed against system suitability: theoretical plates 4820, tailing 1.12, %RSD of five replicate standard injections 0.38. Peak purity index 0.9998 against the reference standard. Result reported on the dried basis using the water content determined by Karl Fischer on the same composite. '.repeat(
            3,
          ),
        );
        const o2 = await overflowOf(page);
        o2 <= 1
          ? ok('long interpretation text does not break the layout')
          : bad('long text overflows', `${o2}px`);
      } else {
        note('interpretation field not editable in this test state');
      }
    }

    await ctx.close();
  }

  // --------------------------------------- print (the certificate a customer gets)
  section('Print stylesheet — the certificate that leaves with the material');

  if (coaId) {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 1400 }, ignoreHTTPSErrors: true });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    await page.goto(`${WEB}/coa/${coaId}`, { waitUntil: 'networkidle' });
    await page.emulateMedia({ media: 'print' });

    const navHidden = await page.evaluate(() => {
      const header = document.querySelector('header');
      const nav = document.querySelector('nav[aria-label="Main"]');
      const hidden = (el) => !el || getComputedStyle(el).display === 'none';
      return hidden(header) && hidden(nav);
    });
    navHidden
      ? ok('navigation is hidden when printing', 'no app chrome on the certificate')
      : bad('navigation hidden in print', 'chrome would print on a document sent to a customer');

    await page.screenshot({ path: `${OUT}/print-coa.png`, fullPage: true });
    await ctx.close();
  } else {
    note('no certificate found to test the print layout');
  }

  await browser.close();

  console.log(`\n  Screenshots in .playwright/\n`);
  console.log(`\x1b[1m${pass} passed, ${fail} failed${notes.length ? `, ${notes.length} note(s)` : ''}\x1b[0m\n`);
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
