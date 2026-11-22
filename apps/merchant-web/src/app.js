import { createMerchantApi, MerchantApiError } from "./api.js";

let api = null;
let visibleCode = null;
let hideTimer = null;
const $ = selector => document.querySelector(selector);
const form = $("#issue-form");
const result = $("#code-result");
const status = $("#status");
const copy = {
  ar: {
    title:"بوابة التاجر", subtitle:"إصدار رمز استلام آمن لمهمة المندوب",
    connect:"جلسة التاجر", api:"رابط API", token:"رمز جلسة التاجر",
    session:"لا نحفظ رمز الجلسة أو بيانات الطلب في المتصفح. استخدم جلسة موظف مخوّل.",
    connectButton:"تفعيل الجلسة", disconnect:"إنهاء الجلسة", scope:"بيانات الطلب",
    merchant:"معرّف التاجر", branch:"معرّف الفرع", order:"معرّف الطلب",
    suborder:"معرّف طلب المتجر", task:"معرّف مهمة المندوب",
    issue:"إصدار رمز الاستلام", wait:"جارٍ إصدار الرمز…",
    noSession:"فعّل جلسة التاجر أولاً.", issued:"تم إصدار الرمز. اعرضه لموظف التسليم فقط.",
    expires:"ينتهي الرمز في", copy:"نسخ الرمز", copied:"تم نسخ الرمز",
    hidden:"أُخفي الرمز من الشاشة. إذا لم تحفظه، أصدر رمزاً جديداً لإلغاء السابق.",
    errors:{
      invalid_pickup_code_scope:"تحقق من معرّفات التاجر والفرع والطلب والمهمة.",
      invalid_merchant_session_token:"رمز الجلسة غير صالح.",
      pickup_code_issuance_unavailable:"خدمة إصدار الرمز غير متاحة حالياً.",
      merchant_role_required:"حسابك لا يملك صلاحية إصدار الرمز.",
      merchant_not_found:"لم يتم العثور على التاجر.",
      courier_task_not_found:"لم يتم العثور على مهمة المندوب ضمن هذا الطلب.",
      suborder_or_task_not_ready:"الطلب أو مهمة المندوب ليست جاهزة لإصدار الرمز.",
      forbidden:"ليست لديك صلاحية لهذا الفرع أو الطلب.",
      unauthenticated:"انتهت الجلسة أو أنها غير صالحة.",
      failed:"تعذر إصدار الرمز. تحقق من البيانات وحاول مجدداً."
    },
    language:"English"
  },
  en: {
    title:"Merchant portal", subtitle:"Issue a secure pickup code for a courier task",
    connect:"Merchant session", api:"API URL", token:"Merchant session token",
    session:"Session tokens and order details are not stored in the browser. Use an authorized merchant staff session.",
    connectButton:"Activate session", disconnect:"End session", scope:"Order details",
    merchant:"Merchant ID", branch:"Branch ID", order:"Order ID",
    suborder:"Merchant suborder ID", task:"Courier task ID",
    issue:"Issue pickup code", wait:"Issuing code…",
    noSession:"Activate a merchant session first.", issued:"Code issued. Show it only to authorized handover staff.",
    expires:"Code expires at", copy:"Copy code", copied:"Code copied",
    hidden:"The code was hidden. If it was not recorded, issue a replacement to revoke the previous code.",
    errors:{
      invalid_pickup_code_scope:"Check the merchant, branch, order, suborder and task IDs.",
      invalid_merchant_session_token:"The session token is invalid.",
      pickup_code_issuance_unavailable:"Pickup-code issuance is unavailable.",
      merchant_role_required:"Your account is not allowed to issue pickup codes.",
      merchant_not_found:"Merchant not found.",
      courier_task_not_found:"Courier task not found within this order.",
      suborder_or_task_not_ready:"The order or courier task is not ready for code issuance.",
      forbidden:"You are not authorized for this branch or order.",
      unauthenticated:"The session is expired or invalid.",
      failed:"Could not issue the code. Check the details and try again."
    },
    language:"العربية"
  }
};
let language = "ar";
const tr = key => copy[language][key] ?? key;
function notify(message, bad = false) {
  status.textContent = message;
  status.dataset.kind = bad ? "error" : "success";
  status.hidden = false;
}
function hideCode() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  visibleCode = null;
  result.hidden = true;
  $("#pickup-code").textContent = "";
}
function setConnected(connected) {
  $("#connection-state").textContent = connected
    ? (language === "ar" ? "الجلسة مفعّلة" : "Session active")
    : (language === "ar" ? "غير متصل" : "Not connected");
  $("#connect-button").hidden = connected;
  $("#disconnect-button").hidden = !connected;
  form.querySelectorAll("input,button").forEach(node => { node.disabled = !connected; });
  if (connected) $("#issue-button").disabled = false;
}
$("#language-toggle").addEventListener("click", () => {
  language = language === "ar" ? "en" : "ar";
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  document.querySelectorAll("[data-copy]").forEach(node => { node.textContent = tr(node.dataset.copy); });
  $("#language-toggle").textContent = tr("language");
  $("#connection-state").textContent = api
    ? (language === "ar" ? "الجلسة مفعّلة" : "Session active")
    : (language === "ar" ? "غير متصل" : "Not connected");
});
$("#connect-form").addEventListener("submit", event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    api = createMerchantApi({
      baseUrl: String(data.get("baseUrl") ?? "").trim(),
      token: String(data.get("token") ?? "").trim()
    });
    $("#session-token").value = "";
    setConnected(true);
    notify(language === "ar" ? "تم تفعيل الجلسة في ذاكرة الصفحة فقط." : "Session activated in page memory only.");
  } catch (error) {
    api = null;
    setConnected(false);
    notify(tr(error.message) || tr("errors").failed, true);
  }
});
$("#disconnect-button").addEventListener("click", () => {
  api = null;
  hideCode();
  $("#connect-form").reset();
  setConnected(false);
  status.hidden = true;
});
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!api) { notify(tr("noSession"), true); return; }
  const data = new FormData(form);
  const input = Object.fromEntries(["merchantId","branchId","orderId","suborderId","taskId"]
    .map(key => [key, String(data.get(key) ?? "").trim()]));
  const button = $("#issue-button");
  button.disabled = true;
  button.textContent = tr("wait");
  hideCode();
  status.hidden = true;
  try {
    const issued = await api.issuePickupCode(input);
    visibleCode = issued.code;
    $("#pickup-code").textContent = issued.code;
    $("#expiry").textContent = `${tr("expires")}: ${new Date(issued.expiresAtUtc).toLocaleString(language === "ar" ? "ar-SA" : "en")}`;
    result.hidden = false;
    notify(tr("issued"));
    hideTimer = setTimeout(() => {
      if (visibleCode === issued.code) {
        hideCode();
        notify(tr("hidden"));
      }
    }, 60_000);
  } catch (error) {
    const message = error instanceof MerchantApiError ? tr(error.message) : tr(error.message);
    notify(message || tr("errors").failed, true);
  } finally {
    button.disabled = false;
    button.textContent = tr("issue");
  }
});
$("#copy-code").addEventListener("click", async () => {
  if (!visibleCode) return;
  try {
    await navigator.clipboard.writeText(visibleCode);
    notify(tr("copied"));
  } catch {
    notify(language === "ar" ? "تعذر النسخ؛ انسخ الرمز يدوياً." : "Copy unavailable; copy the code manually.", true);
  }
});
setConnected(false);
