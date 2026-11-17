import { createCourierApi, CourierApiError } from "./api.js";
import { getTaskGroups, getNextTaskAction } from "./tasks.js";

const translations = {
  ar: {
    role:"تطبيق المندوب", greeting:"أهلاً بك في Outlet Window", subtitle:"مهام التوصيل الخاصة بك في مكان واحد",
    available:"متصل بالخدمة", today:"ملخص المهام", completed:"طلبات مكتملة", earnings:"الأرباح",
    pickup:"الاستلام", dropoff:"التسليم", order:"الطلب", suborder:"الطلب الفرعي", accept:"قبول المهمة", decline:"رفض المهمة",
    offers:"المهام المتاحة", active:"مهامي الحالية", history:"السجل",
    noOffers:"لا توجد مهام متاحة", noActive:"لا توجد مهام نشطة", noHistory:"لا يوجد سجل توصيل",
    connectTitle:"اتصال حساب المندوب", tokenLabel:"رمز جلسة المندوب", connect:"اتصال وجلب المهام",
    disconnect:"قطع الاتصال", loading:"جارٍ الاتصال...", refresh:"تحديث المهام",
    connected:"تم الاتصال وجلب المهام", disconnected:"تم قطع الاتصال",
    connectionRequired:"أدخل رمز جلسة صالحاً للاتصال", failed:"تعذر تنفيذ الطلب",
    accepted:"تم قبول المهمة", declined:"تم رفض المهمة", declineReason:"اكتب سبب رفض المهمة",
    toStore:"بدء التوجه إلى المتجر", atStore:"تأكيد الوصول إلى المتجر",
    collect:"استلام الطلب برمز التحقق", toCustomer:"بدء التوجه إلى العميل",
    atCustomer:"تأكيد الوصول إلى العميل", pickupCode:"أدخل رمز الاستلام لمرة واحدة",
    pickupCodeRequired:"رمز الاستلام مطلوب", versionConflict:"تغيرت المهمة؛ حدّث القائمة وحاول مجدداً",
    proofPending:"لا يمكن إتمام التسليم قبل رفع صورة والتحقق منها", uploadProof:"رفع الإثبات وإتمام التسليم", selectProof:"اختر صورة إثبات التسليم",
    sessionNote:"رمز الجلسة يبقى في ذاكرة الصفحة فقط ولا يُحفظ على الجهاز",
    notConnected:"غير متصل", status:{offered:"متاحة",accepted:"تم القبول",heading_to_pickup:"في الطريق للمتجر",
      arrived_at_pickup:"وصل للمتجر",picked_up:"تم الاستلام",in_transit:"في الطريق للعميل",
      arrived_at_dropoff:"وصل للعميل",delivered:"تم التسليم",declined:"مرفوضة",
      cancelled:"ملغاة",failed:"تعذّر التنفيذ",in_progress:"قيد التنفيذ",completed:"مكتملة"},
    language:"English"
  },
  en: {
    role:"Courier app", greeting:"Welcome to Outlet Window", subtitle:"Your delivery tasks in one place",
    available:"Connected", today:"Task summary", completed:"Completed orders", earnings:"Earnings",
    pickup:"Pickup", dropoff:"Drop-off", order:"Order", suborder:"Suborder", accept:"Accept task", decline:"Decline task",
    offers:"Available tasks", active:"My active tasks", history:"History",
    noOffers:"No available tasks", noActive:"No active tasks", noHistory:"No delivery history",
    connectTitle:"Courier account connection", tokenLabel:"Courier session token", connect:"Connect and load tasks",
    disconnect:"Disconnect", loading:"Connecting...", refresh:"Refresh tasks",
    connected:"Connected and tasks loaded", disconnected:"Disconnected",
    connectionRequired:"Enter a valid session token to connect", failed:"Request could not be completed",
    accepted:"Task accepted", declined:"Task declined", declineReason:"Enter a reason for declining",
    toStore:"Start heading to store", atStore:"Confirm arrival at store",
    collect:"Collect using verification code", toCustomer:"Start heading to customer",
    atCustomer:"Confirm arrival at customer", pickupCode:"Enter the single-use pickup code",
    pickupCodeRequired:"Pickup code is required", versionConflict:"Task changed; refresh and try again",
    proofPending:"Delivery cannot be completed until a proof image is uploaded and verified", uploadProof:"Upload proof and complete delivery", selectProof:"Choose delivery proof image",
    sessionNote:"The session token stays in page memory only and is not saved on this device",
    notConnected:"Not connected", status:{offered:"Available",accepted:"Accepted",heading_to_pickup:"Heading to store",
      arrived_at_pickup:"Arrived at store",picked_up:"Picked up",in_transit:"In transit",
      arrived_at_dropoff:"Arrived at customer",delivered:"Delivered",declined:"Declined",
      cancelled:"Cancelled",failed:"Failed",in_progress:"In progress",completed:"Completed"},
    language:"العربية"
  }
};

let api = null;
let tasks = [];
let language = "ar";
let activeTab = "offers";
let busy = false;
const $ = selector => document.querySelector(selector);
const content = $("#task-list");
const toast = $("#toast");
const form = $("#connect-form");
const tokenInput = $("#session-token");
const connectionState = $("#connection-state");

function t(key) { return translations[language][key] ?? key; }
function notify(message) {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => { toast.hidden = true; }, 3000);
}
function setBusy(value) {
  busy = value;
  document.querySelectorAll("button").forEach(button => {
    if (button.dataset.keepEnabled !== "true") button.disabled = value;
  });
  $("#connect-button").textContent = value ? t("loading") : t("connect");
}
function statusText(status) { return t("status")[status] ?? status; }

function render() {
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  document.querySelectorAll("[data-copy]").forEach(node => { node.textContent = t(node.dataset.copy); });
  $("#language-toggle").textContent = t("language");
  $("#connection-state").textContent = api ? t("available") : t("notConnected");
  $("#disconnect-button").hidden = !api;
  $("#refresh-button").hidden = !api;
  $("#task-area").hidden = !api;
  document.querySelectorAll("[data-tab]").forEach(button =>
    button.classList.toggle("selected", button.dataset.tab === activeTab));
  const groups = getTaskGroups(tasks);
  const list = groups[activeTab] ?? [];
  content.replaceChildren();
  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = t(activeTab === "offers" ? "noOffers" : activeTab === "active" ? "noActive" : "noHistory");
    content.append(empty);
    return;
  }
  list.forEach(task => content.append(renderTask(task)));
}

function makeButton(label, action, taskId, className = "primary") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.action = action;
  button.dataset.id = taskId;
  button.textContent = t(label);
  return button;
}

function renderTask(task) {
  const card = document.createElement("article");
  card.className = "task-card";
  const header = document.createElement("div");
  header.className = "task-header";
  const id = document.createElement("strong");
  id.textContent = task.id;
  const status = document.createElement("span");
  status.className = "status";
  status.textContent = statusText(task.status);
  header.append(id, status);
  const details = document.createElement("div");
  details.className = "route";
  const order = document.createElement("p");
  order.textContent = `${t("order")}: ${task.orderId ?? task.suborderId ?? "—"}`;
  const tenant = document.createElement("p");
  tenant.textContent = `${t("suborder")}: ${task.suborderId ?? "—"}`;
  details.append(order, tenant);
  card.append(header, details);

  const actions = document.createElement("div");
  actions.className = "actions";
  if (task.status === "offered") {
    actions.append(makeButton("accept", "transition", task.id));
    actions.append(makeButton("decline", "decline", task.id, "secondary"));
  } else {
    const next = getNextTaskAction(task);
    if (next) actions.append(makeButton(next.label, "transition", task.id));
    if (task.status === "arrived_at_dropoff") {
      const proofInput = document.createElement("input");
      proofInput.type = "file";
      proofInput.accept = "image/jpeg,image/png,image/webp";
      proofInput.dataset.proofFile = task.id;
      proofInput.setAttribute("aria-label", t("selectProof"));
      const proofButton = makeButton("uploadProof", "proof", task.id);
      proofButton.disabled = true;
      proofInput.addEventListener("change", () => {
        proofButton.disabled = !proofInput.files?.[0];
      });
      actions.append(proofInput, proofButton);
      const note = document.createElement("p");
      note.className = "next-step";
      note.textContent = t("proofPending");
      card.append(note);
    }
  }
  if (actions.childElementCount) card.append(actions);
  return card;
}

async function loadTasks() {
  if (!api) return;
  const result = await api.listTasks();
  tasks = result;
  render();
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  const token = tokenInput.value.trim();
  try {
    setBusy(true);
    const configuredApiUrl = document.querySelector('meta[name="outlet-window-api-base-url"]')?.content?.trim() ?? "";
    api = createCourierApi({ baseUrl: configuredApiUrl, token });
    await loadTasks();
    tokenInput.value = "";
    connectionState.textContent = t("available");
    notify(t("connected"));
  } catch (error) {
    api = null;
    tasks = [];
    render();
    notify(error instanceof Error ? error.message : t("connectionRequired"));
  } finally {
    setBusy(false);
    render();
  }
});

$("#disconnect-button").addEventListener("click", () => {
  api = null;
  tasks = [];
  render();
  notify(t("disconnected"));
});

$("#refresh-button").addEventListener("click", async () => {
  if (!api || busy) return;
  try {
    setBusy(true);
    await loadTasks();
    notify(t("connected"));
  } catch (error) {
    notify(error instanceof Error ? error.message : t("failed"));
  } finally {
    setBusy(false);
    render();
  }
});

document.addEventListener("click", async event => {
  const tab = event.target.closest("[data-tab]");
  if (tab) { activeTab = tab.dataset.tab; render(); return; }
  const button = event.target.closest("button[data-action]");
  if (!button || !api || busy) return;
  const task = tasks.find(item => item.id === button.dataset.id);
  if (!task) return;

  if (button.dataset.action === "proof") {
    const proofInput = [...content.querySelectorAll("input[data-proof-file]")]
      .find(input => input.dataset.proofFile === task.id);
    const file = proofInput?.files?.[0];
    if (!file) { notify(t("selectProof")); return; }
    try {
      setBusy(true);
      await api.uploadDeliveryProof(task.id, file);
      await api.transitionTask(task.id, { status: "delivered", expectedVersion: task.version });
      await loadTasks();
      notify(t("status").delivered);
    } catch (error) {
      if (error instanceof CourierApiError && error.status === 409) notify(t("versionConflict"));
      else notify(error instanceof Error ? error.message : t("failed"));
    } finally {
      setBusy(false);
      render();
    }
    return;
  }

  let status;
  let extra = {};
  if (button.dataset.action === "decline") {
    const reason = window.prompt(t("declineReason"));
    if (!reason?.trim()) return;
    status = "declined";
    extra.reason = reason.trim();
  } else if (task.status === "offered") {
    status = "accepted";
  } else {
    const next = getNextTaskAction(task);
    if (!next) return;
    status = next.status;
    if (next.requiresPickupCode) {
      const pickupCode = window.prompt(t("pickupCode"));
      if (!pickupCode?.trim()) { notify(t("pickupCodeRequired")); return; }
      extra.pickupCode = pickupCode.trim();
    }
  }

  try {
    setBusy(true);
    await api.transitionTask(task.id, { status, expectedVersion: task.version, ...extra });
    await loadTasks();
    notify(t("status")[status] ?? status);
  } catch (error) {
    if (error instanceof CourierApiError && error.status === 409) notify(t("versionConflict"));
    else notify(error instanceof Error ? error.message : t("failed"));
  } finally {
    setBusy(false);
    render();
  }
});

$("#language-toggle").addEventListener("click", () => {
  language = language === "ar" ? "en" : "ar";
  render();
});
render();
