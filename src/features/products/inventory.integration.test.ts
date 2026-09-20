import { expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import {
  countAllProducts, getProduct, getProductsByIds, listAllProducts,
  listProducts, lowStockProducts,
} from './db';
import { productsInCategory, productsInSharedCategories, relatedProducts } from '../categories/db';
import { searchProducts } from './search';
import { parseProductFilters, productFilterClause } from './filter';
import { orderByClause } from './sort';

it('uses active variant stock for listings, filters, sorting, and dashboard alerts', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    compatibilityDate: '2026-07-20',
    d1Databases: ['DB'],
  });
  try {
    const db = await mf.getD1Database('DB');
    for (const sql of [
      'CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, stock INTEGER, active INTEGER DEFAULT 1, created_at TEXT)',
      'CREATE TABLE product_variants (product_id INTEGER, stock INTEGER, active INTEGER DEFAULT 1)',
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT)',
      'CREATE TABLE order_items (order_id INTEGER, product_id INTEGER, quantity INTEGER)',
      'CREATE TABLE categories (id INTEGER PRIMARY KEY, parent_id INTEGER)',
      'CREATE TABLE product_categories (product_id INTEGER, category_id INTEGER)',
      'CREATE VIRTUAL TABLE products_fts USING fts5(name)',
      "INSERT INTO products (id, name, stock, created_at) VALUES (1, 'Wallet leather', 0, '2026-01-01'), (2, 'Wallet sold', 99, '2026-01-02'), (3, 'Wallet plain', 8, '2026-01-03'), (4, 'Wallet inactive variants', 2, '2026-01-04')",
      'INSERT INTO product_variants VALUES (1, 3, 1), (1, 2, 1), (1, 99, 0), (2, 0, 1), (4, 20, 0)',
      'INSERT INTO categories VALUES (1, NULL)',
      'INSERT INTO product_categories SELECT id, 1 FROM products',
      'INSERT INTO products_fts(rowid, name) SELECT id, name FROM products',
    ]) await db.exec(sql);

    const stockById = (rows: { id: number; stock: number }[]) =>
      Object.fromEntries(rows.map((row) => [row.id, row.stock]));
    const expected = { 1: 5, 2: 0, 3: 8, 4: 2 };
    expect(stockById(await listProducts(db, 10))).toEqual(expected);
    expect(stockById(await searchProducts(db, 'wallet'))).toEqual(expected);
    expect(stockById(await productsInCategory(db, 1, 10))).toEqual(expected);
    expect(stockById(await getProductsByIds(db, [1, 2, 3, 4]))).toEqual(expected);
    expect(stockById(await relatedProducts(db, 3))).toEqual({ 1: 5, 2: 0, 4: 2 });
    expect(stockById(await productsInSharedCategories(db, [3], 10))).toEqual({ 1: 5, 2: 0, 4: 2 });

    const sorted = await listAllProducts(db, 10, 0, orderByClause('stock', 'asc'));
    expect(sorted.map((row) => row.id)).toEqual([2, 4, 1, 3]);
    expect(stockById(sorted)).toEqual(expected);
    expect((await lowStockProducts(db, 5)).map((row) => row.id)).toEqual([2, 4, 1]);
    for (const [stock, ids] of [['out', [2]], ['low', [1, 4]], ['in', [3]]] as const) {
      const filter = productFilterClause(parseProductFilters(new URLSearchParams({ stock })));
      expect(await countAllProducts(db, filter)).toBe(ids.length);
      expect((await listAllProducts(db, 10, 0, 'id ASC', filter)).map((row) => row.id)).toEqual(ids);
      expect((await listAllProducts(db, 1, 0, 'id ASC', filter)).map((row) => row.id)).toEqual(ids.slice(0, 1));
    }
    // Editing and checkout still read the stored base stock, never a summary.
    expect((await getProduct(db, 1))?.stock).toBe(0);
  } finally {
    await mf.dispose();
  }
});
