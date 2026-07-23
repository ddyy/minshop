-- seed-demo.sql — 30 demo products across 6 categories (no images — they show the placeholder).
-- Local dev demo data (separate from seed.sql). Re-runnable: every insert is
-- guarded so a second run is a no-op. Add product images later in Admin → Products.
--   wrangler d1 execute minshop-db --local --file=./seed-demo.sql

-- ── Categories ───────────────────────────────────────────────────────────────
INSERT INTO categories (name, slug) SELECT 'Apparel','apparel'         WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug='apparel');
INSERT INTO categories (name, slug) SELECT 'Kitchen','kitchen'         WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug='kitchen');
INSERT INTO categories (name, slug) SELECT 'Outdoors','outdoors'       WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug='outdoors');
INSERT INTO categories (name, slug) SELECT 'Electronics','electronics' WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug='electronics');
INSERT INTO categories (name, slug) SELECT 'Home & Living','home'      WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug='home');
INSERT INTO categories (name, slug) SELECT 'Stationery','stationery'   WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug='stationery');

-- ── Products (no images — Admin → Products can add them) ────────────────────
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Merino Wool Beanie','merino-wool-beanie','A soft, warm merino wool beanie that holds its shape.',3200,60
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='merino-wool-beanie');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Canvas Tote Bag','canvas-tote-bag','Heavyweight cotton canvas tote with reinforced straps.',2400,120
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='canvas-tote-bag');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Organic Cotton Tee','organic-cotton-tee','A breathable organic cotton t-shirt with a relaxed fit.',2800,90
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='organic-cotton-tee');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Linen Button-Up Shirt','linen-button-up-shirt','Lightweight linen shirt for warm days.',6800,40
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='linen-button-up-shirt');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Wool Crew Socks (3-Pack)','wool-crew-socks','Cushioned merino crew socks, three pairs.',2200,150
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='wool-crew-socks');

INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Cast Iron Skillet','cast-iron-skillet','Pre-seasoned 10-inch cast iron skillet.',4500,35
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='cast-iron-skillet');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Ceramic Pour-Over Coffee Set','pour-over-coffee-set','Ceramic dripper and carafe for pour-over coffee.',5400,25
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='pour-over-coffee-set');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Acacia Wood Cutting Board','acacia-cutting-board','End-grain acacia board that''s kind to knives.',3800,50
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='acacia-cutting-board');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Stainless Steel French Press','stainless-french-press','Double-wall steel French press, keeps coffee hot.',4200,30
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='stainless-french-press');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Matte Black Flatware Set','matte-flatware-set','16-piece matte black stainless flatware set.',7600,20
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='matte-flatware-set');

INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Insulated Water Bottle','insulated-water-bottle','Vacuum-insulated bottle: cold 24h, hot 12h.',3400,100
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='insulated-water-bottle');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Packable Down Jacket','packable-down-jacket','Ultralight down jacket that packs into its pocket.',12900,28
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='packable-down-jacket');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Trail Daypack 20L','trail-daypack','20-liter daypack with a hydration sleeve.',8900,22
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='trail-daypack');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Enamel Camp Mug','enamel-camp-mug','Classic speckled enamel mug for the trail.',1600,200
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='enamel-camp-mug');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Merino Hiking Socks','merino-hiking-socks','Cushioned merino hiking socks, blister-resistant.',2600,80
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='merino-hiking-socks');

INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Wireless Earbuds','wireless-earbuds','True wireless earbuds with a charging case.',9900,45
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='wireless-earbuds');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Bamboo Wireless Charger','bamboo-wireless-charger','Qi wireless charging pad with a bamboo top.',3900,60
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='bamboo-wireless-charger');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Mechanical Keyboard','mechanical-keyboard','Compact 75% mechanical keyboard, hot-swappable.',11900,18
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='mechanical-keyboard');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Portable Bluetooth Speaker','bluetooth-speaker','Pocket Bluetooth speaker, water-resistant.',7900,33
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='bluetooth-speaker');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'USB-C Desk Hub','usb-c-desk-hub','7-in-1 USB-C hub for laptops.',4900,40
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='usb-c-desk-hub');

INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Linen Throw Blanket','linen-throw-blanket','Stonewashed linen throw for the sofa.',7200,30
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='linen-throw-blanket');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Ceramic Table Lamp','ceramic-table-lamp','Hand-glazed ceramic lamp with a linen shade.',8800,15
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='ceramic-table-lamp');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Scented Soy Candle','soy-candle','Hand-poured soy candle, cedar and amber.',2400,110
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='soy-candle');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Woven Seagrass Basket','seagrass-basket','Handwoven seagrass storage basket.',4400,25
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='seagrass-basket');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Stoneware Plant Pot','stoneware-plant-pot','Matte stoneware planter with drainage.',2900,70
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='stoneware-plant-pot');

INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Leather Bound Notebook','leather-notebook','Full-grain leather notebook, refillable.',2800,90
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='leather-notebook');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Brass Fountain Pen','brass-fountain-pen','Solid brass fountain pen with a fine nib.',5800,35
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='brass-fountain-pen');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Recycled Sticky Notes Set','sticky-notes-set','Recycled paper sticky notes, six pads.',1200,200
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='sticky-notes-set');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Walnut Desk Organizer','walnut-desk-organizer','Walnut organizer for pens and clips.',5200,24
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='walnut-desk-organizer');
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Linen Hardcover Journal','linen-hardcover-journal','Linen-wrapped hardcover journal, dotted pages.',3400,65
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug='linen-hardcover-journal');

-- ── Product ↔ category links ─────────────────────────────────────────────────
INSERT INTO product_categories (product_id, category_id)
SELECT p.id, c.id FROM products p JOIN categories c
WHERE c.slug = CASE p.slug
  WHEN 'merino-wool-beanie' THEN 'apparel'   WHEN 'canvas-tote-bag' THEN 'apparel'
  WHEN 'organic-cotton-tee' THEN 'apparel'   WHEN 'linen-button-up-shirt' THEN 'apparel'
  WHEN 'wool-crew-socks' THEN 'apparel'
  WHEN 'cast-iron-skillet' THEN 'kitchen'    WHEN 'pour-over-coffee-set' THEN 'kitchen'
  WHEN 'acacia-cutting-board' THEN 'kitchen' WHEN 'stainless-french-press' THEN 'kitchen'
  WHEN 'matte-flatware-set' THEN 'kitchen'
  WHEN 'insulated-water-bottle' THEN 'outdoors' WHEN 'packable-down-jacket' THEN 'outdoors'
  WHEN 'trail-daypack' THEN 'outdoors'       WHEN 'enamel-camp-mug' THEN 'outdoors'
  WHEN 'merino-hiking-socks' THEN 'outdoors'
  WHEN 'wireless-earbuds' THEN 'electronics' WHEN 'bamboo-wireless-charger' THEN 'electronics'
  WHEN 'mechanical-keyboard' THEN 'electronics' WHEN 'bluetooth-speaker' THEN 'electronics'
  WHEN 'usb-c-desk-hub' THEN 'electronics'
  WHEN 'linen-throw-blanket' THEN 'home'     WHEN 'ceramic-table-lamp' THEN 'home'
  WHEN 'soy-candle' THEN 'home'              WHEN 'seagrass-basket' THEN 'home'
  WHEN 'stoneware-plant-pot' THEN 'home'
  WHEN 'leather-notebook' THEN 'stationery'  WHEN 'brass-fountain-pen' THEN 'stationery'
  WHEN 'sticky-notes-set' THEN 'stationery'  WHEN 'walnut-desk-organizer' THEN 'stationery'
  WHEN 'linen-hardcover-journal' THEN 'stationery'
END
AND NOT EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = c.id);

