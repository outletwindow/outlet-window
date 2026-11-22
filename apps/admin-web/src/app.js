import { createAdminApi, AdminApiError } from "./api.js";

const copy = {
  ar: {title:"إدارة المندوبين",subtitle:"مراجعة ملفات المندوبين واعتماد المركبات وصلاحيات مناطق الخدمة",secure:"صلاحيات إدارية محمية",
    connectTitle:"الاتصال بواجهة المنصة",apiUrl:"رابط API",token:"رمز جلسة مسؤول المنصة",sessionNote:"لا يتم حفظ رمز الجلسة؛ يبقى في ذاكرة الصفحة فقط. استخدم جلسة مسؤول مخولة.",
    connect:"اتصال",disconnect:"قطع الاتصال",directory:"سجل المندوبين",refresh:"تحديث",createProfile:"إنشاء ملف مندوب",courierId:"معرّف المندوب",
    maxTasks:"الحد الأقصى للمهام المتزامنة",create:"إنشاء بانتظار المراجعة",vehicle:"تسجيل مركبة",vehicleType:"نوع المركبة",
    weight:"الحمولة (غرام)",volume:"الحجم (لتر)",register:"تسجيل مركبة معلّقة",vehicleNote:"بعد التسجيل سيظهر معرّف المركبة؛ أدخله في نموذج المراجعة لاعتمادها أو رفضها.",
    vehicleId:"معرّف المركبة",approveVehicle:"اعتماد المركبة",reject:"رفض",serviceArea:"صلاحية منطقة الخدمة",tenantId:"معرّف التاجر / المستأجر",
    areaId:"معرّف منطقة الخدمة",grant:"منح الصلاحية",revoke:"سحب الصلاحية",notice:"تنبيه: اعتماد الملف وحده لا يفعّل استقبال الطلبات. يلزم اعتماد مركبة ومنح منطقة خدمة نشطة. التحقق من المستندات المرفوعة غير متاح بعد في هذه الواجهة.",
    connected:"متصل",notConnected:"غير متصل",loading:"جارٍ التنفيذ...",empty:"لا توجد ملفات مندوبين في هذا الفلتر",pending:"قيد المراجعة",active:"نشط",suspended:"موقوف",
    verified:"موثّق",rejected:"مرفوض",approve:"اعتماد الملف",suspend:"إيقاف",reinstate:"إعادة تفعيل",created:"تم إنشاء ملف المندوب بانتظار المراجعة",
    vehicleCreated:"تم تسجيل المركبة. احتفظ بمعرّفها لمراجعتها",granted:"تم منح منطقة الخدمة",revoked:"تم سحب منطقة الخدمة",saved:"تم تنفيذ العملية",failed:"تعذر تنفيذ العملية",
    language:"English",filterAll:"كل الحالات",profileCreated:"إنشاء الملف",updated:"آخر تحديث",capacity:"المهام المتزامنة",vehicleIdLabel:"معرّف المركبة:"},
  en: {title:"Courier administration",subtitle:"Review courier profiles, verify vehicles and manage service-area access",secure:"Protected administrator access",
    connectTitle:"Connect to platform API",apiUrl:"API URL",token:"Platform administrator session token",sessionNote:"The session token is held in page memory only and is never persisted. Use an authorized administrator session.",
    connect:"Connect",disconnect:"Disconnect",directory:"Courier directory",refresh:"Refresh",createProfile:"Create courier profile",courierId:"Courier identity ID",
    maxTasks:"Maximum concurrent tasks",create:"Create pending profile",vehicle:"Register vehicle",vehicleType:"Vehicle type",
    weight:"Capacity (grams)",volume:"Volume (liters)",register:"Register pending vehicle",vehicleNote:"A vehicle ID is returned after registration. Enter it below to approve or reject.",
    vehicleId:"Vehicle ID",approveVehicle:"Approve vehicle",reject:"Reject",serviceArea:"Service-area access",tenantId:"Merchant / tenant ID",
    areaId:"Service-area ID",grant:"Grant access",revoke:"Revoke access",notice:"Note: profile approval alone does not enable dispatch. An approved vehicle and active service-area membership are also required. Uploaded document verification is not yet available in this interface.",
    connected:"Connected",notConnected:"Not connected",loading:"Working...",empty:"No courier profiles match this filter",pending:"Pending review",active:"Active",suspended:"Suspended",
    verified:"Verified",rejected:"Rejected",approve:"Approve profile",suspend:"Suspend",reinstate:"Reinstate",created:"Courier profile created and awaiting review",
    vehicleCreated:"Vehicle registered. Keep its ID for review",granted:"Service area granted",revoked:"Service area revoked",saved:"Operation completed",failed:"Operation failed",
    language:"العربية",filterAll:"All statuses",profileCreated:"Profile created",updated:"Updated",capacity:"Concurrent tasks",vehicleIdLabel:"Vehicle ID:"}
};
let api = null, language = "ar", busy = false;
const $ = s => document.querySelector(s);
const toast = $("#toast");
function tr(key) { return copy[language][key] ?? key; }
function notify(message) { toast.textContent = message; toast.hidden = false; }
function setBusy(value) { busy = value; document.querySelectorAll("form button, #refresh-button").forEach(b => b.disabled = value); }
function translatePage() {
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  document.querySelectorAll("[data-copy]").forEach(node => { node.textContent = tr(node.dataset.copy); });
  $("#language-toggle").textContent = tr("language");
  $("#status-filter").options[0].textContent = tr("filterAll");
  $("#connection-state").textContent = api ? tr("connected") : tr("notConnected");
}
function makeButton(label, action, courierId, style = "secondary") {
  const b = document.createElement("button"); b.type = "button"; b.className = style;
  b.dataset.action = action; b.dataset.id = courierId; b.textContent = tr(label); return b;
}
function renderProfiles(profiles) {
  const root = $("#profile-list"); root.replaceChildren();
  if (!profiles.length) { const p = document.createElement("p"); p.className = "empty"; p.textContent = tr("empty"); root.append(p); return; }
  for (const profile of profiles) {
    const card = document.createElement("article"); card.className = "profile-card";
    const heading = document.createElement("div"); heading.className = "profile-heading";
    const id = document.createElement("strong"); id.textContent = profile.courierId;
    const status = document.createElement("span"); status.className = `pill ${profile.accountStatus}`; status.textContent = tr(profile.accountStatus);
    heading.append(id, status);
    const verification = document.createElement("p"); verification.textContent = `${tr("verified")}: ${tr(profile.verificationStatus)}`;
    const capacity = document.createElement("p"); capacity.textContent = `${tr("capacity")}: ${profile.maxConcurrentTasks}`;
    const updated = document.createElement("small"); updated.textContent = `${tr("updated")}: ${new Date(profile.updatedAtUtc).toLocaleString(language === "ar" ? "ar-SA" : "en")}`;
    const actions = document.createElement("div"); actions.className = "actions";
    if (profile.accountStatus === "pending") { actions.append(makeButton("approve", "approve", profile.courierId, "primary"), makeButton("reject", "reject", profile.courierId, "danger")); }
    if (profile.accountStatus === "active") actions.append(makeButton("suspend", "suspend", profile.courierId, "danger"));
    if (profile.accountStatus === "suspended" && profile.verificationStatus === "verified") actions.append(makeButton("reinstate", "reinstate", profile.courierId, "primary"));
    card.append(heading, verification, capacity, updated, actions); root.append(card);
  }
}
async function refresh() {
  if (!api) return;
  const profiles = await api.listProfiles($("#status-filter").value);
  renderProfiles(profiles);
}
function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
function explain(error) {
  const known = {platform_admin_only:"هذه العملية لمسؤول المنصة فقط",courier_identity_not_found:"حساب المندوب غير موجود",
    courier_identity_not_eligible:"الحساب غير مؤهل",courier_profile_already_exists:"ملف المندوب موجود مسبقاً",
    courier_profile_not_active:"يجب اعتماد ملف المندوب أولاً",service_area_not_active:"منطقة الخدمة غير نشطة",
    courier_profile_review_conflict:"تغيير حالة الملف غير مسموح",courier_vehicle_review_conflict:"المركبة سبق مراجعتها"};
  return known[error?.message] ?? (error instanceof AdminApiError ? error.message : tr("failed"));
}
$("#connect-form").addEventListener("submit", async event => {
  event.preventDefault(); if (busy) return;
  try {
    setBusy(true);
    api = createAdminApi({ baseUrl: $("#api-base-url").value || document.querySelector('meta[name="outlet-window-api-base-url"]').content,
      token: $("#session-token").value.trim() });
    await refresh();
    $("#workspace").hidden = false; $("#disconnect-button").hidden = false;
    $("#session-token").value = ""; translatePage(); notify(tr("connected"));
  } catch (error) { api = null; $("#workspace").hidden = true; notify(explain(error)); }
  finally { setBusy(false); }
});
$("#disconnect-button").addEventListener("click", () => {
  api = null; $("#workspace").hidden = true; $("#disconnect-button").hidden = true; $("#session-token").value = "";
  translatePage(); notify(tr("notConnected"));
});
$("#language-toggle").addEventListener("click", () => { language = language === "ar" ? "en" : "ar"; translatePage(); if (api) refresh().catch(error => notify(explain(error))); });
$("#refresh-button").addEventListener("click", () => refresh().then(() => notify(tr("saved"))).catch(error => notify(explain(error))));
$("#status-filter").addEventListener("change", () => refresh().catch(error => notify(explain(error))));
$("#profile-list").addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]"); if (!button || !api || busy) return;
  const action = button.dataset.action; const decision = action === "approve" ? "approve" : action === "reject" ? "reject" : action;
  try { setBusy(true); await api.reviewProfile(button.dataset.id, decision); await refresh(); notify(tr("saved")); }
  catch (error) { notify(explain(error)); } finally { setBusy(false); }
});
$("#profile-form").addEventListener("submit", async event => {
  event.preventDefault(); if (!api || busy) return;
  const data = formData(event.currentTarget);
  try { setBusy(true); await api.createProfile({ courierId: data.courierId.trim(), maxConcurrentTasks: Number(data.maxConcurrentTasks) });
    event.currentTarget.reset(); await refresh(); notify(tr("created")); }
  catch (error) { notify(explain(error)); } finally { setBusy(false); }
});
$("#vehicle-form").addEventListener("submit", async event => {
  event.preventDefault(); if (!api || busy) return;
  const d = formData(event.currentTarget);
  try { setBusy(true); const result = await api.registerVehicle({ courierId:d.courierId.trim(), vehicleType:d.vehicleType,
    capacityWeightGrams:Number(d.capacityWeightGrams), capacityVolumeLiters:Number(d.capacityVolumeLiters) });
    $("#vehicle-review-form [name=vehicleId]").value = result.vehicleId ?? "";
    notify(`${tr("vehicleCreated")}: ${result.vehicleId ?? "—"}`); }
  catch (error) { notify(explain(error)); } finally { setBusy(false); }
});
$("#vehicle-review-form").addEventListener("submit", async event => {
  event.preventDefault(); if (!api || busy) return;
  const d = formData(event.currentTarget); const decision = event.submitter?.value;
  try { setBusy(true); await api.reviewVehicle(d.vehicleId.trim(), decision); notify(tr("saved")); }
  catch (error) { notify(explain(error)); } finally { setBusy(false); }
});
$("#area-form").addEventListener("submit", async event => {
  event.preventDefault(); if (!api || busy) return;
  const d = formData(event.currentTarget); const action = event.submitter?.dataset.action;
  try { setBusy(true); await api.setServiceArea({ courierId:d.courierId.trim(), tenantId:d.tenantId.trim(),
    serviceAreaId:d.serviceAreaId.trim(), action }); notify(tr(action === "grant" ? "granted" : "revoked")); }
  catch (error) { notify(explain(error)); } finally { setBusy(false); }
});
translatePage();
