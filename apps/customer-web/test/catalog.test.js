import test from "node:test";
import assert from "node:assert/strict";
import { catalog, addToCart, updateCartQuantity, cartSubtotal, formatPrice } from "../src/catalog.js";

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
