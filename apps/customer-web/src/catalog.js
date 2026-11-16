export const catalog = [
  { id: "jacket-001", name: { ar: "جاكيت يومي", en: "Everyday jacket" }, category: "fashion", priceMinor: 18900, currency: "SAR", icon: "🧥", description: { ar: "تصميم عملي للاستخدام اليومي", en: "A versatile layer for everyday wear" } },
  { id: "bag-001", name: { ar: "حقيبة كتف", en: "Shoulder bag" }, category: "accessories", priceMinor: 12900, currency: "SAR", icon: "👜", description: { ar: "مساحة منظمة لمستلزماتك", en: "A compact everyday carry" } },
  { id: "sneakers-001", name: { ar: "حذاء رياضي", en: "Everyday sneakers" }, category: "shoes", priceMinor: 24900, currency: "SAR", icon: "👟", description: { ar: "راحة تناسب الحركة اليومية", en: "Comfort built for daily movement" } },
  { id: "abaya-001", name: { ar: "عباية كلاسيكية", en: "Classic abaya" }, category: "fashion", priceMinor: 21900, currency: "SAR", icon: "🧵", description: { ar: "قصة انسيابية بتفاصيل بسيطة", en: "A clean silhouette with simple details" } }
];

export function formatPrice(priceMinor, currency = "SAR", locale = "ar-SA") {
  if (!Number.isSafeInteger(priceMinor) || priceMinor < 0) throw new RangeError("priceMinor must be a non-negative safe integer");
  const fractionDigits = new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(priceMinor / (10 ** fractionDigits));
}

export function normalizePublishedProducts(payload) {
  if (!payload || !Array.isArray(payload.products)) throw new TypeError("Invalid published catalog response");
  return payload.products.flatMap((product) => {
    if (!product || typeof product.id !== "string" || typeof product.title !== "string" || !Array.isArray(product.variants)) return [];
    return product.variants.filter((variant) => variant && variant.inStock === true && typeof variant.id === "string")
      .map((variant) => {
        const currency = variant.currency ?? product.currency;
        const rawPriceMinor = variant.priceMinor ?? product.priceMinor;
        const priceMinor = typeof rawPriceMinor === "string" && /^\d+$/.test(rawPriceMinor) ? Number(rawPriceMinor) : rawPriceMinor;
        if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency) || !Number.isSafeInteger(priceMinor) || priceMinor < 0) return null;
        const labels = [variant.sizeLabel, variant.colorLabel].filter((value) => typeof value === "string" && value.trim());
        const imageUrl = Array.isArray(product.imageUrls) ? product.imageUrls.find((url) => typeof url === "string" && /^https:\/\//i.test(url)) : undefined;
        const description = typeof product.description === "string" ? product.description : "";
        return { id: variant.id, productId: product.id, name: { ar: product.title, en: product.title }, category: "all",
          priceMinor, currency, icon: "🛍️", description: { ar: description, en: description },
          ...(labels.length ? { variantLabel: labels.join(" · ") } : {}), ...(imageUrl ? { imageUrl } : {}) };
      }).filter(Boolean);
  });
}

export function addToCart(cart, productId, quantity = 1, products = catalog) {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new RangeError("quantity must be a positive integer");
  const product = products.find((item) => item.id === productId);
  if (!product) throw new Error("Unknown product");
  const next = new Map(cart);
  next.set(productId, (next.get(productId) ?? 0) + quantity);
  return next;
}

export function updateCartQuantity(cart, productId, quantity, products = catalog) {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new RangeError("quantity must be a non-negative integer");
  if (!products.some((item) => item.id === productId)) throw new Error("Unknown product");
  const next = new Map(cart);
  if (quantity === 0) next.delete(productId);
  else next.set(productId, quantity);
  return next;
}

export function cartSubtotal(cart, products = catalog) {
  let total = 0;
  for (const [productId, quantity] of cart) {
    const product = products.find((item) => item.id === productId);
    if (!product) throw new Error("Unknown product");
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new RangeError("Invalid cart quantity");
    total += product.priceMinor * quantity;
    if (!Number.isSafeInteger(total)) throw new RangeError("Cart total exceeds safe integer range");
  }
  return total;
}

export function serializeCart(cart) {
  const entries = [...cart.entries()];
  for (const [productId, quantity] of entries) {
    if (typeof productId !== "string" || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw new TypeError("Cart contains an invalid entry");
    }
  }
  return JSON.stringify(entries);
}

export function restoreCart(serialized, products = catalog) {
  if (typeof serialized !== "string") return new Map();
  let entries;
  try { entries = JSON.parse(serialized); } catch { return new Map(); }
  if (!Array.isArray(entries)) return new Map();
  const available = new Set(products.map((product) => product.id));
  const restored = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [productId, quantity] = entry;
    if (typeof productId !== "string" || !available.has(productId) ||
        !Number.isSafeInteger(quantity) || quantity < 1 || restored.has(productId)) continue;
    restored.set(productId, quantity);
  }
  return restored;
}
