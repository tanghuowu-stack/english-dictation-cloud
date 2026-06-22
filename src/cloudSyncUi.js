import { cloudConfigurationMessage, isCloudConfigured, supabase } from "./supabaseClient.js";
import {
  getCloudDataSummary,
  getCurrentUser,
  uploadLocalDataToCloud
} from "./cloudRepository.js";

let authListenerBound = false;

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
    summaryPanel: document.getElementById("cloudDataSummary"),
    libraryCount: document.getElementById("cloudLibraryCount"),
    wordCount: document.getElementById("cloudWordCount"),
    sessionCount: document.getElementById("cloudSessionCount"),
    progressCount: document.getElementById("cloudProgressCount"),
    actionMessage: document.getElementById("cloudActionMessage")
  };
}

function setMessage(element, text, isError = false) {
  if (!element) return;
  element.textContent = text || "";
  element.classList.toggle("danger-text", isError);
  element.classList.toggle("ok-text", Boolean(text) && !isError);
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
    if (!user) elements.summaryPanel.hidden = true;
    if (user) setMessage(elements.message, "当前仅显示登录状态，尚未启用自动同步。", false);
    else setMessage(elements.message, "未登录时仍可继续使用全部本地功能。", false);
  } catch (error) {
    elements.mode.textContent = "云端已配置";
    elements.user.textContent = "状态读取失败";
    setMessage(elements.message, error.message || "云端状态读取失败", true);
  }
}

function getLocalDataSnapshot() {
  if (typeof window.getLocalDictationDataForCloudUpload !== "function") {
    throw new Error("无法读取本地听写数据");
  }
  return window.getLocalDictationDataForCloudUpload();
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
    setMessage(elements.message, "登录成功。当前仅显示登录状态，尚未启用自动同步。", false);
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

async function mount() {
  const elements = getCloudElements();
  if (!elements.panel) return;
  elements.login.onclick = () => signInWithEmailPassword(elements);
  elements.logout.onclick = () => signOut(elements);
  elements.upload.onclick = () => uploadLocalData(elements);
  elements.summary.onclick = () => showCloudSummary(elements);
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

window.cloudSync = { mount };

if (supabase && !authListenerBound) {
  authListenerBound = true;
  supabase.auth.onAuthStateChange(() => {
    window.setTimeout(() => mount(), 0);
  });
}

mount();
