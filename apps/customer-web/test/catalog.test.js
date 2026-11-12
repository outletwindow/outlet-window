import test from "node:test";
import assert from "node:assert/strict";
import { catalog, addToCart, updateCartQuantity, cartSubtotal, formatPrice, normalizePublishedProducts } from "../src/catalog.js";

test("catalog uses unique product identifiers and valid minor-unit prices", () => {
  const ids = catalog.map((product) => product.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const product of catalog) {
    assert.ok(product.priceMinor > 0);
    assert.equal(product.currency, "SAR");
    assert.ok(product.name.ar && product.name.en);
  }
});

test("adding products accumulates quantities without mutating the original cart", () => {
  const empty = new Map();
  const first = addToCart(empty, "jacket-001");
  const second = addToCart(first, "jacket-001", 2);
  assert.equal(empty.size, 0);
  assert.equal(first.get("jacket-001"), 1);
  assert.equal(second.get("jacket-001"), 3);
});

test("cart quantity updates remove zero quantities and preserve other products", () => {
  const cart = addToCart(addToCart(new Map(), "bag-001", 1), "abaya-001", 2);
  const next = updateCartQuantity(cart, "bag-001", 0);
  assert.equal(next.has("bag-001"), false);
  assert.equal(next.get("abaya-001"), 2);
  assert.equal(cart.has("bag-001"), true);
});

test("subtotal is calculated in integer minor units", () => {
  const cart = addToCart(addToCart(new Map(), "jacket-001", 2), "bag-001", 1);
  assert.equal(cartSubtotal(cart), 18900 * 2 + 12900);
});

test("invalid product identifiers and quantities fail closed", () => {
  assert.throws(() => addToCart(new Map(), "unknown-product"), /Unknown product/);
  assert.throws(() => addToCart(new Map(), "jacket-001", 0), /positive integer/);
  assert.throws(() => updateCartQuantity(new Map(), "jacket-001", -1), /non-negative integer/);
  assert.throws(() => updateCartQuantity(new Map(), "unknown-product", 1), /Unknown product/);
});

test("price formatting rejects unsafe or negative minor-unit amounts", () => {
  assert.throws(() => formatPrice(-1), /non-negative safe integer/);
  assert.throws(() => formatPrice(Number.MAX_SAFE_INTEGER + 1), /non-negative safe integer/);
});

test("published API products normalize to purchasable in-stock variants only", () => {
  const products = normalizePublishedProducts({ products: [{
    id: "p-1", title: "Classic Shirt", description: "Cotton", currency: "SAR", priceMinor: 15000,
    imageUrls: ["https://cdn.example/shirt.jpg"],
    variants: [
      { id: "v-1", sizeLabel: "M", colorLabel: "Blue", inStock: true },
      { id: "v-2", sizeLabel: "L", colorLabel: "Blue", inStock: false },
      { id: "v-3", sizeLabel: "S", currency: "SAR", priceMinor: 0, inStock: true },
      { id: "v-4", sizeLabel: "XL", currency: "INVALID", priceMinor: 100, inStock: true }
    ]
  }] });
  assert.equal(products.length, 2);
  assert.deepEqual(products.map((product) => product.id), ["v-1", "v-3"]);
  assert.equal(products[0].variantLabel, "M · Blue");
  assert.equal(products[0].imageUrl, "https://cdn.example/shirt.jpg");
});

test("live variant cart uses variant-specific prices and rejects unknown variants", () => {
  const products = normalizePublishedProducts({ products: [{
    id: "p-1", title: "Shirt", currency: "SAR", priceMinor: 10000,
    variants: [
      { id: "v-small", sizeLabel: "S", currency: "SAR", priceMinor: 9000, inStock: true },
      { id: "v-large", sizeLabel: "L", currency: "SAR", priceMinor: 11000, inStock: true }
    ]
  }] });
  const cart = addToCart(new Map(), "v-small", 2, products);
  assert.equal(cartSubtotal(cart, products), 18000);
  assert.throws(() => addToCart(new Map(), "unknown", 1, products), /Unknown product/);
});

test("published catalog response rejects malformed payloads", () => {
  assert.throws(() => normalizePublishedProducts({ products: "invalid" }), /Invalid published catalog response/);
});

test("published catalog safely converts PostgreSQL bigint JSON strings", () => {
  const products = normalizePublishedProducts({ products: [{
    id: "p-bigint", title: "Coat", currency: "SAR", priceMinor: "18900",
    variants: [{ id: "v-bigint", inStock: true, priceMinor: "20500" }]
  }] });
  assert.equal(products.length, 1);
  assert.equal(products[0].priceMinor, 20500);
  assert.throws(() => normalizePublishedProducts({ products: [{
    id: "p-unsafe", title: "Unsafe", currency: "SAR", priceMinor: "999999999999999999999",
    variants: [{ id: "v-unsafe", inStock: true }]
  }] }).length === 0 ? (() => { throw new Error("unsafe amount rejected"); })() : null, /unsafe amount rejected/);
});
