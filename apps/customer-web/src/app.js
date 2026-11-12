import { catalog as demoCatalog, formatPrice, addToCart, updateCartQuantity, cartSubtotal, normalizePublishedProducts } from "./catalog.js";

const copy = {
  ar: {
    brand: "Outlet Window", tagline: "اكتشف منتجات متاجر متعددة في تجربة واحدة",
    search: "ابحث عن منتج أو فئة...", categories: "تسوق حسب الفئة",
    all: "الكل", fashion: "الأزياء", accessories: "الإكسسوارات", shoes: "الأحذية",
    featured: "مختارات لك", add: "أضف للسلة", cart: "سلتك", empty: "سلتك فارغة حالياً",
    subtotal: "المجموع الفرعي", checkout: "متابعة إلى الدفع", demo: "واجهة تجريبية — المنتجات والأسعار للعرض فقط",
    notice: "لم يتم ربط تسجيل الدخول أو المخزون المباشر أو الدفع بعد.",
    loading: "جارٍ تحميل منتجات الفرع...", apiError: "تعذر تحميل منتجات الفرع. تحقق من إعدادات الاتصال وحاول مجدداً.",
    noProducts: "لا توجد منتجات منشورة ومتاحة في هذا الفرع حالياً.", live: "منتجات منشورة ومخزون الفرع",
    items: "منتجات", language: "English", remove: "إزالة", added: "أُضيف المنتج إلى السلة",
    checkoutNotice: "هذه نسخة تجريبية. لم يتم إرسال طلب أو تحصيل أي مبلغ."
  },
  en: {
    brand: "Outlet Window", tagline: "Discover products from multiple stores in one place",
    search: "Search products or categories...", categories: "Shop by category",
    all: "All", fashion: "Fashion", accessories: "Accessories", shoes: "Shoes",
    featured: "Picked for you", add: "Add to cart", cart: "Your cart", empty: "Your cart is empty",
    subtotal: "Subtotal", checkout: "Continue to payment", demo: "Demo interface — products and prices are illustrative",
    notice: "Sign-in and checkout are not connected yet.",
    loading: "Loading branch products...", apiError: "Could not load branch products. Check the connection settings and try again.",
    noProducts: "No published products are currently available at this branch.", live: "Published products and branch stock",
    items: "items", language: "العربية", remove: "Remove", added: "Added to cart",
    checkoutNotice: "This is a demo. No order was submitted and no payment was collected."
  }
};

let language = "ar";
let activeCategory = "all";
let searchTerm = "";
let catalog = demoCatalog;
let catalogMode = "demo";
let catalogLoading = false;
let catalogFailed = false;
let cart = new Map();

const $ = (selector) => document.querySelector(selector);
const productGrid = $("#product-grid");
const cartItems = $("#cart-items");
const cartCount = $("#cart-count");
const subtotal = $("#subtotal");
const cartPanel = $("#cart-panel");
const toast = $("#toast");

function t(key) { return copy[language][key]; }
function productName(product) { return product.name[language]; }
function productDescription(product) { return product.description?.[language] ?? ""; }

function renderShell() {
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  document.querySelectorAll("[data-copy]").forEach((node) => {
    node.textContent = t(node.dataset.copy);
  });
  $("#search").placeholder = t("search");
  $("#language-toggle").textContent = t("language");
  const banner = document.querySelector(".demo-banner span:last-child");
  if (banner) banner.textContent = catalogMode === "live" ? t("live") : t("demo");
  document.querySelectorAll("#category-list [data-category]").forEach((button) => {
    button.hidden = catalogMode === "live" && button.dataset.category !== "all";
  });
  renderProducts();
  renderCart();
}

function renderProducts() {
  productGrid.replaceChildren();
  if (catalogLoading) {
    const loading = document.createElement("p"); loading.className = "empty-state"; loading.textContent = t("loading"); productGrid.append(loading); return;
  }
  if (catalogFailed) {
    const error = document.createElement("p"); error.className = "empty-state"; error.textContent = t("apiError"); productGrid.append(error); return;
  }
  const visible = catalog.filter((product) => {
    const categoryMatches = activeCategory === "all" || product.category === activeCategory;
    const searchMatches = !searchTerm || productName(product).toLocaleLowerCase().includes(searchTerm);
    return categoryMatches && searchMatches;
  });

  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = language === "ar" ? "لا توجد منتجات مطابقة." : "No matching products.";
    productGrid.append(empty);
    return;
  }

  for (const product of visible) {
    const card = document.createElement("article");
    card.className = "product-card";
    const visual = document.createElement("div");
    visual.className = "product-visual";
    visual.setAttribute("aria-hidden", "true");
    if (product.imageUrl) {
      const image = document.createElement("img"); image.src = product.imageUrl; image.alt = productName(product); image.loading = "lazy"; image.referrerPolicy = "no-referrer"; visual.append(image);
    } else { visual.textContent = product.icon ?? "🛍️"; }
    const name = document.createElement("h3");
    name.textContent = productName(product);
    const description = document.createElement("p");
    description.className = "product-description";
    description.textContent = productDescription(product) || (product.variantLabel ?? "");
    const price = document.createElement("strong");
    price.className = "product-price";
    price.textContent = formatPrice(product.priceMinor, product.currency, language === "ar" ? "ar-SA" : "en-SA");
    const add = document.createElement("button");
    add.className = "add-button";
    add.type = "button";
    add.dataset.add = product.id;
    add.textContent = t("add");
    card.append(visual, name, description, price, add);
    productGrid.append(card);
  }
}

function renderCart() {
  cartItems.replaceChildren();
  const count = [...cart.values()].reduce((sum, quantity) => sum + quantity, 0);
  cartCount.textContent = String(count);
  subtotal.textContent = formatPrice(cartSubtotal(cart, catalog), "SAR", language === "ar" ? "ar-SA" : "en-SA");

  if (count === 0) {
    const empty = document.createElement("p");
    empty.className = "cart-empty";
    empty.textContent = t("empty");
    cartItems.append(empty);
    $("#checkout-button").disabled = true;
    return;
  }

  $("#checkout-button").disabled = false;
  for (const [productId, quantity] of cart) {
    const product = catalog.find((item) => item.id === productId);
    if (!product) continue;
    const row = document.createElement("div");
    row.className = "cart-row";
    const title = document.createElement("span");
    title.textContent = productName(product);
    const controls = document.createElement("div");
    controls.className = "quantity-controls";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.dataset.quantity = productId;
    minus.dataset.value = String(quantity - 1);
    minus.textContent = "−";
    minus.setAttribute("aria-label", language === "ar" ? "تقليل الكمية" : "Decrease quantity");
    const amount = document.createElement("span");
    amount.textContent = String(quantity);
    const plus = document.createElement("button");
    plus.type = "button";
    plus.dataset.quantity = productId;
    plus.dataset.value = String(quantity + 1);
    plus.textContent = "+";
    plus.setAttribute("aria-label", language === "ar" ? "زيادة الكمية" : "Increase quantity");
    controls.append(minus, amount, plus);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-button";
    remove.dataset.quantity = productId;
    remove.dataset.value = "0";
    remove.textContent = t("remove");
    row.append(title, controls, remove);
    cartItems.append(row);
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.hidden = true; }, 2200);
}

productGrid.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-add]");
  if (!button) return;
  cart = addToCart(cart, button.dataset.add, 1, catalog);
  renderCart();
  showToast(t("added"));
});

cartItems.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-quantity]");
  if (!button) return;
  cart = updateCartQuantity(cart, button.dataset.quantity, Number(button.dataset.value), catalog);
  renderCart();
});

$("#language-toggle").addEventListener("click", () => {
  language = language === "ar" ? "en" : "ar";
  renderShell();
});
$("#search").addEventListener("input", (event) => {
  searchTerm = event.target.value.trim().toLocaleLowerCase();
  renderProducts();
});
$("#category-list").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-category]");
  if (!button) return;
  activeCategory = button.dataset.category;
  document.querySelectorAll("[data-category]").forEach((item) => item.classList.toggle("selected", item === button));
  renderProducts();
});
$("#cart-toggle").addEventListener("click", () => {
  cartPanel.hidden = !cartPanel.hidden;
  $("#cart-toggle").setAttribute("aria-expanded", String(!cartPanel.hidden));
});
$("#cart-close").addEventListener("click", () => {
  cartPanel.hidden = true;
  $("#cart-toggle").setAttribute("aria-expanded", "false");
});
$("#checkout-button").addEventListener("click", () => showToast(t("checkoutNotice")));

async function loadBranchCatalog() {
  const config = document.body.dataset;
  const configured = Boolean(config.apiBaseUrl || config.merchantId || config.branchId);
  if (!configured) return;
  if (!config.apiBaseUrl || !config.merchantId || !config.branchId) { catalogFailed = true; catalogMode = "live"; renderShell(); return; }
  let endpoint;
  try {
    const base = new URL(config.apiBaseUrl, window.location.href);
    if (!["http:", "https:"].includes(base.protocol)) throw new Error("Unsupported API protocol");
    endpoint = new URL(`/api/v1/catalog/merchants/${encodeURIComponent(config.merchantId)}/branches/${encodeURIComponent(config.branchId)}/products?limit=100`, base);
  } catch { catalogFailed = true; catalogMode = "live"; renderShell(); return; }
  catalogMode = "live"; catalogLoading = true; renderShell();
  try {
    const response = await fetch(endpoint, { method: "GET", headers: { Accept: "application/json" }, credentials: "omit" });
    if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
    const payload = await response.json();
    catalog = normalizePublishedProducts(payload);
    catalogFailed = false;
  } catch {
    catalog = []; catalogFailed = true;
  } finally {
    catalogLoading = false; renderShell();
  }
}

renderShell();
void loadBranchCatalog();

renderShell();
