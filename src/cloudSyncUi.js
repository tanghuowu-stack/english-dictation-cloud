import { cloudConfigurationMessage, isCloudConfigured, supabase } from "./supabaseClient.js";
import { getCurrentUser } from "./cloudRepository.js";

let authListenerBound = false;

function getCloudElements() {
  return {
    panel: document.getElementById("cloudSyncPanel"),
    mode: document.getElementById("cloudModeText"),
    user: document.getElementById("cloudUserText"),
    email: document.getElementById("cloudEmailInput"),
    login: document.getElementById("cloudLoginBtn"),
    logout: document.getElementById("cloudLogoutBtn"),
    message: document.getElementById("cloudSyncMessage")
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
    elements.login.disabled = true;
    elements.login.hidden = false;
    elements.logout.hidden = true;
    setMessage(elements.message, cloudConfigurationMessage, true);
    return;
  }

  try {
    const user = await getCurrentUser();
    elements.mode.textContent = user ? "已登录云端" : "云端已配置";
    elements.user.textContent = user?.email || "未登录";
    elements.email.disabled = Boolean(user);
    elements.login.hidden = Boolean(user);
    elements.logout.hidden = !user;
    if (user) setMessage(elements.message, "当前仅显示登录状态，尚未启用自动同步。", false);
    else setMessage(elements.message, "未登录时仍可继续使用全部本地功能。", false);
  } catch (error) {
    elements.mode.textContent = "云端已配置";
    elements.user.textContent = "状态读取失败";
    setMessage(elements.message, error.message || "云端状态读取失败", true);
  }
}

async function sendMagicLink(elements) {
  const email = String(elements.email.value || "").trim();
  if (!email) {
    setMessage(elements.message, "请输入邮箱。", true);
    elements.email.focus();
    return;
  }

  elements.login.disabled = true;
  setMessage(elements.message, "正在发送登录链接...", false);
  try {
    const redirectTo = window.location.origin + window.location.pathname;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo }
    });
    if (error) throw error;
    setMessage(elements.message, "登录链接已发送，请到邮箱中打开。", false);
  } catch (error) {
    setMessage(elements.message, error.message || "登录链接发送失败", true);
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
  elements.login.onclick = () => sendMagicLink(elements);
  elements.logout.onclick = () => signOut(elements);
  elements.email.onkeydown = event => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendMagicLink(elements);
    }
  };
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
