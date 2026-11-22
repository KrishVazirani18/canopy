import { readFile } from 'node:fs/promises';

export async function loadOrders() {
  const text = await readFile(new URL('../data/orders.json', import.meta.url), 'utf8');
  return JSON.parse(text).orders;
}
