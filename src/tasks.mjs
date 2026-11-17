// The same shopping task done two ways. Every function returns { ok, steps, total } where
// steps counts the protocol calls an agent would have to make (tool calls or DOM actions).

export const EXPECTED_TOTAL = 2 * 12 + 1 * 30; // 2 x Enamel mug + 1 x Desk lamp = 54

export async function viaWebMCP(page) {
  let steps = 0;
  const tools = await page.webmcp.tools(); steps++;
  const names = new Set(tools.map(t => t.name));
  for (const n of ['search_products', 'add_to_cart', 'get_cart']) if (!names.has(n)) throw new Error('tool missing: ' + n);
  const parse = r => JSON.parse(r.content[0].text);
  const found = parse(await page.webmcp.callTool('search_products', { query: 'enamel' })); steps++;
  await page.webmcp.callTool('add_to_cart', { sku: found[0].sku, qty: 2 }); steps++;
  const lamp = parse(await page.webmcp.callTool('search_products', { query: 'lamp' })); steps++;
  await page.webmcp.callTool('add_to_cart', { sku: lamp[0].sku, qty: 1 }); steps++;
  const cart = parse(await page.webmcp.callTool('get_cart', {})); steps++;
  return { ok: cart.total === EXPECTED_TOTAL, steps, total: cart.total };
}

// Selectors are written once against UI variant 1, like a normal test suite.
export async function viaDOM(page) {
  let steps = 0;
  const t = id => page.getByTestId(id);
  const opts = { timeout: 1000 };
  await t('search-input').fill('enamel', opts); steps++;
  await t('search-btn').click(opts); steps++;
  await t('qty-SKU-2').fill('2', opts); steps++;
  await t('add-SKU-2').click(opts); steps++;
  await t('search-input').fill('lamp', opts); steps++;
  await t('search-btn').click(opts); steps++;
  await t('add-SKU-4').click(opts); steps++;
  const total = Number(await t('cart-total').textContent(opts)); steps++;
  return { ok: total === EXPECTED_TOTAL, steps, total };
}
