// Records the walkthrough from results/summary.json and results/raw.json on stage.html, timed to the narration.
import { test, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(here, 'out');
const SPEED = process.env.SPEED ?? '1.15';
const VOICE = process.env.VOICE ?? '';
// Narration clips: NARRATE renders one line (`NARRATE [-v VOICE] -s SPEED -o out.wav "line"`), NARRATE_CHECK checks them all.
// The hash of NARRATE_KEY_FILE joins the clip cache key, so a change to that file renders every line again.
const NARRATE = process.env.NARRATE ?? '';
const NARRATE_CHECK = process.env.NARRATE_CHECK ?? '';
const keyFile = process.env.NARRATE_KEY_FILE ?? '';
const VOICE_KEY = VOICE && keyFile && fs.existsSync(keyFile) ? `${VOICE}:${crypto.createHash('sha1').update(fs.readFileSync(keyFile)).digest('hex').slice(0, 8)}` : VOICE;
// HQ=1: 2x-DPR CDP screencast instead of recordVideo, voice chain, -14 LUFS, variable pauses, room tone
const HQ = !!process.env.HQ;
const GAP = 550;
const GAP_IN = 380; // HQ: pause within a chapter
const GAP_OUT = 1000; // HQ: pause before a new chapter
// FAST=1: no narration, one screenshot per step in out/frames, no video
const FAST = !!process.env.FAST;
// PLAN=1: render the narration, write the predicted out/narration.tsv and out/chapters.txt, no recording
const PLAN = !!process.env.PLAN;

type Stat = { median_ms: number };
type E1 = { runs: number; passed: number; steps: number | null; task: Stat; errors: string[] };
type E2 = { runs: number; immediate_pass_rate: number; polling_pass_rate: number; poll_ready: Stat };
type E3 = { runs: number; outcomes: Record<string, number>; example_detail: string };
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const sum: { info: { playwright: string; chromium: string; N: number }; e1: Record<string, E1>; e2: Record<string, E2>; e3: Record<string, E3> } = JSON.parse(read('results/summary.json'));
const raw: { e1: { ok: boolean; total: number | null }[]; e2: { lateMs: number; immediateCount: number; error?: string }[] } = JSON.parse(read('results/raw.json'));
const APP = read('app/index.html');
const TASKS = read('src/tasks.mjs');
const BENCH = read('src/bench.mjs');
const SPEC = read('tests/webmcp.spec.mjs');
const CONFIG = read('playwright.config.mjs');
const N = sum.info.N;
const e1 = (k: string) => sum.e1[k];
const DELAYS = Object.keys(sum.e2).map((k) => Number(/\d+/.exec(k)![0]));
const late = (ms: number) => sum.e2[`late_${ms}ms`];
const firstRead = (ms: number) => late(ms).immediate_pass_rate * late(ms).runs;
const polled = (ms: number) => late(ms).polling_pass_rate * late(ms).runs;
const CASES = Object.keys(sum.e3);
const detail = (c: string) => sum.e3[c].example_detail;
const count = (c: string, outcome: string) => sum.e3[c].outcomes[outcome] ?? 0;
const text = (c: string) => JSON.parse(detail(c)).content[0].text as string;
const INVALID_ECHO = ['schema_wrong_type_echo', 'schema_below_minimum_echo', 'schema_missing_required_echo', 'schema_extra_property_echo'];
const BAD_QTY = ['wrong_type_qty_string', 'missing_required_qty', 'non_integer_qty'];
// The call as the benchmark made it: tool name and input from src/bench.mjs
const call = (c: string, opts = '') => {
  const m = new RegExp(`\\['${c}', '(\\w+)', (\\{.*?\\})\\],`).exec(BENCH);
  if (!m) throw new Error('no benchmark case ' + c);
  return `page.webmcp.callTool('${m[1]}', ${m[2]}${opts})`;
};
const TOOLS = [...APP.matchAll(/name: '(\w+)', description: '/g)].map((m) => m[1]);
const PRICE = Object.fromEntries([...APP.matchAll(/name: '([^']+)', price: (\d+) \}/g)].map((m) => [m[1], Number(m[2])]));
const fn = (name: string) => { const i = TASKS.indexOf(`export async function ${name}`); return TASKS.slice(i, TASKS.indexOf('\n}\n', i) + 2); };
const squash = (s: string) => s.replace(/\s+/g, '');
// Code on screen is reflowed to fit: every block must still be in the source file
const from = (source: string, shown: string) => {
  for (const block of shown.split('\n\n')) {
    const code = block.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    if (!squash(source).includes(squash(code))) throw new Error('not in the source: ' + block);
  }
  return shown;
};
const ADD_TO_CART = from(APP, `mc.registerTool({
  name: 'add_to_cart',
  description: 'Add a quantity of a product to the cart.',
  inputSchema: {
    type: 'object',
    properties: { sku: { type: 'string' }, qty: { type: 'integer', minimum: 1 } },
    required: ['sku', 'qty']
  },
  execute: async ({ sku, qty }) => {
    if (!Number.isInteger(qty) || qty < 1)
      return { isError: true, content: [{ type: 'text', text: 'qty must be a positive integer' }] };
    try { return text(addToCart(sku, qty)); }
    catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
  },
});`);
const ECHO_QTY = from(APP, `mc.registerTool({
  name: 'echo_qty',
  description: 'Returns the type and value of qty exactly as received. No page-side validation.',
  inputSchema: {
    type: 'object',
    properties: { qty: { type: 'integer', minimum: 1 } },
    required: ['qty'],
    additionalProperties: false
  },
  execute: async (input) => text({ type: typeof input.qty, value: input.qty ?? null, keys: Object.keys(input) }),
});`);
const BOOM = from(APP, `mc.registerTool({
  name: 'boom',
  description: 'Always throws.',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => { throw new Error('boom'); }
});`);
const HANG = from(APP, `mc.registerTool({
  name: 'hang',
  description: 'Never resolves.',
  inputSchema: { type: 'object', properties: {} },
  execute: () => new Promise(() => {})
});`);
const LATE_PAGE = from(APP, `const lateMs = Number(params.get('late') || 0);

if (lateMs > 0) setTimeout(registerTools, lateMs);
else registerTools();`);
const LATE_TEST = from(BENCH, `// read once, straight after goto
row.immediateCount = (await page.webmcp.tools()).length;

// then again every 10 ms, until the tools are there
await page.waitForTimeout(10);
n = (await page.webmcp.tools()).length;`);
const POLL = from(SPEC, `await expect
  .poll(async () => (await page.webmcp.tools()).length, { timeout: 5000 })
  .toBe(7);`);
const MODEL_CONTEXT = from(APP, `const mc = document.modelContext || navigator.modelContext;

if (!mc) { window.__webmcpMissing = true; return; }`);
const HINT = from(APP, `mc.registerTool({
  name: 'checkout',
  description: 'Place the order for the current cart.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { consequentialHint: true },`);
const HINT_TEST = from(SPEC, `expect(tools.find(t => t.name === 'checkout')
  .annotations.consequential).toBe(true);`);
// Single checks of a call with no timeout, from the write-up. They are not in results/.
const ONCE = { libraryTimeoutS: 30, raisedTestTimeoutS: 50, stillPendingS: 42, defaultTestTimeoutS: 30 };

// Every number the narration says, checked against the data before recording
const SPOKEN: [string, number, number][] = [
  ['runs per row', N, 50],
  ['UI 1 WebMCP passed', e1('ui_v1/webmcp').passed, 50],
  ['UI 1 DOM passed', e1('ui_v1/dom').passed, 50],
  ['UI 2 WebMCP passed', e1('ui_v2/webmcp').passed, 50],
  ['UI 2 DOM passed', e1('ui_v2/dom').passed, 0],
  ['rows with 50 runs', [...Object.values(sum.e1), ...Object.values(sum.e2), ...Object.values(sum.e3)].filter((r) => r.runs !== 50).length, 0],
  ['WebMCP steps', e1('ui_v1/webmcp').steps!, 6],
  ['WebMCP steps on UI 2', e1('ui_v2/webmcp').steps!, 6],
  ['DOM steps', e1('ui_v1/dom').steps!, 8],
  ['tool list reads in the WebMCP script', fn('viaWebMCP').split('webmcp.tools()').length - 1, 1],
  ['tool calls in the WebMCP script', fn('viaWebMCP').split('webmcp.callTool(').length - 1, 5],
  ['actions in the DOM script', fn('viaDOM').split('steps++').length - 1, 8],
  ['task total', 2 * PRICE['Enamel mug'] + 1 * PRICE['Desk lamp'], 54],
  ['passing runs with a total other than 54', raw.e1.filter((r) => r.ok && r.total !== 54).length, 0],
  ['mugs added', Number(fn('viaWebMCP').includes('sku: found[0].sku, qty: 2')), 1],
  ['lamps added', Number(fn('viaWebMCP').includes('sku: lamp[0].sku, qty: 1')), 1],
  ['WebMCP median ms x100', Math.round(e1('ui_v1/webmcp').task.median_ms * 100), 964],
  ['DOM median ms, rounded', Math.round(e1('ui_v1/dom').task.median_ms), 135],
  ['DOM action timeout is 1 s', Number(e1('ui_v2/dom').errors.length === 1 && e1('ui_v2/dom').errors[0].includes('Timeout 1000ms')), 1],
  ['failed DOM runs took about 1 s', Math.round(e1('ui_v2/dom').task.median_ms / 1000), 1],
  ['tools', TOOLS.length, 7],
  ['tools in the unknown-tool message', detail('unknown_tool').split('Available tools: ')[1].split(', ').length, 7],
  ['real tools', TOOLS.indexOf('echo_qty'), 4],
  ['awkward tools', TOOLS.slice(4).filter((t) => ['echo_qty', 'boom', 'hang'].includes(t)).length, 3],
  ['delays', DELAYS.length, 4],
  ['delay 1', DELAYS[0], 0],
  ['delay 2', DELAYS[1], 50],
  ['delay 3', DELAYS[2], 200],
  ['delay 4', DELAYS[3], 1000],
  ['no delay: found on the first read', firstRead(0), 50],
  ['50 ms: found on the first read', firstRead(50), 0],
  ['200 ms: found on the first read', firstRead(200), 0],
  ['1000 ms: found on the first read', firstRead(1000), 0],
  ['delays above zero', DELAYS.filter((d) => d > 0).length, 3],
  ['late runs with an empty first read and no error', raw.e2.filter((r) => r.lateMs > 0 && r.immediateCount === 0 && !r.error).length, 150],
  ['late runs', raw.e2.filter((r) => r.lateMs > 0).length, 150],
  ['poll interval ms', Number(/waitForTimeout\((\d+)\); n = /.exec(BENCH)![1]), 10],
  ['delays where polling found the tools in 50 of 50', DELAYS.filter((d) => polled(d) === 50).length, 4],
  ['50 ms: median found, rounded', Math.round(late(50).poll_ready.median_ms), 59],
  ['200 ms: median found, rounded', Math.round(late(200).poll_ready.median_ms), 209],
  ['tools the poll waits for', Number(/\.toBe\((\d+)\)/.exec(POLL)![1]), 7],
  ['cases', CASES.length, 15],
  ['cases with one outcome in all 50 runs', CASES.filter((c) => Object.values(sum.e3[c].outcomes).join() === '50').length, 15],
  ['valid echo value', JSON.parse(text('schema_valid_echo')).value, 3],
  ['valid echo is a number', Number(JSON.parse(text('schema_valid_echo')).type === 'number'), 1],
  ['string reached the page as a string', Number(JSON.parse(text('schema_wrong_type_echo')).type === 'string'), 1],
  ['zero reached the page as zero', JSON.parse(text('schema_below_minimum_echo')).value, 0],
  ['invalid inputs', INVALID_ECHO.length, 4],
  ['invalid inputs that returned normally in 50 runs', INVALID_ECHO.filter((c) => count(c, 'returned_result') === 50).length, 4],
  ['bad quantities that returned isError with the message', BAD_QTY.filter((c) => count(c, 'returned_isError') === 50 && text(c) === 'qty must be a positive integer').length, 3],
  ['non-integer quantity x10', Number(/qty: ([\d.]+) \}/.exec(call('non_integer_qty'))![1]) * 10, 15],
  ['unknown sku returned isError', count('unknown_sku_page_isError', 'returned_isError'), 50],
  ['thrown error names boom', Number(detail('tool_throws').includes('boom')), 0],
  ['throwing tool threw', count('tool_throws', 'threw'), 50],
  ['unknown tool threw', count('unknown_tool', 'threw'), 50],
  ['no flag threw', count('no_flag', 'threw'), 50],
  ['hang timeout ms', Number(/Timeout (\d+)ms exceeded/.exec(detail('tool_hangs_500ms_timeout'))![1]), 500],
  ['hang threw', count('tool_hangs_500ms_timeout', 'threw'), 50],
  ['library timeout s', ONCE.libraryTimeoutS, 30],
  ['raised test timeout s', ONCE.raisedTestTimeoutS, 50],
  ['still pending after s', ONCE.stillPendingS, 42],
  ['default test timeout s', ONCE.defaultTestTimeoutS, 30],
  ['tests in the spec', SPEC.split('\ntest(').length - 1, 6],
  ['experiments', new Set(BENCH.match(/---- E\d/g)).size, 3],
];
for (const [what, got, said] of SPOKEN) if (got !== said) throw new Error(`narration says ${said} for ${what}, data has ${got}`);
if (sum.info.playwright !== '1.65.1') throw new Error('narration says 1.65.1');
if (!CONFIG.includes("args: ['--enable-features=WebMCP']") || !BENCH.includes("chromium.launch({ args: ['--enable-features=WebMCP'] })")) throw new Error('narration says the flag is passed');
if (text('unknown_sku_page_isError') !== 'Unknown sku NOPE' || !detail('no_flag').includes('WebMCP is not enabled') || detail('page_registers_no_tools') !== 'tools=0') throw new Error('narration quotes these results');
if (detail('tool_throws') !== 'webMCP.callTool: OperationError: Tool execution failed.') throw new Error('narration quotes the thrown error');

function speech(text: string) {
  if (FAST) return { wav: '', seconds: 0.3 };
  const dir = path.join(outDir, 'audio');
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, crypto.createHash('sha1').update(VOICE_KEY + SPEED + text).digest('hex').slice(0, 12) + '.wav');
  if (!fs.existsSync(wav)) {
    if (!NARRATE) throw new Error(`no clip for "${text}" and no NARRATE command`);
    execFileSync(NARRATE, [...(VOICE ? ['-v', VOICE] : []), '-s', SPEED, '-o', wav, text]);
  }
  const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], { encoding: 'utf8' }));
  return { wav, seconds };
}

type Stage = (fn: string, ...args: unknown[]) => Promise<void>;
type Step = { ch?: string; cap: string; say: string; act?: (S: Stage, page: Page) => Promise<unknown> };
const appUrl = (query = '') => 'file://' + path.join(root, 'app/index.html') + query;
const shop = (page: Page, n = 0) => page.frameLocator('iframe').nth(n);
const beat = (page: Page) => page.waitForTimeout(FAST ? 0 : 500);
const search = async (page: Page, n: number, input: string, go: string, query: string) => {
  await shop(page, n).getByTestId(input).fill(query);
  await shop(page, n).getByTestId(go).click();
};
const returned = (c: string) => `returned ${text(c)}`;
const isError = (c: string) => { const r = JSON.parse(detail(c)); return `returned isError: ${r.isError} · "${r.content[0].text}"`; };
const ms = (n: number) => `${n} ms`;
const lateLabel = (d: number) => (d ? `${d} ms late` : 'no delay');

const steps: Step[] = [
  {
    ch: 'The result',
    cap: 'Playwright calls a page\'s WebMCP tools: the task passed 50 of 50 runs',
    say: 'Playwright can now call the tools that a web page registers through WebMCP. In my benchmark, a task done through those tools passed in fifty of fifty runs.',
    act: (S) => S('card', '<h1>Playwright + WebMCP</h1><h2>a task through the page\'s tools: <span class="g">passed 50 of 50 runs</span></h2><h2 id="h2"></h2>'),
  },
  {
    cap: 'Tools registered 50 ms late: the first read found them in 0 of 50 runs',
    say: 'But when the page registered its tools just fifty milliseconds late, the first read of the tool list found them in zero of fifty runs. And there was no error.',
    act: (S) => S('append', '#h2', 'tools registered 50 ms late: <span class="r">first read found them in 0 of 50</span>, no error'),
  },
  {
    cap: 'More gaps around the calls',
    say: 'There were more gaps around the calls. Nothing checked the input against the schema. A tool that threw lost its reason. And a tool that never answers needs a timeout from you.',
    act: async (S) => {
      await S('clear');
      await S('card', '<h1>Around the calls</h1><ul><li><b>✗</b>nothing checked the input against the schema</li><li><b>✗</b>a tool that threw lost its reason</li><li><b>✗</b>a tool that never answers needs your timeout</li></ul>');
    },
  },
  {
    cap: '50 runs behind every result · a fresh browser context per run · no model',
    say: 'Every benchmark number in this video comes from a scripted run. Fifty runs behind every result, each in a fresh browser context. No model is involved.',
    act: async (S) => {
      await S('clear');
      await S('card', `<h1>How I measured</h1><div class="cols"><div class="col"><b>${N} runs</b><span>behind every result</span></div><div class="col"><b>fresh context</b><span>a new browser context for each run</span></div><div class="col"><b>no model</b><span>every figure is a scripted run</span></div></div>`);
    },
  },
  {
    cap: 'In this video',
    say: 'In this video: the setup, one task through tools and through test IDs, tools that register late, what call tool does not check, two naming traps, and what I would do.',
    act: async (S) => {
      await S('clear');
      await S('card', '<h1>In this video</h1><ul><li><b>1</b>the setup</li><li><b>2</b>one task: tools against test ids</li><li><b>3</b>tools that register late</li><li><b>4</b>what callTool does not check</li><li><b>5</b>two naming traps, and what I would do</li></ul>');
    },
  },

  {
    ch: 'The setup',
    cap: 'WebMCP: a page registers tools that an agent can call',
    say: 'First, what is WebMCP? It lets a page register tools. An agent can then call those tools, instead of clicking through the UI.',
    act: async (S) => {
      await S('clear');
      await S('card', '<h1>WebMCP</h1><div class="cols"><div class="col"><b>the page</b><span>registers tools: a name, an input schema, an execute function</span></div><div class="col"><b class="g">an agent</b><span>calls a tool, instead of clicking through the UI</span></div></div>');
    },
  },
  {
    cap: 'Playwright: page.webmcp.tools() and page.webmcp.callTool()',
    say: 'On the Playwright side, they sit on the page, under a WebMCP property. I use two methods here. Tools, which lists them. And call tool, which runs one.',
    act: async (S) => {
      await S('clear');
      await S('term', 'a', 'in a Playwright test', 'blue', 'big');
      await S('code', 'a', 'const tools = await page.webmcp.tools();\n\nconst result = await page.webmcp.callTool(name, input);');
    },
  },
  {
    cap: `Playwright ${sum.info.playwright} · Chromium ${sum.info.chromium.split('.')[0]}, headless · --enable-features=WebMCP`,
    say: 'This is Playwright one sixty-five point one, with its own Chromium build, headless. WebMCP is behind a flag, so the config launches the browser with enable features, WebMCP.',
    act: async (S) => {
      await S('clear');
      await S('term', 'c', 'playwright.config.mjs', 'blue', 'big');
      await S('code', 'c', CONFIG.slice(CONFIG.indexOf('export default')));
      await S('mark', 'c', '--enable-features=WebMCP');
    },
  },
  {
    cap: 'The page: a tiny shop with a normal UI',
    say: 'The page is a tiny shop, with a normal UI. A search box, an add to cart button, a total, and a checkout button.',
    act: async (S, page) => {
      await S('clear');
      await S('live', appUrl(), 'app/index.html', 'the real page');
      await S('card', '<h1>A tiny shop</h1><ul><li><b>-</b>a search box</li><li><b>-</b>an add to cart button</li><li><b>-</b>a total</li><li><b>-</b>a checkout button</li></ul>');
      await search(page, 0, 'search-input', 'search-btn', 'mug');
    },
  },
  {
    cap: '7 WebMCP tools on the same cart logic. 4 real ones.',
    say: 'It also registers seven WebMCP tools, backed by the same cart logic. Four real ones. Search products, add to cart, get cart, and checkout.',
    act: async (S) => {
      await S('drop', '.card');
      await S('term', 't', `${TOOLS.length} WebMCP tools`, 'pass', 'big');
      await S('code', 't', TOOLS.slice(0, 4).join('\n'));
    },
  },
  {
    cap: '3 awkward ones for the failure cases: echo_qty, boom, hang',
    say: 'And three awkward ones, for the failure cases. Echo quantity returns its input, exactly as received. Boom always throws. And hang never answers.',
    act: async (S) => {
      await S('code', 't', '\n' + ['returns its input as received', 'always throws', 'never answers'].map((d, i) => `${TOOLS[4 + i].padEnd(10)}${d}`).join('\n'), 'w');
    },
  },
  {
    cap: 'A tool: a name, a description, an input schema, an execute function',
    say: 'Here is how the page registers a tool. This is add to cart. A name, a description, an input schema, and an execute function.',
    act: async (S) => {
      await S('clear');
      await S('term', 'r', 'app/index.html · add_to_cart', 'blue');
      await S('code', 'r', ADD_TO_CART);
      for (const needle of ['name:', 'description:', 'inputSchema:', 'execute:']) await S('mark', 'r', needle);
    },
  },
  {
    cap: 'The schema: sku is a string, qty is an integer, minimum 1. Both required.',
    say: 'The schema says the product code is a string, and the quantity is an integer, with a minimum of one. Both are required. Remember that schema. It matters later.',
    act: async (S) => { await S('mark', 'r', 'properties:'); await S('mark', 'r', 'required:'); },
  },
  {
    cap: 'execute checks its own input, and returns isError with a message',
    say: 'This tool also checks its own input, inside execute. If the quantity is not a positive integer, it returns a result marked is error, with a message.',
    act: async (S) => { await S('mark', 'r', 'Number.isInteger'); await S('mark', 'r', 'qty must be a positive integer'); },
  },

  {
    ch: 'One task, two ways',
    cap: 'The task: add 2 mugs and 1 lamp, expect a total of 54',
    say: 'Now the first test. One task, done two ways. Add two mugs and one lamp to the cart, and expect a total of fifty-four.',
    act: async (S) => {
      await S('clear');
      await S('card', `<h1>The task</h1><h2>2 × Enamel mug (${PRICE['Enamel mug']}) + 1 × Desk lamp (${PRICE['Desk lamp']})</h2><h2>expected total: <span class="g">54</span></h2>`);
    },
  },
  {
    cap: 'Way 1, WebMCP: 1 read of the tool list + 5 tool calls = 6 steps',
    say: 'The first way uses the WebMCP tools, from a plain Playwright script. It reads the tool list once, and makes five tool calls. Six steps.',
    act: async (S) => {
      await S('clear');
      await S('term', 'w', 'src/tasks.mjs · viaWebMCP', 'pass');
      await S('code', 'w', fn('viaWebMCP'));
      for (const needle of ['webmcp.tools()', "query: 'enamel'", 'qty: 2', "query: 'lamp'", 'qty: 1', "'get_cart'"]) await S('mark', 'w', needle);
    },
  },
  {
    cap: 'Each result comes back as text, so the script parses it',
    say: 'Each result comes back as text, so the script reads it as JSON. Search for the mug, add two. Search for the lamp, add one. Then read the cart.',
    act: (S) => S('mark', 'w', 'const parse'),
  },
  {
    cap: 'Way 2, the DOM: 8 actions with getByTestId',
    say: 'The second way drives the UI, with get by test ID. Fill the search box, click search, set the quantity, click add, then read the total. Eight actions in all.',
    act: async (S, page) => {
      await S('clear');
      await S('term', 'd', 'src/tasks.mjs · viaDOM', 'blue');
      await S('code', 'd', fn('viaDOM'));
      await S('live', appUrl(), 'app/index.html', 'the real page');
      await beat(page);
      await search(page, 0, 'search-input', 'search-btn', 'enamel');
      await beat(page);
      await shop(page).getByTestId('qty-SKU-2').fill('2');
      await beat(page);
      await shop(page).getByTestId('add-SKU-2').click();
    },
  },
  {
    cap: 'The real page, after the same 8 actions: total 54',
    say: 'On the right, the real page runs the same actions. The number above the checkout button is the total. Fifty-four.',
    act: async (S, page) => {
      await search(page, 0, 'search-input', 'search-btn', 'lamp');
      await beat(page);
      await shop(page).getByTestId('add-SKU-4').click();
      if ((await shop(page).getByTestId('cart-total').textContent()) !== '54') throw new Error('the page total is not 54');
      await S('mark', 'd', "t('cart-total')");
    },
  },
  {
    cap: 'UI variant 2 renames every test id and every label',
    say: 'Next, I made a second version of the UI. Variant two renames every test ID, and every label. Search becomes find. Add to cart becomes buy. The cart logic, and the tools, stay the same.',
    act: async (S, page) => {
      await S('clear');
      await S('livegrid');
      await S('live', appUrl(), 'UI variant 1', 'search-input · search-btn · add-SKU-2');
      await S('live', appUrl('?v=2'), 'UI variant 2', 'q · go · buy-SKU-2');
      await search(page, 0, 'search-input', 'search-btn', 'mug');
      await search(page, 1, 'q', 'go', 'mug');
      await shop(page, 0).getByTestId('add-SKU-2').waitFor();
      await shop(page, 1).getByTestId('buy-SKU-2').waitFor();
    },
  },
  {
    cap: 'UI variant 1: WebMCP 50 of 50 · DOM test ids 50 of 50',
    say: 'Here are the results. On the first UI, the WebMCP script passed fifty of fifty runs. The DOM script also passed fifty of fifty.',
    act: async (S) => {
      await S('clear');
      await S('chart', 'Runs that passed the task', `out of ${N} · a fresh browser context per run`);
      await S('group', 'UI variant 1');
      await S('bar', 'WebMCP tools', e1('ui_v1/webmcp').passed, N, 'pass', `of ${N}`);
      await S('bar', 'DOM test ids', e1('ui_v1/dom').passed, N, 'pass', `of ${N}`);
    },
  },
  {
    cap: 'UI variant 2, renamed: WebMCP 50 of 50 · DOM test ids 0 of 50',
    say: 'On the renamed UI, the WebMCP script still passed fifty of fifty. The DOM script passed zero of fifty.',
    act: async (S) => {
      await S('group', 'UI variant 2, renamed');
      await S('bar', 'WebMCP tools', e1('ui_v2/webmcp').passed, N, 'pass', `of ${N}`);
      await S('bar', 'DOM test ids', e1('ui_v2/dom').passed, N, 'fail', `of ${N}`);
    },
  },
  {
    cap: e1('ui_v2/dom').errors[0],
    say: 'Every one of those runs stopped at the first action. The script waited one second for a search box that no longer had that test ID, and timed out.',
    act: (S) => S('key', [[`all ${N} failed runs: ${e1('ui_v2/dom').errors[0]}`, 'fail']]),
  },
  {
    cap: `Median task time, UI variant 1: WebMCP ${ms(e1('ui_v1/webmcp').task.median_ms)} · DOM ${ms(e1('ui_v1/dom').task.median_ms)}`,
    say: 'Now the time for the whole task, on the first UI. The median for WebMCP was nine point six four milliseconds. For the DOM script, it was about one hundred and thirty-five milliseconds.',
    act: async (S) => {
      await S('clear');
      await S('chart', 'The same task, on UI variant 1', `${N} runs each`);
      await S('group', 'Median task time');
      await S('bar', 'WebMCP tools', e1('ui_v1/webmcp').task.median_ms, 150, 'pass', 'ms');
      await S('bar', 'DOM test ids', e1('ui_v1/dom').task.median_ms, 150, 'blue', 'ms');
    },
  },
  {
    cap: 'Steps: 6 calls for WebMCP, 8 actions for the DOM script',
    say: 'And the steps. Six calls for WebMCP, against eight actions for the DOM script.',
    act: async (S) => {
      await S('group', 'Steps in the script');
      await S('bar', 'WebMCP tools', e1('ui_v1/webmcp').steps, 8, 'pass', 'calls');
      await S('bar', 'DOM test ids', e1('ui_v1/dom').steps, 8, 'blue', 'actions');
    },
  },

  {
    ch: 'Read it carefully',
    cap: 'These numbers flatter WebMCP. 1: the 0 of 50 is by construction.',
    say: 'But read those numbers carefully, because they flatter WebMCP. First, the zero of fifty is by construction. I renamed the IDs that the script depends on.',
    act: async (S) => {
      await S('clear');
      await S('card', '<h1>Read it carefully</h1><ul id="care"><li><b>1</b>The 0 of 50 is by construction<span>I renamed the ids the DOM script depends on</span></li></ul>');
    },
  },
  {
    cap: 'It shows that test ids are fragile, not that the DOM is worse',
    say: 'It shows that test IDs are fragile. It does not show that driving the DOM is worse in general. Role and text locators would survive some renames.',
    act: (S) => S('append', '#care li:last-child', '<span>role and text locators would survive some renames</span>'),
  },
  {
    cap: '2: 8 actions is low. The locators were known in advance.',
    say: 'Second, the step count. Eight actions is low, because I knew the locators in advance. An agent without them would also need snapshots, to find them.',
    act: (S) => S('append', '#care', '<li><b>2</b>8 actions is low<span>the locators were known in advance · an agent would also need snapshots</span></li>'),
  },
  {
    cap: '3: where the DOM time goes was not measured',
    say: 'Third, the time. I did not measure where the DOM time goes. The likely cause is that a DOM action does more. Playwright waits until the element is ready, then sends real input.',
    act: (S) => S('append', '#care', '<li><b>3</b>Where the DOM time goes: not measured<span>likely: Playwright waits until the element is ready, then sends real input</span></li>'),
  },
  {
    cap: 'With a model, its time per step is added to both methods',
    say: 'And with a model in the loop, the time the model takes for each step is added to both methods. I did not measure that either.',
    act: (S) => S('append', '#care li:last-child', '<span>a model adds its own time per step to both methods · not measured</span>'),
  },
  {
    cap: 'What carries over: the tools are not tied to the markup',
    say: 'Here is the part that does carry over. The tools are not tied to the markup. Variant two changed only the UI, so the same WebMCP script passed on both.',
    act: (S) => S('append', '#care', '<li><b class="g">✓</b>The tools are not tied to the markup<span>the same WebMCP script passed 50 of 50 on both UI variants</span></li>'),
  },

  {
    ch: 'Late tools',
    cap: 'The page registers its tools 0, 50, 200 or 1000 ms late',
    say: 'Now the result that surprised me. I made the page register its tools late: by fifty milliseconds, by two hundred, or by one thousand. And once with no delay, as a baseline.',
    act: async (S) => {
      await S('clear');
      await S('term', 'p', 'app/index.html · late registration', 'blue', 'big');
      await S('code', 'p', LATE_PAGE);
      await S('mark', 'p', 'setTimeout(registerTools, lateMs)');
    },
  },
  {
    cap: 'The test reads tools() once after goto, then again every 10 ms',
    say: 'Straight after navigation, the test reads the tool list once. Then it reads it again, every ten milliseconds, until the tools are there.',
    act: async (S) => {
      await S('clear');
      await S('term', 'b', 'src/bench.mjs · after goto', 'pass', 'big');
      await S('code', 'b', LATE_TEST);
      await S('mark', 'b', 'row.immediateCount');
    },
  },
  {
    cap: 'No delay: the first read found the tools in 50 of 50 runs',
    say: 'With no delay, the first read of the tool list found the tools in fifty of fifty runs.',
    act: async (S) => {
      await S('clear');
      await S('chart', 'Tools found on the first read', `runs out of ${N} · one read of page.webmcp.tools(), straight after goto`);
      await S('bar', lateLabel(0), firstRead(0), N, 'pass', `of ${N}`);
    },
  },
  {
    cap: 'Registered 50 ms late: the first read found them in 0 of 50 runs',
    say: 'With a delay of just fifty milliseconds, the first read found them in zero of fifty runs.',
    act: (S) => S('bar', lateLabel(50), firstRead(50), N, 'fail', `of ${N}`),
  },
  {
    cap: '200 ms and 1000 ms late: 0 of 50',
    say: 'The same with two hundred milliseconds, and with one thousand. In both cases, zero of fifty.',
    act: async (S) => { for (const d of [200, 1000]) await S('bar', lateLabel(d), firstRead(d), N, 'fail', `of ${N}`); },
  },
  {
    cap: '3 delays × 50 runs = 150 runs: an empty list, and no error',
    say: 'That is three delays, with fifty runs each. In all one hundred and fifty runs, the first read returned an empty list, and no error.',
    act: (S) => S('key', [['150 late runs: page.webmcp.tools() returned [] · no error', 'fail']]),
  },
  {
    cap: 'A test that reads the list straight after navigation sees no tools',
    say: 'So any test that reads the tool list straight after navigation sees no tools. And nothing says they are on the way.',
  },
  {
    cap: 'Polling every 10 ms found the tools in 50 of 50 runs, at every delay',
    say: 'Retrying fixed it. Reading the list every ten milliseconds found the tools in fifty of fifty runs, at every delay.',
    act: async (S) => {
      await S('clear');
      await S('chart', 'Median time until the tools were found', `polling every 10 ms · from the first read · found in ${N} of ${N} runs at every delay`);
      for (const d of DELAYS) await S('bar', lateLabel(d), late(d).poll_ready.median_ms, 1100, 'pass', 'ms');
    },
  },
  {
    cap: `50 ms late: found after ${ms(late(50).poll_ready.median_ms)} · 200 ms late: after ${ms(late(200).poll_ready.median_ms)}`,
    say: 'The time tracks the delay. With a delay of fifty milliseconds, the tools were found after a median of fifty-nine milliseconds. With two hundred, after two hundred and nine.',
  },
  {
    cap: 'In a test: expect.poll until the 7 tools are there',
    say: 'In a test, that is one expect poll. Read the tool list until it has the seven tools, with a timeout. Then start calling.',
    act: async (S) => {
      await S('clear');
      await S('term', 'f', 'tests/webmcp.spec.mjs · wait for registration', 'pass', 'big');
      await S('code', 'f', POLL);
    },
  },

  {
    ch: 'No schema check',
    cap: `What callTool does not do for you · ${CASES.length} cases, ${N} runs each`,
    say: 'Next, what call tool does not do for you. I ran fifteen cases, fifty times each. Each case gave the same outcome in all fifty runs.',
    act: async (S) => {
      await S('clear');
      await S('card', `<h1>What callTool does not do</h1><div class="cols"><div class="col"><b>${CASES.length} cases</b><span>bad input, errors, a tool that hangs</span></div><div class="col"><b>${N} runs each</b><span>a fresh browser context per run</span></div><div class="col"><b class="g">1 outcome</b><span>the same in all ${N} runs of a case</span></div></div>`);
    },
  },
  {
    cap: 'echo_qty: qty is required, an integer, minimum 1. No extra properties.',
    say: 'First, the schema. Echo quantity declares its input strictly. The quantity is required. It is an integer, with a minimum of one. And no extra properties are allowed.',
    act: async (S) => {
      await S('clear');
      await S('term', 'q', 'app/index.html · echo_qty', 'blue');
      await S('code', 'q', ECHO_QTY);
      for (const needle of ['properties:', 'required:', 'additionalProperties']) await S('mark', 'q', needle);
    },
  },
  {
    cap: 'Its execute has no checks: it returns the type and value it received',
    say: 'Its execute function has no checks of its own. It returns the type and the value it received. So it shows exactly what reaches the page.',
    act: (S) => S('mark', 'q', 'execute:'),
  },
  {
    cap: 'A valid call: qty 3 → a number, value 3',
    say: 'A valid call first. Quantity three goes in, and the tool reports a number, with the value three.',
    act: async (S) => {
      await S('clear');
      await S('term', 'e', 'echo_qty · what reached execute', 'pass', 'big');
      await S('type', 'e', call('schema_valid_echo'), true);
      await S('code', 'e', returned('schema_valid_echo'), 'g');
    },
  },
  {
    cap: 'A string where the schema says integer → reached the page as a string',
    say: 'Now a string, where the schema says integer. It reached the page as a string, and the call returned normally.',
    act: async (S) => { await S('type', 'e', call('schema_wrong_type_echo'), true); await S('code', 'e', returned('schema_wrong_type_echo'), 'w'); },
  },
  {
    cap: '0, below the minimum → reached the page as 0',
    say: 'Zero, which is below the minimum. That also reached the page, as zero.',
    act: async (S) => { await S('type', 'e', call('schema_below_minimum_echo'), true); await S('code', 'e', returned('schema_below_minimum_echo'), 'w'); },
  },
  {
    cap: 'Missing qty, and an extra property → both reached execute',
    say: 'An empty input, with the required quantity missing. And an input with an extra property. Both went through to the execute function unchanged, and neither call failed.',
    act: async (S) => {
      for (const c of ['schema_missing_required_echo', 'schema_extra_property_echo']) { await S('type', 'e', call(c), true); await S('code', 'e', returned(c), 'w'); }
    },
  },
  {
    cap: '4 invalid inputs, 50 runs each: none rejected',
    say: 'Four invalid inputs, fifty runs each, and none was rejected. In this Playwright and Chromium build, nothing between the test and the page checked the input. So the page has to.',
    act: (S) => S('label', 'e', `${INVALID_ECHO.length} invalid inputs · rejected: 0`, 'warn'),
  },
  {
    cap: 'add_to_cart checks its own input: isError, with a message',
    say: 'That is why add to cart checks its own input. With a string quantity, a missing quantity, or one point five, the result came back with is error set, and the message, quantity must be a positive integer.',
    act: async (S) => {
      await S('clear');
      await S('term', 'k', 'add_to_cart · checks inside execute', 'pass', 'big');
      for (const c of BAD_QTY) { await S('type', 'k', call(c), true); await S('code', 'k', isError(c), 'w'); }
    },
  },

  {
    ch: 'Errors',
    cap: 'An error from the page is a result, not an exception',
    say: 'The second gap is how errors come back. I asked add to cart for a product that does not exist. Its result had is error set. Call tool handed that back like any other result. It did not throw.',
    act: async (S) => {
      await S('clear');
      await S('term', 'k', 'add_to_cart · an unknown product code', 'pass', 'big');
      await S('type', 'k', call('unknown_sku_page_isError'), true);
      await S('code', 'k', isError('unknown_sku_page_isError'), 'w');
      await S('label', 'k', 'returned · did not throw', 'warn');
    },
  },
  {
    cap: 'A test has to check result.isError',
    say: 'So awaiting the call is not enough. A test has to check is error on the result.',
    act: (S) => S('code', 'k', '\nexpect(result.isError).toBe(true);', 'g'),
  },
  {
    cap: 'A tool that throws: OperationError: Tool execution failed.',
    say: 'Now a tool that throws. Boom throws an error, with the message, boom. The test got, operation error, tool execution failed.',
    act: async (S) => {
      await S('clear');
      await S('term', 'x', 'app/index.html · boom', 'fail', 'big');
      await S('code', 'x', BOOM);
      await S('type', 'x', call('tool_throws'), true);
      await S('code', 'x', `threw ${detail('tool_throws')}`, 'r');
    },
  },
  {
    cap: 'The word "boom" is not in it. The reason never reached the test.',
    say: 'The word boom is not in it. The reason for the failure never reached the test.',
    act: async (S) => { await S('mark', 'x', "throw new Error('boom')"); await S('mark', 'x', 'Tool execution failed'); },
  },
  {
    cap: 'An unknown tool throws, and the message lists the available tools',
    say: 'A call to a tool that does not exist also throws. That message is more useful. It lists the tools that are available.',
    act: async (S) => {
      await S('clear');
      await S('term', 'u', 'three more cases', 'fail', 'big');
      await S('type', 'u', call('unknown_tool'), true);
      await S('code', 'u', `threw ${detail('unknown_tool')}`, 'r');
    },
  },
  {
    cap: 'No flag: "WebMCP is not enabled" · no tools: an empty list',
    say: 'Two more. In a browser without the flag, the call fails with the message, WebMCP is not enabled, and it names the argument to add. And a page that registers nothing returns an empty list.',
    act: async (S) => {
      await S('type', 'u', 'page.webmcp.tools()   // browser launched without the flag', true);
      await S('code', 'u', `threw ${detail('no_flag').replace('. Launch', '.\nLaunch')}`, 'r');
      await S('type', 'u', 'page.webmcp.tools()   // the page registers no tools', true);
      await S('code', 'u', 'returned []', 'w');
    },
  },

  {
    ch: 'A tool that hangs',
    cap: 'hang: a promise that never resolves',
    say: 'The last case is a tool that never answers. Hang returns a promise that never resolves.',
    act: async (S) => {
      await S('clear');
      await S('term', 'h', 'app/index.html · hang', 'fail', 'big');
      await S('code', 'h', HANG);
      await S('mark', 'h', 'new Promise');
    },
  },
  {
    cap: 'With { timeout: 500 }: Timeout 500ms exceeded, in 50 of 50 runs',
    say: 'With a timeout of five hundred milliseconds on the call, call tool failed with a timeout error, in fifty of fifty runs.',
    act: async (S) => {
      await S('type', 'h', call('tool_hangs_500ms_timeout', ', { timeout: 500 }'), true);
      await S('code', 'h', `threw ${detail('tool_hangs_500ms_timeout')}`, 'r');
      await S('label', 'h', `${count('tool_hangs_500ms_timeout', 'threw')} of ${N} runs`, 'warn');
    },
  },
  {
    cap: 'Without a timeout: checked once each, outside the benchmark',
    say: 'Without a timeout, the result depends on where the code runs. I checked each of these once, outside the benchmark.',
    act: async (S) => {
      await S('clear');
      await S('card', '<h1>hang, without a timeout</h1><p>three single checks, outside the 50-run benchmark</p><ul id="once"></ul>');
    },
  },
  {
    cap: `A plain library script: Timeout ${ONCE.libraryTimeoutS * 1000}ms exceeded.`,
    say: 'In a plain library script, the call threw a timeout after thirty seconds.',
    act: (S) => S('append', '#once', `<li><b>1</b>A plain library script<span>the call threw: Timeout ${ONCE.libraryTimeoutS * 1000}ms exceeded.</span></li>`),
  },
  {
    cap: `Test runner, test timeout raised to ${ONCE.raisedTestTimeoutS} s: still pending after ${ONCE.stillPendingS} s`,
    say: 'Under the Playwright test runner, with the test timeout raised to fifty seconds, the call was still pending after forty-two seconds.',
    act: (S) => S('append', '#once', `<li><b>2</b>The test runner, test timeout raised to ${ONCE.raisedTestTimeoutS} s<span>the call was still pending after ${ONCE.stillPendingS} s</span></li>`),
  },
  {
    cap: `Default settings: Test timeout of ${ONCE.defaultTestTimeoutS * 1000}ms exceeded.`,
    say: 'And with the default settings, the test failed after thirty seconds. But that was the test timeout, not a timeout of the call.',
    act: (S) => S('append', '#once', `<li><b>3</b>The test runner, default settings<span>Test timeout of ${ONCE.defaultTestTimeoutS * 1000}ms exceeded. · the test timeout, not the call</span></li>`),
  },
  {
    cap: 'A safe call: a timeout on the call, and a check of isError',
    say: 'So a safe call looks like this. A timeout on the call, and a check of is error on the result.',
    act: async (S) => {
      await S('clear');
      await S('term', 's', 'in your test', 'pass', 'big');
      await S('code', 's', "const result = await page.webmcp.callTool(\n  'add_to_cart', { sku: 'NOPE', qty: 1 }, { timeout: 500 }\n);\nexpect(result.isError).toBe(true);");
      await S('mark', 's', 'timeout: 500');
      await S('mark', 's', 'result.isError');
    },
  },

  {
    ch: 'Two naming traps',
    cap: 'Trap 1: document.modelContext, not navigator.modelContext',
    say: 'Two naming traps, and neither gives an error. One. In this Chromium build, the page side object is model context on document. On navigator, model context is undefined.',
    act: async (S) => {
      await S('clear');
      await S('term', 'n', 'app/index.html · registerTools', 'blue', 'big');
      await S('code', 'n', MODEL_CONTEXT);
      await S('mark', 'n', 'document.modelContext');
    },
  },
  {
    cap: 'A page that only checks navigator.modelContext registers nothing',
    say: 'A page that only looks at navigator registers nothing, and nothing says why.',
    act: (S) => S('label', 'n', 'navigator.modelContext: undefined in this build', 'warn'),
  },
  {
    cap: 'Trap 2: consequentialHint on the page → annotations.consequential',
    say: 'Two. The page side hint for a consequential tool is called consequential hint. Playwright reports it as annotations dot consequential.',
    act: async (S) => {
      await S('clear');
      await S('term', 'n', 'app/index.html · checkout', 'blue');
      await S('code', 'n', HINT + '\n  ...');
      await S('term', 'm', 'tests/webmcp.spec.mjs', 'pass');
      await S('code', 'm', HINT_TEST);
      await S('mark', 'n', 'consequentialHint');
      await S('mark', 'm', 'annotations.consequential');
    },
  },
  {
    cap: 'Registered as "consequential": the tool came back with no annotations',
    say: 'When I registered a tool with plain consequential, without the word hint, it came back from the tool list with no annotations.',
    act: (S) => S('code', 'n', '\nannotations: { consequential: true }\n→ came back with no annotations', 'w'),
  },

  {
    ch: 'Limits',
    cap: 'No model is involved, and no tokens were measured',
    say: 'Now the limits. No model is involved. This says nothing about whether a model picks WebMCP tools better than DOM clicks. And I did not measure tokens.',
    act: async (S) => {
      await S('clear');
      await S('card', '<h1>Limits</h1><ul id="lim"><li><b>-</b>No model, no tokens measured<span>nothing here says a model picks tools better than DOM clicks</span></li></ul>');
    },
  },
  {
    cap: 'The tools were called through Playwright only',
    say: 'I called the tools through Playwright only. I did not test what a browser\'s own agent does with the schema, before it calls a tool.',
    act: (S) => S('append', '#lim', '<li><b>-</b>Called through Playwright only<span>not tested: what a browser\'s own agent does with the schema</span></li>'),
  },
  {
    cap: 'One toy page, one machine, one browser build, headless',
    say: 'This is one toy page on localhost, on one machine, with one browser build, headless. The timings are from a warm local run. Read them as orders of magnitude.',
    act: (S) => S('append', '#lim', '<li><b>-</b>One toy page, one machine, one browser build<span>warm local timings: read them as orders of magnitude</span></li>'),
  },
  {
    cap: 'Not tested: Playwright MCP, Firefox, other Chromium builds, headed',
    say: 'And I did not test the WebMCP support in Playwright MCP, Firefox, other Chromium builds, or headed mode.',
    act: (S) => S('append', '#lim', '<li><b>-</b>Not tested<span>WebMCP support in Playwright MCP · Firefox · other Chromium builds · headed mode</span></li>'),
  },

  {
    ch: 'Try it',
    cap: 'Clone it and run the 6 tests',
    say: 'To try it, clone the repository, install, and run the tests. Six tests check the findings from this video. The config already passes the flag.',
    act: async (S) => {
      await S('clear');
      await S('term', 'a', 'your terminal', 'pass', 'big');
      await S('type', 'a', 'git clone https://github.com/qa-gary-parker/poc-playwright-webmcp');
      await S('type', 'a', 'npm ci && npx playwright install chromium');
      await S('type', 'a', 'npm test');
    },
  },
  {
    cap: 'npm run bench: 3 experiments, 50 runs behind every result',
    say: 'The bench script repeats all three experiments, with fifty runs behind every result, and writes every run to the results folder.',
    act: (S) => S('type', 'a', 'npm run bench'),
  },
  {
    cap: 'Every benchmark number here: results/summary.json and raw.json',
    say: 'Every benchmark number in this video comes from that folder. The summary, and every single run, are in the repository.',
    act: async (S) => {
      await S('clear');
      await S('term', 'r', 'results/summary.json · tools registered 50 ms late', 'blue');
      await S('code', 'r', JSON.stringify({ late_50ms: late(50) }, null, 2));
      await S('mark', 'r', 'immediate_pass_rate');
    },
  },

  {
    ch: 'What to do',
    cap: '1. Test the tools directly, and wait for registration',
    say: 'What would I do with this? One. Test your page\'s tools directly, with call tool. And wait for registration, before you read the tool list.',
    act: async (S) => {
      await S('clear');
      await S('card', '<h1>What I would do</h1><ul id="todo"><li><b>1</b>Test the tools directly, and wait for registration<span>50 ms late: the first read found them in 0 of 50 runs</span></li></ul>');
    },
  },
  {
    cap: '2. A timeout on every callTool, and check isError on every result',
    say: 'Two. Every call gets a timeout, and every result gets a check of is error.',
    act: (S) => S('append', '#todo', '<li><b>2</b>A timeout on every callTool, and check isError<span>a page error came back as a normal result</span></li>'),
  },
  {
    cap: '3. Validate the input inside execute',
    say: 'Three. Validate the input inside execute. Do not rely on the declared schema. Here, four invalid inputs went straight through.',
    act: (S) => S('append', '#todo', '<li><b>3</b>Validate the input inside execute<span>4 invalid inputs reached the page, 50 runs each</span></li>'),
  },
  {
    cap: '4. Return isError with a message. Do not throw.',
    say: 'Four. When a tool can fail, set is error on the result, and add a message. Do not throw. The message of a thrown error did not reach the test.',
    act: (S) => S('append', '#todo', '<li><b>4</b>Return isError with a message. Do not throw.<span>a thrown "boom" arrived as "Tool execution failed."</span></li>'),
  },
];

const END_SECONDS = 10;
const END_SAY = 'The code, every run, and the write-up are linked in the description.';

test('record the walkthrough', async ({ browser }, testInfo) => {
  const says = [...steps.map((s) => s.say), END_SAY];
  let lines = says.map(speech);
  if (NARRATE_CHECK && !FAST) {
    const tsv = path.join(outDir, 'narration-pre.tsv');
    fs.writeFileSync(tsv, says.map((s) => `0\t${s}`).join('\n') + '\n');
    execFileSync(NARRATE_CHECK, [tsv, path.join(outDir, 'audio'), VOICE, SPEED, '4'], { stdio: 'inherit' });
    lines = says.map(speech);
  }
  if (PLAN) {
    // The same timing as an HQ recording whose actions fit inside the narration
    let t = 0.4;
    const tsv: string[] = [];
    const chapters: string[] = [];
    for (const [i, step] of steps.entries()) {
      if (step.ch) chapters.push(`${chapters.length ? `${Math.floor(t / 60)}:${String(Math.floor(t) % 60).padStart(2, '0')}` : '0:00'} ${step.ch}`);
      tsv.push(`${t.toFixed(2)}\t${step.say}`);
      t += lines[i].seconds + (steps[i + 1]?.ch || i === steps.length - 1 ? GAP_OUT : GAP_IN) / 1000;
    }
    tsv.push(`${t.toFixed(2)}\t${END_SAY}`);
    fs.writeFileSync(path.join(outDir, 'narration.tsv'), tsv.join('\n') + '\n');
    fs.writeFileSync(path.join(outDir, 'chapters.txt'), chapters.join('\n') + '\n');
    console.log(`predicted ${(t + END_SECONDS).toFixed(1)} s\n${chapters.join('\n')}`);
    return;
  }
  const viewport = testInfo.project.use.viewport!;
  const context = await browser.newContext(HQ
    ? { viewport, deviceScaleFactor: 2 }
    : { viewport, recordVideo: { dir: testInfo.outputDir, size: viewport } });
  const page: Page = await context.newPage();
  const frames: { t: number; file: string }[] = [];
  const frameDir = path.join(outDir, 'hq-frames');
  let cdp: Awaited<ReturnType<typeof context.newCDPSession>> | undefined;
  if (HQ && !FAST) {
    fs.rmSync(frameDir, { recursive: true, force: true });
    fs.mkdirSync(frameDir, { recursive: true });
    cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      const file = path.join(frameDir, `${String(frames.length).padStart(6, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      frames.push({ t: metadata.timestamp! * 1000, file });
      cdp!.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
  }
  await page.goto('file://' + path.join(here, 'stage.html'));
  await page.evaluate(() => document.fonts.ready);
  const S: Stage = (fn, ...args) => page.evaluate(([f, a]) => (window as any).S[f as string](...(a as unknown[])), [fn, args] as const);

  if (cdp) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
  const start = Date.now();
  const at = () => (Date.now() - start) / 1000;
  const cues: { at: number; wav: string; say: string }[] = [];
  const chapters: string[] = [];
  let chapter = 0;
  if (FAST) fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });
  await page.waitForTimeout(400);
  for (const [i, step] of steps.entries()) {
    if (step.ch) {
      await S('chapter', ++chapter, step.ch);
      const t = Math.floor(at());
      chapters.push(`${chapter === 1 ? '0:00' : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`} ${step.ch}`);
    }
    const began = Date.now();
    cues.push({ at: at(), wav: lines[i].wav, say: step.say });
    await S('caption', step.cap);
    await S('fresh');
    await step.act?.(S, page);
    const gap = HQ ? (steps[i + 1]?.ch || i === steps.length - 1 ? GAP_OUT : GAP_IN) : GAP;
    await page.waitForTimeout(Math.max(0, lines[i].seconds * 1000 + gap - (Date.now() - began)));
    if (FAST) await page.screenshot({ path: path.join(outDir, 'frames', `${String(i + 1).padStart(2, '0')}.png`) });
  }
  await S('end', [
    ['write-up', 'garyparker.dev/blog/\nplaywright-webmcp'],
    ['source', 'github.com/qa-gary-parker/\npoc-playwright-webmcp'],
  ], 'calls: 50 of 50 · tools 50 ms late: first read 0 of 50, no error');
  cues.push({ at: at(), wav: lines[steps.length].wav, say: END_SAY });
  if (FAST) {
    await page.screenshot({ path: path.join(outDir, 'frames', 'end.png') });
    await context.close();
    return;
  }
  await page.waitForTimeout(END_SECONDS * 1000);
  const length = at();

  const webm = path.join(outDir, 'walkthrough.webm');
  let videoIn: string[];
  if (HQ) {
    await cdp!.send('Page.stopScreencast');
    await context.close();
    // Frames arrive only when the page changes: hold each until the next one.
    const list = frames.map((f, i) => {
      const end = i + 1 < frames.length ? frames[i + 1].t : start + length * 1000;
      return `file '${f.file}'\nduration ${(Math.max(1, end - Math.max(f.t, start)) / 1000).toFixed(4)}`;
    });
    const concat = path.join(frameDir, 'list.txt');
    fs.writeFileSync(concat, list.join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`);
    const firstAt = Math.max(0, (frames[0].t - start) / 1000);
    videoIn = ['-f', 'concat', '-safe', '0', '-i', concat];
    if (firstAt > 0.01) videoIn = ['-itsoffset', firstAt.toFixed(3), ...videoIn];
  } else {
    const video = page.video()!;
    await context.close();
    await video.saveAs(webm);
    videoIn = ['-i', webm];
  }
  fs.writeFileSync(path.join(outDir, 'chapters.txt'), chapters.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'narration.tsv'), cues.map((c) => `${c.at.toFixed(2)}\t${c.say}`).join('\n') + '\n');

  const inputs = cues.flatMap((c) => ['-i', c.wav]);
  const delays = cues.map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.at * 1000)}:all=1[a${i}]`).join(';');
  const mix = cues.map((_, i) => `[a${i}]`).join('');
  // HQ voice chain: rumble cut, less boxiness, presence, de-ess, gentle compression, faint room tone, -14 LUFS (YouTube)
  const voice = HQ
    ? 'highpass=f=80,equalizer=f=300:t=q:w=1:g=-2,equalizer=f=3500:t=q:w=1.2:g=2.5,deesser=i=0.4,acompressor=threshold=-20dB:ratio=3:attack=5:release=120:makeup=2'
    : 'anull';
  const room = HQ ? `;anoisesrc=colour=brown:amplitude=0.0035:sample_rate=48000:duration=${length.toFixed(3)},lowpass=f=3000[room]` : '';
  const voiceMix = `${mix}amix=inputs=${cues.length}:normalize=0:duration=longest,apad,${voice}`;
  const audio = HQ
    ? `${delays}${room};${voiceMix}[v];[v][room]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-14:TP=-1:LRA=11[aout]`
    : `${delays};${voiceMix},loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
  const video = HQ ? ['-vf', 'fps=30', '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-tune', 'stillimage'] : ['-c:v', 'libx264', '-crf', '20', '-preset', 'medium'];
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...videoIn, ...inputs,
    '-filter_complex', audio,
    '-map', '0:v', '-map', '[aout]', ...video, '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-t', length.toFixed(3), '-movflags', '+faststart', path.join(outDir, 'walkthrough.mp4')]);
  if (HQ) {
    const LIMIT = 'alimiter=limit=0.5:attack=3:release=60:level=false';
    // Second loudness pass: measure the mix, then apply linear gain to exactly -14 LUFS / -1 dBTP.
    const mp4 = path.join(outDir, 'walkthrough.mp4');
    const tmp = path.join(outDir, 'walkthrough.pre-loudnorm.mp4');
    fs.renameSync(mp4, tmp);
    const err = spawnSync('ffmpeg', ['-hide_banner', '-i', tmp, '-af', `${LIMIT},loudnorm=I=-14:TP=-1:LRA=11:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const m = JSON.parse(err.slice(err.lastIndexOf('{'), err.lastIndexOf('}') + 1));
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', tmp, '-c:v', 'copy', '-af',
      `${LIMIT},loudnorm=I=-14:TP=-1:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`,
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', mp4]);
    fs.rmSync(tmp);
  }
  console.log(`walkthrough.mp4 ${length.toFixed(1)} s, ${cues.length} lines, ${lines.reduce((a, l) => a + l.seconds, 0).toFixed(1)} s of speech`);
  console.log(chapters.join('\n'));
});
