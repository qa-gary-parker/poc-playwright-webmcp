import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.mjs';
import { viaWebMCP, viaDOM, EXPECTED_TOTAL } from './tasks.mjs';

const N = Number(process.env.N || 50);
const OUT = process.env.OUT || 'results';
const ms = t0 => Number((performance.now() - t0).toFixed(2));
const stats = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median_ms: q(0.5), p95_ms: q(0.95), max_ms: s[s.length - 1] };
};
const firstLine = e => String(e?.message ?? e).split('\n')[0].slice(0, 160);

const server = await startServer();
const browser = await chromium.launch({ args: ['--enable-features=WebMCP'] });
const info = { playwright: (await import('@playwright/test/package.json', { with: { type: 'json' } })).default.version, chromium: browser.version(), node: process.version, N, platform: process.platform };

async function freshPage(query = '') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const t0 = performance.now();
  await page.goto(`${server.url}/${query}`);
  return { ctx, page, gotoMs: ms(t0) };
}

// ---- E1: same task through WebMCP tools and through DOM selectors, on UI variant 1 and 2 ----
const e1 = [];
for (const variant of ['1', '2']) {
  for (const method of ['webmcp', 'dom']) {
    for (let i = 0; i < N; i++) {
      const { ctx, page, gotoMs } = await freshPage(`?v=${variant}`);
      const t0 = performance.now();
      const row = { experiment: 'e1_task', variant, method, run: i, gotoMs };
      try {
        const r = await (method === 'webmcp' ? viaWebMCP(page) : viaDOM(page));
        const real = await page.evaluate(() => Object.entries(window.__cart).map(([k, v]) => k + ':' + v).join(','));
        Object.assign(row, r, { ok: r.ok && real === 'SKU-2:2,SKU-4:1', error: null });
      } catch (e) { Object.assign(row, { ok: false, steps: null, total: null, error: firstLine(e) }); }
      row.taskMs = ms(t0);
      e1.push(row);
      await ctx.close();
    }
  }
}

// ---- E2: tools registered late. Read immediately after goto('load') and with polling. ----
const e2 = [];
for (const late of [0, 50, 200, 1000]) {
  for (let i = 0; i < N; i++) {
    const { ctx, page } = await freshPage(`?late=${late}`);
    const row = { experiment: 'e2_late_registration', lateMs: late, run: i };
    const t0 = performance.now();
    row.immediateCount = (await page.webmcp.tools()).length;
    row.immediateOk = row.immediateCount >= 6;
    try {
      const deadline = t0 + 5000;
      let n = row.immediateCount;
      while (n < 6 && performance.now() < deadline) { await page.waitForTimeout(10); n = (await page.webmcp.tools()).length; }
      row.pollOk = n >= 6; row.pollReadyMs = ms(t0);
    } catch (e) { row.pollOk = false; row.error = firstLine(e); }
    e2.push(row);
    await ctx.close();
  }
}

// ---- E3: failure modes. What does Playwright hand back for bad calls? ----
const cases = [
  ['valid_call', 'add_to_cart', { sku: 'SKU-1', qty: 1 }],
  ['wrong_type_qty_string', 'add_to_cart', { sku: 'SKU-1', qty: '2' }],
  ['missing_required_qty', 'add_to_cart', { sku: 'SKU-1' }],
  ['non_integer_qty', 'add_to_cart', { sku: 'SKU-1', qty: 1.5 }],
  ['schema_valid_echo', 'echo_qty', { qty: 3 }],
  ['schema_wrong_type_echo', 'echo_qty', { qty: '3' }],
  ['schema_below_minimum_echo', 'echo_qty', { qty: 0 }],
  ['schema_missing_required_echo', 'echo_qty', {}],
  ['schema_extra_property_echo', 'echo_qty', { qty: 3, extra: true }],
  ['unknown_sku_page_isError', 'add_to_cart', { sku: 'NOPE', qty: 1 }],
  ['unknown_tool', 'does_not_exist', {}],
  ['tool_throws', 'boom', {}],
  ['tool_hangs_500ms_timeout', 'hang', {}],
];
const e3 = [];
for (const [name, tool, input] of cases) {
  for (let i = 0; i < N; i++) {
    const { ctx, page } = await freshPage();
    const t0 = performance.now();
    const row = { experiment: 'e3_failure_modes', case: name, run: i };
    try {
      const r = await page.webmcp.callTool(tool, input, { timeout: 500 });
      Object.assign(row, { outcome: r?.isError ? 'returned_isError' : 'returned_result', detail: JSON.stringify(r).slice(0, 160) });
    } catch (e) { Object.assign(row, { outcome: 'threw', detail: firstLine(e) }); }
    row.ms = ms(t0);
    e3.push(row);
    await ctx.close();
  }
}
// Browser without the flag, and a page that registers nothing.
for (const [name, args, query] of [['no_flag', [], ''], ['page_registers_no_tools', ['--enable-features=WebMCP'], '?tools=0']]) {
  for (let i = 0; i < N; i++) {
    const b = await chromium.launch({ args });
    const page = await b.newPage();
    await page.goto(`${server.url}/${query}`);
    const row = { experiment: 'e3_failure_modes', case: name, run: i };
    try { const t = await page.webmcp.tools(); Object.assign(row, { outcome: 'returned_result', detail: `tools=${t.length}` }); }
    catch (e) { Object.assign(row, { outcome: 'threw', detail: firstLine(e) }); }
    e3.push(row);
    await b.close();
  }
}

// ---- Summaries (all derived from the rows above) ----
const group = (rows, keyFn) => rows.reduce((m, r) => { const k = keyFn(r); (m[k] ||= []).push(r); return m; }, {});
const summary = { info, e1: {}, e2: {}, e3: {} };
for (const [k, rows] of Object.entries(group(e1, r => `ui_v${r.variant}/${r.method}`))) {
  const ok = rows.filter(r => r.ok);
  summary.e1[k] = { runs: rows.length, passed: ok.length, pass_rate: ok.length / rows.length, steps: ok[0]?.steps ?? null, task: stats(rows.map(r => r.taskMs)), goto: stats(rows.map(r => r.gotoMs)), errors: [...new Set(rows.map(r => r.error).filter(Boolean))] };
}
for (const [k, rows] of Object.entries(group(e2, r => `late_${r.lateMs}ms`))) {
  summary.e2[k] = { runs: rows.length, immediate_pass_rate: rows.filter(r => r.immediateOk).length / rows.length, polling_pass_rate: rows.filter(r => r.pollOk).length / rows.length, poll_ready: stats(rows.filter(r => r.pollOk).map(r => r.pollReadyMs)) };
}
for (const [k, rows] of Object.entries(group(e3, r => r.case))) {
  const outcomes = {}; for (const r of rows) outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
  summary.e3[k] = { runs: rows.length, outcomes, example_detail: rows[0].detail, ...(rows[0].ms !== undefined ? { call: stats(rows.map(r => r.ms)) } : {}) };
}

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/raw.json`, JSON.stringify({ info, e1, e2, e3 }, null, 1));
const csv = (rows) => { const cols = [...new Set(rows.flatMap(Object.keys))]; return [cols.join(','), ...rows.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(','))].join('\n'); };
await writeFile(`${OUT}/e1_task.csv`, csv(e1));
await writeFile(`${OUT}/e2_late_registration.csv`, csv(e2));
await writeFile(`${OUT}/e3_failure_modes.csv`, csv(e3));
await writeFile(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
await browser.close(); await server.close();
