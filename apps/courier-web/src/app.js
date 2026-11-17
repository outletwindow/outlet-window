import { acceptTask, declineTask, getTaskGroups } from "./tasks.js";

const translations = {
  ar: {
    brand: "Outlet Window", role: "تطبيق المندوب", greeting: "مساء الخير، كابتن",
    subtitle: "كل مهامك وتفاصيل توصيلك في مكان واحد", available: "متاح لاستقبال المهام",
    today: "ملخص اليوم", completed: "طلبات مكتملة", earnings: "الأرباح التقديرية",
    distance: "المسافة", pickup: "الاستلام", dropoff: "التسليم", reward: "المكافأة",
    accept: "قبول المهمة", decline: "رفض", offers: "المهام المتاحة", active: "مهامي الحالية",
    history: "السجل", noOffers: "لا توجد مهام متاحة الآن", noActive: "ليس لديك مهام نشطة",
    noHistory: "لا يوجد سجل بعد", demo: "عرض تجريبي — لا توجد مهام حقيقية أو مشاركة موقع فعلية",
    sample: "مهمة تجريبية", accepted: "تم قبول المهمة في العرض التجريبي",
    declined: "تم رفض المهمة في العرض التجريبي", next: "الخطوة التالية",
    toStore: "التوجه إلى المتجر", collect: "استلام الطلب والتحقق منه",
    deliver: "التوجه إلى العميل", done: "إتمام التسليم بإثبات معتمد",
    language: "English", status: { offered: "متاحة", accepted: "تم القبول", heading_to_pickup: "في الطريق للمتجر", arrived_at_pickup: "وصل للمتجر", picked_up: "تم الاستلام", in_transit: "في الطريق للعميل", arrived_at_dropoff: "وصل للعميل", delivered: "تم التسليم", declined: "مرفوضة", cancelled: "ملغاة", failed: "تعذّر التنفيذ", in_progress: "قيد التنفيذ", completed: "مكتملة" }
  },
  en: {
    brand: "Outlet Window", role: "Courier app", greeting: "Good evening, Captain",
    subtitle: "Your delivery tasks and details in one place", available: "Available for tasks",
    today: "Today's summary", completed: "Completed orders", earnings: "Estimated earnings",
    distance: "Distance", pickup: "Pickup", dropoff: "Drop-off", reward: "Reward",
    accept: "Accept task", decline: "Decline", offers: "Available tasks", active: "My active tasks",
    history: "History", noOffers: "No tasks available right now", noActive: "You have no active tasks",
    noHistory: "No history yet", demo: "Demo preview — no real tasks or live location sharing",
    sample: "Demo task", accepted: "Task accepted in demo preview",
    declined: "Task declined in demo preview", next: "Next step",
    toStore: "Head to the store", collect: "Collect and verify the order",
    deliver: "Head to the customer", done: "Complete delivery with approved proof",
    language: "العربية", status: { offered: "Available", accepted: "Accepted", heading_to_pickup: "Heading to store", arrived_at_pickup: "Arrived at store", picked_up: "Picked up", in_transit: "In transit", arrived_at_dropoff: "Arrived at customer", delivered: "Delivered", declined: "Declined", cancelled: "Cancelled", failed: "Failed", in_progress: "In progress", completed: "Completed" }
  }
};

const initialTasks = [
  { id: "OW-D-2048", status: "offered", distance: "4.2 كم", reward: "٢٢ ر.س", store: "متجر الأناقة — فرع الكورنيش", destination: "حي الشاطئ، الدمام", items: 2, eta: "18 دقيقة" },
  { id: "OW-D-2051", status: "offered", distance: "6.8 كم", reward: "٣١ ر.س", store: "ركن الأحذية — فرع الفيصلية", destination: "حي النزهة، الدمام", items: 1, eta: "26 دقيقة" }
];

let tasks = initialTasks;
let language = "ar";
let activeTab = "offers";
const $ = (selector) => document.querySelector(selector);
const content = $("#task-list");
const toast = $("#toast");

function t(key) { return translations[language][key]; }
function notify(message) {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => { toast.hidden = true; }, 2400);
}

function render() {
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  document.querySelectorAll("[data-copy]").forEach((node) => { node.textContent = t(node.dataset.copy); });
  $("#language-toggle").textContent = t("language");
  document.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("selected", button.dataset.tab === activeTab));
  const groups = getTaskGroups(tasks);
  const list = groups[activeTab];
  content.replaceChildren();
  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = t(activeTab === "offers" ? "noOffers" : activeTab === "active" ? "noActive" : "noHistory");
    content.append(empty);
    return;
  }
  for (const task of list) content.append(renderTask(task));
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
  status.textContent = t("status")[task.status];
  header.append(id, status);
  const store = document.createElement("h3");
  store.textContent = task.store;
  const route = document.createElement("div");
  route.className = "route";
  route.innerHTML = `<div><span>●</span><section><small>${t("pickup")}</small><strong></strong></section></div><div><span>●</span><section><small>${t("dropoff")}</small><strong></strong></section></div>`;
  route.children[0].querySelector("strong").textContent = task.store;
  route.children[1].querySelector("strong").textContent = task.destination;
  const meta = document.createElement("div");
  meta.className = "meta";
  for (const value of [`${t("distance")}: ${task.distance}`, `${t("reward")}: ${task.reward}`, task.eta, `${task.items} ${language === "ar" ? "قطع" : "items"}`]) {
    const item = document.createElement("span"); item.textContent = value; meta.append(item);
  }
  card.append(header, store, route, meta);
  if (task.status === "offered") {
    const actions = document.createElement("div");
    actions.className = "actions";
    const accept = document.createElement("button");
    accept.className = "primary"; accept.dataset.action = "accept"; accept.dataset.id = task.id; accept.textContent = t("accept");
    const decline = document.createElement("button");
    decline.className = "secondary"; decline.dataset.action = "decline"; decline.dataset.id = task.id; decline.textContent = t("decline");
    actions.append(accept, decline); card.append(actions);
  } else {
    const next = document.createElement("p");
    next.className = "next-step";
    next.textContent = `${t("next")}: ${t("toStore")}`;
    card.append(next);
  }
  return card;
}

document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (tab) { activeTab = tab.dataset.tab; render(); return; }
  const action = event.target.closest("button[data-action]");
  if (!action) return;
  const result = action.dataset.action === "accept" ? acceptTask(tasks, action.dataset.id) : declineTask(tasks, action.dataset.id);
  if (!result.changed) return;
  tasks = result.tasks;
  notify(t(action.dataset.action === "accept" ? "accepted" : "declined"));
  render();
});

$("#language-toggle").addEventListener("click", () => { language = language === "ar" ? "en" : "ar"; render(); });
render();
