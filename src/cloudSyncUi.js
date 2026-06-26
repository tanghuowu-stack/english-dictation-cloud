import { cloudConfigurationMessage, isCloudConfigured, supabase } from "./supabaseClient.js";
import {
  downloadCloudDataForLocalStorage,
  getCloudDataSummary,
  getCloudFreshnessSignals,
  getCurrentUser,
  uploadLocalDataToCloud
} from "./cloudRepository.js";

let authListenerBound = false;
let lastAutoUploadMessage = "";
let lastAutoUploadIsError = false;

function getCloudElements() {
  return {
    panel: document.getElementById("cloudSyncPanel"),
    mode: document.getElementById("cloudModeText"),
    user: document.getElementById("cloudUserText"),
    email: document.getElementById("cloudEmailInput"),
    password: document.getElementById("cloudPasswordInput"),
    login: document.getElementById("cloudLoginBtn"),
    logout: document.getElementById("cloudLogoutBtn"),
    message: document.getElementById("cloudSyncMessage"),
    upload: document.getElementById("cloudUploadBtn"),
    summary: document.getElementById("cloudSummaryBtn"),
    diagnose: document.getElementById("cloudDiagnoseBtn"),
    download: document.getElementById("cloudDownloadBtn"),
    reload: document.getElementById("cloudReloadBtn"),
    summaryPanel: document.getElementById("cloudDataSummary"),
    libraryCount: document.getElementById("cloudLibraryCount"),
    wordCount: document.getElementById("cloudWordCount"),
    sessionCount: document.getElementById("cloudSessionCount"),
    progressCount: document.getElementById("cloudProgressCount"),
    diagnosticOutput: document.getElementById("cloudDiagnosticOutput"),
    actionMessage: document.getElementById("cloudActionMessage")
  };
}

function setMessage(element, text, isError = false) {
  if (!element) return;
  element.textContent = text || "";
  element.classList.toggle("danger-text", isError);
  element.classList.toggle("ok-text", Boolean(text) && !isError);
}

function setAutoUploadStatus(text, isError = false, isSuccess = false) {
  lastAutoUploadMessage = text;
  lastAutoUploadIsError = isError;
  const element = document.getElementById("autoCloudUploadStatus");
  if (!element) return;
  element.textContent = text;
  element.className = isSuccess ? "success small" : "notice small" + (isError ? " danger-text" : "");
}

async function refreshCloudStatus(elements) {
  if (!elements.panel) return;
  if (!isCloudConfigured) {
    elements.mode.textContent = "本地模式";
    elements.user.textContent = "未登录";
    elements.email.disabled = true;
    elements.password.disabled = true;
    elements.login.disabled = true;
    elements.login.hidden = false;
    elements.logout.hidden = true;
    elements.upload.disabled = true;
    elements.summary.disabled = true;
    elements.diagnose.disabled = true;
    elements.download.disabled = true;
    elements.reload.hidden = true;
    elements.summaryPanel.hidden = true;
    setMessage(elements.message, cloudConfigurationMessage, true);
    return;
  }

  try {
    const user = await getCurrentUser();
    elements.mode.textContent = user ? "已登录云端" : "云端已配置";
    elements.user.textContent = user?.email || "未登录";
    elements.email.disabled = Boolean(user);
    elements.password.disabled = Boolean(user);
    elements.login.hidden = Boolean(user);
    elements.login.disabled = false;
    elements.logout.hidden = !user;
    elements.upload.disabled = !user;
    elements.summary.disabled = !user;
    elements.diagnose.disabled = !user;
    elements.download.disabled = !user;
    if (!user) {
      elements.summaryPanel.hidden = true;
      elements.reload.hidden = true;
    }
    if (user) setMessage(elements.message, "已登录云端；听写完成后会自动上传，下载和覆盖仍需手动操作。", false);
    else setMessage(elements.message, "未登录时仍可继续使用全部本地功能。", false);
  } catch (error) {
    elements.mode.textContent = "云端已配置";
    elements.user.textContent = "状态读取失败";
    elements.upload.disabled = true;
    elements.summary.disabled = true;
    elements.diagnose.disabled = true;
    elements.download.disabled = true;
    setMessage(elements.message, error.message || "云端状态读取失败", true);
  }
}

function replaceLocalData(restoredData) {
  if (typeof window.replaceLocalDictationDataFromCloud !== "function") {
    throw new Error("当前页面无法写入恢复数据");
  }
  window.replaceLocalDictationDataFromCloud(restoredData);
}

function validateRestoredData(restoredData, cloudCounts) {
  if (typeof window.validateCloudRestoredDataForImport !== "function") {
    return { valid: false, reasons: ["当前页面缺少恢复结构校验函数"] };
  }
  return window.validateCloudRestoredDataForImport(restoredData, cloudCounts);
}

function getLocalDataSnapshot() {
  if (typeof window.getLocalDictationDataForCloudUpload !== "function") {
    throw new Error("无法读取本地听写数据");
  }
  return window.getLocalDictationDataForCloudUpload();
}

function validateLocalDataForAutoUpload(localData) {
  const reasons = [];
  const libraries = Array.isArray(localData?.libraries) ? localData.libraries : [];
  const activeLibrary = libraries.find(library => library.libraryId === localData?.activeLibraryId);
  if (!localData?.activeLibraryId || !activeLibrary) {
    reasons.push("缺少有效的 activeLibraryId");
    return { valid: false, reasons };
  }
  const summary = summarizeLibrary(activeLibrary);
  if (summary.total <= 0) reasons.push("当前词库没有单词");
  if (summary.currentDay <= 20 && summary.total === 595 && summary.learned === 595) {
    reasons.push("检测到低 Day 下 595 个词全部已学的异常状态");
  }
  return { valid: reasons.length === 0, reasons, summary };
}

async function autoUploadAfterDictation() {
  setAutoUploadStatus("本次听写已保存到本机，正在自动上传云端...", false, false);
  try {
    const user = await getCurrentUser();
    if (!user) {
      setAutoUploadStatus("本次听写已保存到本机。当前未登录云端，未自动上传。", false, false);
      return;
    }
    const localData = getLocalDataSnapshot();
    const validation = validateLocalDataForAutoUpload(localData);
    if (!validation.valid) {
      setAutoUploadStatus("本地数据结构异常，已阻止自动上传云端，请先检查数据。", true, false);
      return;
    }
    const result = await uploadLocalDataToCloud(localData);
    if (result.blockedOlderData) {
      setAutoUploadStatus("本机数据较旧，已阻止自动上传，避免覆盖云端最新数据。请先从云端下载最新数据。", true, false);
      return;
    }
    if (result.failed > 0) {
      const reason = result.failureReasons.join("；") || "未知错误";
      setAutoUploadStatus(
        "本次听写已保存到本机，但自动上传云端失败：" + reason + "。请稍后在工具页手动上传。",
        true,
        false
      );
      return;
    }
    setAutoUploadStatus("本次听写已保存到本机，并已自动上传到云端。", false, true);
  } catch (error) {
    setAutoUploadStatus(
      "本次听写已保存到本机，但自动上传云端失败：" + (error.message || "网络错误") + "。请稍后在工具页手动上传。",
      true,
      false
    );
  }
}

// ── 词库/单词变更后统一自动上传入口（带 1000ms debounce 防抖）──────────────────────
let _autoUploadTimer = null;

async function _doAutoUploadForDataChange(reason) {
  const prefix = "词库变更已保存到本机";
  setAutoUploadStatus(prefix + "，正在自动上传云端...", false, false);
  try {
    const user = await getCurrentUser();
    if (!user) {
      setAutoUploadStatus(prefix + "。当前未登录云端，未自动上传。", false, false);
      return;
    }
    const localData = getLocalDataSnapshot();
    const validation = validateLocalDataForAutoUpload(localData);
    if (!validation.valid) {
      const reasons = validation.reasons.join("；");
      setAutoUploadStatus(
        prefix + "，但本地数据结构异常，已阻止自动上传：" + reasons + "。请先检查数据。",
        true, false
      );
      return;
    }
    const result = await uploadLocalDataToCloud(localData);
    if (result.blockedOlderData) {
      setAutoUploadStatus(
        "本机数据较旧，已阻止自动上传，避免覆盖云端最新数据。请先从云端下载最新数据。",
        true, false
      );
      return;
    }
    if (result.failed > 0) {
      const failReason = result.failureReasons.join("；") || "未知错误";
      setAutoUploadStatus(
        prefix + "，但自动上传云端失败：" + failReason + "。请稍后在工具页手动上传。",
        true, false
      );
      return;
    }
    setAutoUploadStatus(prefix + "，并已自动上传到云端。", false, true);
  } catch (error) {
    setAutoUploadStatus(
      prefix + "，但自动上传云端失败：" + (error.message || "网络错误") + "。请稍后在工具页手动上传。",
      true, false
    );
  }
}

function requestAutoUploadLocalData(reason) {
  if (_autoUploadTimer !== null) {
    clearTimeout(_autoUploadTimer);
    _autoUploadTimer = null;
  }
  _autoUploadTimer = setTimeout(() => {
    _autoUploadTimer = null;
    if (reason === "dictation-complete") {
      autoUploadAfterDictation();
    } else {
      _doAutoUploadForDataChange(reason || "data-changed");
    }
  }, 1000);
}
// ─────────────────────────────────────────────────────────────────────────────

function summarizeLibrary(library) {
  if (!library) {
    return { currentDay: 1, total: 0, learned: 0, unlearned: 0, pending: 0, records: 0, id: "-", name: "-" };
  }
  const records = Array.isArray(library.dailyRecords) ? library.dailyRecords : [];
  const words = Array.isArray(library.words) ? library.words : [];
  const taskWordIds = new Set(records.flatMap(record => record.taskWordIds || []));
  const learned = words.filter(word => {
    const day = Number(word.firstLearnDay);
    return (word.firstLearnDay != null && Number.isFinite(day) && day > 0) || taskWordIds.has(word.id);
  }).length;
  return {
    currentDay: records.length ? Math.max(...records.map(record => Number(record.dayNumber || 0))) + 1 : 1,
    total: words.length,
    learned,
    unlearned: Math.max(0, words.length - learned),
    pending: words.filter(word => word.isPendingWrong).length,
    records: records.length,
    id: library.libraryId || "-",
    name: library.libraryName || "未命名词库"
  };
}

function activeLibraryFromData(localData) {
  const libraries = Array.isArray(localData?.libraries) ? localData.libraries : [];
  return libraries.find(library => library.libraryId === localData.activeLibraryId) || libraries[0] || null;
}

function formatDiagnosticReport(localData, restoreResult, validation) {
  const local = summarizeLibrary(activeLibraryFromData(localData));
  const restored = summarizeLibrary(activeLibraryFromData(restoreResult.restoredData));
  const cloud = restoreResult.cloudCounts || {};
  const lines = [
    "本机摘要：",
    "当前 Day：" + local.currentDay,
    "总词数：" + local.total,
    "已学词数：" + local.learned,
    "未学词数：" + local.unlearned,
    "当前错词池数量：" + local.pending,
    "dailyRecords 数量：" + local.records,
    "当前词库：" + local.id + " / " + local.name,
    "",
    "云端摘要：",
    "words 总数：" + Number(cloud.words || 0),
    "dictation_sessions 数量：" + Number(cloud.sessions || 0),
    "最大 day_number：" + Number(cloud.maxDayNumber || 0),
    "user_word_progress 总数：" + Number(cloud.progress || 0),
    "first_learn_day 非空数量：" + Number(cloud.firstLearnDayNonNullProgress || 0),
    "first_learn_day 有效数量：" + Number(cloud.firstLearnDayValidProgress || 0),
    "is_pending_wrong = true 数量：" + Number(cloud.pendingWrongProgress || 0),
    "当前用户 id：" + (cloud.userId || "-"),
    "当前词库数量：" + Number(cloud.libraries || 0),
    "",
    "恢复预览摘要：",
    "restoredData 当前 Day：" + restored.currentDay,
    "restoredData 总词数：" + restored.total,
    "restoredData 已学词数：" + restored.learned,
    "restoredData 未学词数：" + restored.unlearned,
    "restoredData 错词池数量：" + restored.pending,
    "restoredData dailyRecords 数量：" + restored.records,
    "是否通过结构校验：" + (validation.valid ? "是" : "否")
  ];
  if (!validation.valid) {
    lines.push("校验失败原因：");
    validation.reasons.forEach(reason => lines.push("- " + reason));
  }
  return lines.join("\n");
}

function formatUploadResult(result) {
  const lines = [
    "上传完成。",
    "词库数量：" + result.libraries,
    "单词数量：" + result.words,
    "听写记录数量：" + result.sessions,
    "学习进度数量：" + result.progress,
    "失败数量：" + result.failed
  ];
  if (result.failureReasons.length) {
    lines.push("失败原因：");
    result.failureReasons.forEach(reason => lines.push("- " + reason));
  } else {
    lines.push("失败原因：无");
  }
  return lines.join("\n");
}

async function uploadLocalData(elements) {
  const confirmed = window.confirm(
    "上传前请先导出本地 JSON 备份。本操作会把当前浏览器里的词库、单词、听写记录、错词进度上传到当前登录的云端账号。不会清空本地数据，也不会从云端下载覆盖本机数据。确定继续吗？"
  );
  if (!confirmed) return;

  elements.upload.disabled = true;
  elements.summary.disabled = true;
  elements.diagnose.disabled = true;
  setMessage(elements.actionMessage, "正在上传本地数据，请不要关闭页面...", false);
  try {
    const result = await uploadLocalDataToCloud(getLocalDataSnapshot());
    setMessage(elements.actionMessage, formatUploadResult(result), result.failed > 0);
  } catch (error) {
    setMessage(elements.actionMessage, "上传失败：" + (error.message || "网络错误"), true);
  } finally {
    await refreshCloudStatus(elements);
  }
}

async function showCloudSummary(elements) {
  elements.upload.disabled = true;
  elements.summary.disabled = true;
  elements.diagnose.disabled = true;
  setMessage(elements.actionMessage, "正在读取云端数据摘要...", false);
  try {
    const summary = await getCloudDataSummary();
    elements.libraryCount.textContent = summary.libraries;
    elements.wordCount.textContent = summary.words;
    elements.sessionCount.textContent = summary.sessions;
    elements.progressCount.textContent = summary.progress;
    elements.summaryPanel.hidden = false;
    setMessage(elements.actionMessage, "云端数据摘要已更新。此操作没有修改本地数据。", false);
  } catch (error) {
    setMessage(elements.actionMessage, "读取失败：" + (error.message || "网络错误"), true);
  } finally {
    await refreshCloudStatus(elements);
  }
}

async function diagnoseLocalAndCloudData(elements) {
  elements.upload.disabled = true;
  elements.summary.disabled = true;
  elements.diagnose.disabled = true;
  elements.download.disabled = true;
  elements.diagnosticOutput.hidden = true;
  setMessage(elements.actionMessage, "正在执行只读诊断...", false);
  try {
    const localData = getLocalDataSnapshot();
    const result = await downloadCloudDataForLocalStorage(localData?.version || "1.0.0");
    const validation = validateRestoredData(result.restoredData, result.cloudCounts || {});
    elements.diagnosticOutput.textContent = formatDiagnosticReport(localData, result, validation);
    elements.diagnosticOutput.hidden = false;
    setMessage(elements.actionMessage, "诊断完成。本次操作只读取数据，没有上传、下载覆盖或修改本机数据。", false);
  } catch (error) {
    setMessage(elements.actionMessage, "诊断失败：" + (error.message || "网络错误"), true);
  } finally {
    await refreshCloudStatus(elements);
  }
}

function formatRestoreResult(result) {
  const lines = [
    result.failed > 0 ? "恢复完成，但有部分项目未恢复。" : "恢复成功。",
    "词库数量：" + result.libraries,
    "单词数量：" + result.words,
    "听写记录数量：" + result.sessions,
    "学习/错词进度数量：" + result.progress,
    "是否有跳过项目：" + (result.skipped > 0 ? "是（" + result.skipped + "）" : "否"),
    "失败数量：" + result.failed
  ];
  if (result.failureReasons.length) {
    lines.push("失败原因：");
    result.failureReasons.forEach(reason => lines.push("- " + reason));
  } else {
    lines.push("失败原因：无");
  }
  lines.push("恢复已写入本机 localStorage。请刷新页面检查词库和记录。");
  return lines.join("\n");
}

async function downloadCloudData(elements) {
  const confirmed = window.confirm(
    "请先在当前设备导出本地 JSON 备份。本操作会把云端数据下载到当前浏览器，并覆盖当前浏览器 localStorage。不会删除云端数据。确定继续吗？"
  );
  if (!confirmed) return;

  elements.upload.disabled = true;
  elements.summary.disabled = true;
  elements.diagnose.disabled = true;
  elements.download.disabled = true;
  elements.reload.hidden = true;
  setMessage(elements.actionMessage, "正在读取并还原云端数据，请不要关闭页面...", false);
  try {
    const currentLocalData = getLocalDataSnapshot();
    const result = await downloadCloudDataForLocalStorage(currentLocalData?.version || "1.0.0");
    const validation = validateRestoredData(result.restoredData, result.cloudCounts || {});
    if (!validation.valid) {
      setMessage(
        elements.actionMessage,
        "云端数据已下载，但已学/未学状态校验失败，未覆盖本机数据。\n失败原因：\n- " + validation.reasons.join("\n- "),
        true
      );
      return;
    }
    replaceLocalData(result.restoredData);
    setMessage(elements.actionMessage, formatRestoreResult(result), result.failed > 0);
    elements.reload.hidden = false;
  } catch (error) {
    setMessage(
      elements.actionMessage,
      "恢复失败：" + (error.message || "网络错误") + "。本地数据没有被覆盖。",
      true
    );
  } finally {
    await refreshCloudStatus(elements);
  }
}

async function signInWithEmailPassword(elements) {
  const email = String(elements.email.value || "").trim();
  const password = String(elements.password.value || "");
  if (!email) {
    setMessage(elements.message, "请输入邮箱。", true);
    elements.email.focus();
    return;
  }
  if (!password) {
    setMessage(elements.message, "请输入密码。", true);
    elements.password.focus();
    return;
  }

  elements.login.disabled = true;
  setMessage(elements.message, "正在登录...", false);
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    elements.password.value = "";
    await refreshCloudStatus(elements);
    setMessage(elements.message, "登录成功，正在检查云端数据是否更新...", false);
  } catch (error) {
    setMessage(elements.message, "登录失败：" + (error.message || "网络错误"), true);
  } finally {
    elements.login.disabled = false;
  }
}

async function signOut(elements) {
  elements.logout.disabled = true;
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    setMessage(elements.message, "已退出云端，当前继续使用本地模式。", false);
    await refreshCloudStatus(elements);
  } catch (error) {
    setMessage(elements.message, error.message || "退出登录失败", true);
  } finally {
    elements.logout.disabled = false;
  }
}

// ── 自动双向同步：检查云端是否比本机新 ──────────────────────────────────────────
let _autoSyncInProgress = false;

async function checkCloudFreshness() {
  try {
    const user = await getCurrentUser();
    if (!user) return false;

    const localData = getLocalDataSnapshot();
    if (!localData || !Array.isArray(localData.libraries)) return false;

    const libraries = localData.libraries;
    const activeLibrary = libraries.find(lib => lib.libraryId === localData.activeLibraryId) || libraries[0];
    if (!activeLibrary) return false;

    const localRecords = Array.isArray(activeLibrary.dailyRecords) ? activeLibrary.dailyRecords : [];
    const localSessionCount = localRecords.length;
    const localMaxDay = localRecords.length
      ? Math.max(...localRecords.map(r => Number(r.dayNumber || 0)))
      : 0;
    const localLearnedCount = (activeLibrary.words || []).filter(word => {
      const day = Number(word.firstLearnDay);
      return word.firstLearnDay != null && Number.isFinite(day) && day > 0;
    }).length;

    const signals = await getCloudFreshnessSignals();
    if (!signals) return false;

    if (signals.sessionCount > localSessionCount) return true;
    if (signals.maxDayNumber > localMaxDay) return true;
    if (signals.learnedCount > localLearnedCount) return true;

    return false;
  } catch {
    return false;
  }
}

function showSyncToast(message) {
  let toast = document.getElementById("autoSyncToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "autoSyncToast";
    Object.assign(toast.style, {
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#eefaf5",
      border: "1px solid #8dc7b2",
      color: "#0d5d45",
      padding: "8px 18px",
      borderRadius: "8px",
      fontSize: "14px",
      zIndex: "9999",
      boxShadow: "0 2px 8px rgba(0,0,0,.12)",
      transition: "opacity .3s ease",
      pointerEvents: "none"
    });
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = "1";
  clearTimeout(toast._autoSyncTimer);
  toast._autoSyncTimer = setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
  }, 1800);
}

async function autoSyncCloudToLocalIfNewer() {
  if (_autoSyncInProgress) return;
  _autoSyncInProgress = true;
  try {
    const isFresh = await checkCloudFreshness();
    if (!isFresh) return;

    const currentLocalData = getLocalDataSnapshot();
    const result = await downloadCloudDataForLocalStorage(currentLocalData?.version || "1.0.0");
    const validation = validateRestoredData(result.restoredData, result.cloudCounts || {});
    if (!validation.valid) return;

    replaceLocalData(result.restoredData);
    showSyncToast("已同步最新数据");
    setTimeout(() => window.location.reload(), 500);
  } catch {
    // 静默失败，不打扰用户
  } finally {
    _autoSyncInProgress = false;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

async function mount() {
  const elements = getCloudElements();
  if (!elements.panel) return;
  elements.login.onclick = () => signInWithEmailPassword(elements);
  elements.logout.onclick = () => signOut(elements);
  elements.upload.onclick = () => uploadLocalData(elements);
  elements.summary.onclick = () => showCloudSummary(elements);
  elements.diagnose.onclick = () => diagnoseLocalAndCloudData(elements);
  elements.download.onclick = () => downloadCloudData(elements);
  elements.reload.onclick = () => window.location.reload();
  if (lastAutoUploadMessage && !elements.actionMessage.textContent) {
    setMessage(elements.actionMessage, "最近一次自动上传：" + lastAutoUploadMessage, lastAutoUploadIsError);
  }
  [elements.email, elements.password].forEach(input => {
    input.onkeydown = event => {
      if (event.key === "Enter") {
        event.preventDefault();
        signInWithEmailPassword(elements);
      }
    };
  });
  await refreshCloudStatus(elements);
}

window.cloudSync = { mount, autoUploadAfterDictation, requestAutoUploadLocalData, autoSyncCloudToLocalIfNewer };

if (supabase && !authListenerBound) {
  authListenerBound = true;
  supabase.auth.onAuthStateChange((event) => {
    window.setTimeout(() => mount(), 0);
    if (event === "SIGNED_IN") {
      window.setTimeout(() => autoSyncCloudToLocalIfNewer(), 0);
    }
  });
}

mount();
