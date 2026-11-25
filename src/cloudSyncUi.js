import { cloudConfigurationMessage, isCloudConfigured, supabase } from "./supabaseClient.js";
import {
  downloadCloudDataForLocalStorage,
  getCloudDataSummary,
  getCurrentUser,
  getCurrentUserFromSession
} from "./cloudRepository.js";
import { learningFingerprint, learningSnapshot, readDictationRevision, readDictationState, writeDictationState } from "./dictationSyncState.js";
import { runDictationSyncCycle } from "./dictationSyncCycle.js";

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
    if (user) setMessage(elements.message, "已登录云端；数据变更后会自动上传，切回前台/刷新时会自动检查云端并同步。", false);
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
  // 合并听写不会切换当前词库：当前词库可能是空的（比如默认的“我的词库”），而真正听写的是另外几个词库。
  // 所以只在所有词库都没有单词时才拦，异常状态检查对每个有单词的词库都做一遍。
  const summaries = libraries.map(summarizeLibrary).filter(item => item.total > 0);
  if (!summaries.length) reasons.push("所有词库都没有单词");
  // Fix R6：阈值判断统一读取 index.html 里定义的共享函数，避免两处各写一份、条件不一致
  const isSuspicious = item => (typeof window.isSuspiciousAllWordsLearnedState === "function"
    ? window.isSuspiciousAllWordsLearnedState(item.currentDay, item.total, item.learned)
    : (item.currentDay <= 20 && item.total === 595 && item.learned === 595));
  if (summaries.some(isSuspicious)) {
    reasons.push("检测到低 Day 下 595 个词全部已学的异常状态");
  }
  return { valid: reasons.length === 0, reasons, summary };
}


let syncInFlight = null;
let syncTimer = null;
let lastCheckAt = 0;
let retryDelay = 5000;
let syncAgain = false;
let localFork = false;

function statusFromLocal() {
  try { return getLocalDataSnapshot() || {}; }
  catch { return {}; }
}

function paintSyncStatus() {
  const details = document.getElementById("dictationSyncDetails");
  if (!details) return;
  const local = statusFromLocal();
  const journal = local.dictationSyncJournal || {};
  const problem = localFork ? "另一标签页已保存较新的本机数据。请导出本页备份再核对。" : journal.error;
  const pending = Boolean(local.pendingCloudUpload);
  const label = document.getElementById("dictationSyncLabel");
  details.hidden = !isCloudConfigured;
  details.dataset.problem = problem ? "true" : "false";
  const labelText = problem ? "同步需注意" : syncInFlight ? "同步中" : pending ? "待同步"
    : journal.lastSuccessAt ? "已同步" : "本地保存";
  if (label.textContent !== labelText) label.textContent = labelText;
  document.getElementById("dictationSyncMessage").textContent = [
    problem, pending ? "本机有待同步数据" : null,
    journal.lastSuccessAt ? "最近成功：" + new Date(journal.lastSuccessAt).toLocaleString("zh-CN") : "尚无已确认的云端同步"
  ].filter(Boolean).join(" · ");
  document.getElementById("dictationSyncNow").disabled = Boolean(syncInFlight || localFork);
}

function showLocalFork() {
  localFork = true;
  paintSyncStatus();
}

function scheduleSync(delay) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    autoSyncCloudToLocalIfNewer(true);
  }, delay);
}

function queueSavedLearning() {
  paintSyncStatus();
  if (isCloudConfigured && !localFork) scheduleSync(1000);
}

function requestAutoUploadLocalData() { queueSavedLearning(); }
function autoUploadAfterDictation() {
  setAutoUploadStatus("听写已保存到本机；正在确认云端同步。");
  queueSavedLearning();
}

// The local undo is already committed. Send it through the same checked
// revision; never issue an independent DELETE against the previous account data.
async function deleteSessionAndSync() { queueSavedLearning(); }

async function userIsStill(owner) {
  return (await getCurrentUserFromSession())?.id === owner;
}

async function checkRemote(owner, journal) {
  const head = await readDictationRevision(supabase, owner);
  if (!head) return null;
  if (journal.owner === owner && journal.revision === head.revision && journal.baseHash) {
    return { revision:head.revision, updatedAt:head.updated_at, hash:journal.baseHash };
  }
  return readDictationState(supabase, owner);
}

async function hasLegacy(owner) {
  const { data, error } = await supabase.from("libraries").select("id").eq("owner_id", owner).limit(1);
  if (error) throw error;
  return Boolean(data?.length);
}

async function syncOnce() {
  const startedRaw = window.readDictationSyncLocal();
  if (!window.isCurrentDictationSyncLocal(startedRaw)) return "stale-tab";
  try {
    if (navigator.onLine === false) throw new Error("离线；学习数据已保存在本机。");
    const result = await runDictationSyncCycle({
      readLocal:window.readDictationSyncLocal, isCurrent:window.isCurrentDictationSyncLocal,
      checkpoint:window.checkpointDictationSync, getUser:getCurrentUserFromSession, isOwner:userIsStill,
      readRemote:checkRemote, hasLegacy,
      writeRemote:(owner, revision, snapshot) => writeDictationState(supabase, owner, revision, snapshot)
    });
    retryDelay = 5000;
    if (result === "pull") {
      window.renderRestoredDictation?.();
      showSyncToast("已同步最新学习数据");
    }
    if (result === "push" || result === "ack") setAutoUploadStatus("已确认同步到云端。", false, true);
    if (result === "conflict" || result === "signed-out") {
      const error = statusFromLocal().dictationSyncJournal?.error;
      if (error) setAutoUploadStatus(error, true);
    }
    if (result === "changed") {
      const latest = window.readDictationSyncLocal();
      if (window.isCurrentDictationSyncLocal(latest)) scheduleSync(1500);
    }
    return result;
  } catch (error) {
    const raw = window.readDictationSyncLocal();
    const local = statusFromLocal();
    const message = "云端同步未完成：" + (error?.message || "请求失败");
    try {
      window.checkpointDictationSync(raw, {
        journal:{ ...local.dictationSyncJournal, error:message }, pending:Boolean(local.pendingCloudUpload)
      });
    } catch (storageError) {
      console.warn("[cloudSync] 同步状态未能保存", storageError);
    }
    setAutoUploadStatus(message, true);
    if (navigator.onLine !== false) {
      scheduleSync(retryDelay);
      retryDelay = Math.min(retryDelay * 3, 180000);
    }
    return "failed";
  }
}

function autoSyncCloudToLocalIfNewer(force = false) {
  if (!isCloudConfigured || localFork) return Promise.resolve("local-only");
  if (syncInFlight) {
    if (force) syncAgain = true;
    return syncInFlight;
  }
  if (!force && Date.now() - lastCheckAt < 60000) return Promise.resolve("cooldown");
  lastCheckAt = Date.now();
  const run = () => syncOnce();
  syncInFlight = (navigator.locks?.request ? navigator.locks.request("dictation-learning-sync", run) : run())
    .finally(() => {
      syncInFlight = null;
      if (syncAgain) { syncAgain = false; scheduleSync(1000); }
      paintSyncStatus();
    });
  paintSyncStatus();
  return syncInFlight;
}

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
    // Fix S3：upload_complete === false 说明上一次上传中途失败/被打断过，云端可能停留在
    // 不完整的中间状态；这里明确列出，提醒用户去发起那次上传的设备重新点一次上传。
    "上次上传是否有未完整跑完的词库：" + (cloud.hasIncompleteUpload
      ? "是（" + (cloud.incompleteUploadLibraryNames || []).join("、") + "）"
      : "否"),
    // Fix S6：因引用缺失单词/词库被跳过的听写记录数量，跳过原因已在 console.warn 中给出。
    "因引用缺失数据被跳过的听写记录数：" + Number(cloud.skippedSessionCount || 0),
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


async function uploadLocalData(elements) {
  setMessage(elements.actionMessage, "正在检查本机与云端版本…");
  const result = await autoSyncCloudToLocalIfNewer(true);
  const problem = statusFromLocal().dictationSyncJournal?.error;
  setMessage(elements.actionMessage, problem || ({
    push:"已上传并确认同步。", ack:"本机与云端数据一致。", pull:"本机已安全同步云端新版本。",
    "stale-tab":"另一标签页已有更新。请先核对备份并重新打开本页。",
    "signed-out":"请先登录云端。"
  })[result] || "没有可立即同步的数据。", Boolean(problem || result === "stale-tab"));
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
    const result = await downloadCloudDataForLocalStorage(localData?.version || "1.0.0", localData?.activeLibraryId || null);
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
  if (syncInFlight || localFork) {
    setMessage(elements.actionMessage, "请等待同步结束，或先处理本机标签页冲突。", true);
    return;
  }
  const confirmDownload = window.requestAppConfirmation || (message => Promise.resolve(window.confirm(message)));
  const confirmed = await confirmDownload(
    "请先导出本机 JSON 备份。本操作会替换当前浏览器的学习数据，包括任何未同步记录和草稿。不会修改云端数据。确定继续吗？",
    "从云端恢复数据"
  );
  if (!confirmed) return;

  elements.upload.disabled = true;
  elements.summary.disabled = true;
  elements.diagnose.disabled = true;
  elements.download.disabled = true;
  elements.reload.hidden = true;
  setMessage(elements.actionMessage, "正在读取并还原云端数据，请不要关闭页面...", false);
  try {
    const expectedRaw = window.readDictationSyncLocal();
    const currentLocalData = getLocalDataSnapshot();
    const result = await downloadCloudDataForLocalStorage(currentLocalData?.version || "1.0.0", currentLocalData?.activeLibraryId || null);
    const validation = result.revision ? { valid: true } : validateRestoredData(result.restoredData, result.cloudCounts || {});
    if (!validation.valid) {
      setMessage(
        elements.actionMessage,
        "云端数据已下载，但已学/未学状态校验失败，未覆盖本机数据。\n失败原因：\n- " + validation.reasons.join("\n- "),
        true
      );
      return;
    }
    const owner = result.cloudCounts?.userId;
    if (!await userIsStill(owner)) throw new Error("登录账号发生变化，请重新检查。");
    if (result.revision) {
      const baseHash = await learningFingerprint(learningSnapshot(result.restoredData));
      const journal = { owner, revision:result.revision, baseHash, lastSuccessAt:new Date().toISOString(), pristine:false, error:null };
      if (!window.checkpointDictationSync(expectedRaw, { journal, pending:false, replacement:result.restoredData, preserveBefore:true })) {
        throw new Error("读取期间本机学习数据已变化；请先核对，再重新恢复。");
      }
    } else {
      // Old accounts retain their manual read-only recovery option. Save a
      // device backup first; the legacy projection has no complete revision.
      if (!window.checkpointDictationSync(expectedRaw, { journal:currentLocalData.dictationSyncJournal || {},
        pending:Boolean(currentLocalData.pendingCloudUpload), preserveBefore:true })) {
        throw new Error("读取期间本机学习数据已变化；请先核对，再重新恢复。");
      }
      replaceLocalData(result.restoredData);
    }
    paintSyncStatus();
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



// ── 独立的 PWA 代码版本检查（与上面的云端数据同步逻辑完全独立，不共用任何状态）─────────
// 背景：iOS "添加到主屏幕" 的独立 PWA 窗口用的是一套和普通 Safari 标签页不同的页面缓存/
// 快照机制，不完全受 Cache-Control 约束——曾出现过服务器和代码都已经更新，但主屏幕图标
// 打开的窗口仍在跑旧版 JS 的情况。这里用"版本号轮询 + 不一致就强制刷新"来兜底，而不是
// 引入 Service Worker。
//
// __APP_BUILD_VERSION__ 由 vite.config.js 在构建时注入，是"当前这份正在运行的代码是哪次
// 构建"的编译期常量，随 JS bundle 一起打包，不会因为重新请求而变化。
// /version.json 是每次构建都会重新生成的静态文件，代表"服务器当前最新是哪次构建"，请求时
// 用 no-store + 时间戳参数双重绕开缓存。
// 只要 PWA 窗口卡在旧代码上，这两个值就会不一致，从而检测出"该刷新了"。
const CURRENT_APP_BUILD_VERSION =
  typeof __APP_BUILD_VERSION__ !== "undefined" ? __APP_BUILD_VERSION__ : null;
let _versionCheckInProgress = false;

async function fetchLatestAppVersion() {
  const response = await fetch("/version.json?_=" + Date.now(), { cache: "no-store" });
  if (!response.ok) throw new Error("version.json 请求失败，HTTP " + response.status);
  const payload = await response.json();
  return String(payload?.version || "");
}

function forceReloadWithCacheBust() {
  const url = new URL(window.location.href);
  url.searchParams.set("_app_refresh", String(Date.now()));
  window.location.replace(url.toString());
}

async function checkAppVersionAndReloadIfStale() {
  if (_versionCheckInProgress) return;
  if (!CURRENT_APP_BUILD_VERSION) return;
  _versionCheckInProgress = true;
  try {
    const latestVersion = await fetchLatestAppVersion();
    if (latestVersion && latestVersion !== CURRENT_APP_BUILD_VERSION) {
      console.warn(
        "[versionCheck] 检测到新版本，当前页面代码已过期，即将自动刷新：",
        { running: CURRENT_APP_BUILD_VERSION, latest: latestVersion }
      );
      showSyncToast("发现新版本，正在更新...");
      setTimeout(() => forceReloadWithCacheBust(), 800);
    }
  } catch (error) {
    console.warn("[versionCheck] 版本检查失败：", error?.message || error);
  } finally {
    _versionCheckInProgress = false;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── 低频定时自动同步（每3分钟，后台时暂停）──────────────────────────────────────
let _periodicSyncTimer = null;
const PERIODIC_SYNC_INTERVAL_MS = 3 * 60 * 1000;

function startPeriodicSync() {
  if (_periodicSyncTimer !== null) return;
  _periodicSyncTimer = setInterval(() => {
    autoSyncCloudToLocalIfNewer();
    checkAppVersionAndReloadIfStale();
  }, PERIODIC_SYNC_INTERVAL_MS);
}

function stopPeriodicSync() {
  if (_periodicSyncTimer !== null) {
    clearInterval(_periodicSyncTimer);
    _periodicSyncTimer = null;
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

window.cloudSync = {
  mount,
  queueSavedLearning,
  showLocalFork,
  autoUploadAfterDictation,
  requestAutoUploadLocalData,
  autoSyncCloudToLocalIfNewer,
  deleteSessionAndSync,
  startPeriodicSync,
  stopPeriodicSync,
  checkAppVersionAndReloadIfStale
};

const syncNowButton = document.getElementById("dictationSyncNow");
if (syncNowButton) syncNowButton.onclick = () => autoSyncCloudToLocalIfNewer(true);
if (typeof window.addEventListener === "function") {
  window.addEventListener("online", () => autoSyncCloudToLocalIfNewer(true));
  window.addEventListener("offline", () => autoSyncCloudToLocalIfNewer(true));
  window.addEventListener("storage", event => {
    if (event.key === null || event.key === "family_english_dictation_v1") paintSyncStatus();
  });
}
paintSyncStatus();

if (supabase && !authListenerBound) {
  authListenerBound = true;
  supabase.auth.onAuthStateChange((event) => {
    window.setTimeout(() => mount(), 0);
    if (["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT", "TOKEN_REFRESHED"].includes(event)) {
      window.setTimeout(() => autoSyncCloudToLocalIfNewer(true), 0);
    }
  });
}

mount();
