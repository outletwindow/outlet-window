export const catalog = [
  { id: "jacket-001", name: { ar: "جاكيت يومي", en: "Everyday jacket" }, category: "fashion", priceMinor: 18900, currency: "SAR", icon: "🧥", description: { ar: "تصميم عملي للاستخدام اليومي", en: "A versatile layer for everyday wear" } },
  { id: "bag-001", name: { ar: "حقيبة كتف", en: "Shoulder bag" }, category: "accessories", priceMinor: 12900, currency: "SAR", icon: "👜", description: { ar: "مساحة منظمة لمستلزماتك", en: "A compact everyday carry" } },
  { id: "sneakers-001", name: { ar: "حذاء رياضي", en: "Everyday sneakers" }, category: "shoes", priceMinor: 24900, currency: "SAR", icon: "👟", description: { ar: "راحة تناسب الحركة اليومية", en: "Comfort built for daily movement" } },
  { id: "abaya-001", name: { ar: "عباية كلاسيكية", en: "Classic abaya" }, category: "fashion", priceMinor: 21900, currency: "SAR", icon: "🧵", description: { ar: "قصة انسيابية بتفاصيل بسيطة", en: "A clean silhouette with simple details" } }
];

export function formatPrice(priceMinor, currency = "SAR", locale = "ar-SA") {
  if (!Number.isSafeInteger(priceMinor) || priceMinor < 0) throw new RangeError("priceMinor must be a non-negative safe integer");
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(priceMinor / 100);
}

export function addToCart(cart, productId, quantity = 1) {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new RangeError("quantity must be a positive integer");
  const product = catalog.find((item) => item.id === productId);
  if (!product) throw new Error("Unknown product");
  const next = new Map(cart);
  next.set(productId, (next.get(productId) ?? 0) + quantity);
  return next;
}

export function updateCartQuantity(cart, productId, quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new RangeError("quantity must be a non-negative integer");
  if (!catalog.some((item) => item.id === productId)) throw new Error("Unknown product");
  const next = new Map(cart);
  if (quantity === 0) next.delete(productId);
  else next.set(productId, quantity);
  return next;
}

export function cartSubtotal(cart) {
  let total = 0;
  for (const [productId, quantity] of cart) {
    const product = catalog.find((item) => item.id === productId);
    if (!product) throw new Error("Unknown product");
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new RangeError("Invalid cart quantity");
    total += product.priceMinor * quantity;
    if (!Number.isSafeInteger(total)) throw new RangeError("Cart total exceeds safe integer range");
  }
  return total;
}
