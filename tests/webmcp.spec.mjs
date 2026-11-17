import { test, expect } from '@playwright/test';
import { startServer } from '../src/server.mjs';
import { viaWebMCP, viaDOM, EXPECTED_TOTAL } from '../src/tasks.mjs';

let server;
test.beforeAll(async () => { server = await startServer(); });
test.afterAll(async () => { await server.close(); });

test('page.webmcp lists the registered tools with schemas and annotations', async ({ page }) => {
  await page.goto(server.url);
  const tools = await page.webmcp.tools();
  expect(tools.map(t => t.name).sort()).toEqual(['add_to_cart', 'boom', 'checkout', 'echo_qty', 'get_cart', 'hang', 'search_products']);
  const add = tools.find(t => t.name === 'add_to_cart');
  expect(add.inputSchema.required).toEqual(['sku', 'qty']);
  expect(tools.find(t => t.name === 'checkout').annotations.consequential).toBe(true);
  expect(tools.find(t => t.name === 'get_cart').annotations.readOnly).toBe(true);
});

test('the shopping task passes through WebMCP and through DOM selectors', async ({ page }) => {
  await page.goto(server.url);
  const r = await viaWebMCP(page);
  expect(r).toMatchObject({ ok: true, steps: 6, total: EXPECTED_TOTAL });
  const page2 = await page.context().newPage();
  await page2.goto(server.url);
  expect(await viaDOM(page2)).toMatchObject({ ok: true, steps: 8, total: EXPECTED_TOTAL });
});

test('a renamed UI breaks the DOM script but not the WebMCP script', async ({ page }) => {
  await page.goto(server.url + '/?v=2');
  await expect(viaDOM(page)).rejects.toThrow(/Timeout/);
  const page2 = await page.context().newPage();
  await page2.goto(server.url + '/?v=2');
  expect((await viaWebMCP(page2)).ok).toBe(true);
});

test('tools registered after load are missing on an immediate read and appear when polled', async ({ page }) => {
  await page.goto(server.url + '/?late=300');
  expect(await page.webmcp.tools()).toHaveLength(0);
  await expect.poll(async () => (await page.webmcp.tools()).length, { timeout: 5000 }).toBe(7);
});

test('the browser does not validate input against the tool schema', async ({ page }) => {
  await page.goto(server.url);
  const call = input => page.webmcp.callTool('echo_qty', input).then(r => JSON.parse(r.content[0].text));
  expect(await call({ qty: '3' })).toMatchObject({ type: 'string' });
  expect(await call({ qty: 0 })).toMatchObject({ value: 0 });
  expect(await call({})).toMatchObject({ type: 'undefined' });
});

test('failure modes: unknown tool and hanging tool throw, page-side errors come back as isError', async ({ page }) => {
  await page.goto(server.url);
  await expect(page.webmcp.callTool('nope', {})).rejects.toThrow(/No WebMCP tool named "nope"/);
  await expect(page.webmcp.callTool('hang', {}, { timeout: 300 })).rejects.toThrow(/Timeout 300ms/);
  await expect(page.webmcp.callTool('boom', {})).rejects.toThrow(/Tool execution failed/);
  const r = await page.webmcp.callTool('add_to_cart', { sku: 'NOPE', qty: 1 });
  expect(r.isError).toBe(true);
});
