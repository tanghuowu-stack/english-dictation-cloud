import { supabase } from "./supabaseClient.js";
import { extractStudyPlan } from "./studyPlanSync.js";
import { DICTATION_STATE_FORMAT, readDictationState } from "./dictationSyncState.js";

function requireCloudClient() {
  if (!supabase) throw new Error("云端未配置，当前使用本地模式");
  return supabase;
}

export async function getCurrentUser() {
  if (!supabase) return null;
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  return data.user || null;
}

// 只读本地会话（getSession 不发起网络请求验证 token），用于高频的 freshness 轮询场景。
// iOS PWA 从后台恢复的瞬间调用 auth.getUser() 的网络请求经常还没就绪就失败，
// 这里用更轻量的本地会话判断代替，减少这类检查对网络状态的依赖。
export async function getCurrentUserFromSession() {
  if (!supabase) return null;
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  return sessionData.session?.user || null;
}


function uniqueIds(ids) {
  return Array.from(new Set((ids || []).filter(Boolean).map(String)));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveDayOrNull(value) {
  const number = numberOrNull(value);
  return number != null && number > 0 ? number : null;
}

function booleanOrNull(value) {
  return value === null || value === undefined ? null : Boolean(value);
}


async function getExactCount(query) {
  const { count, error } = await query;
  if (error) throw error;
  return Number(count || 0);
}

export async function getCloudDataSummary() {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");
  const current = await readDictationState(client, user.id);
  if (current) {
    const libraries = current.data.libraries;
    const words = libraries.reduce((total, lib) => total + lib.words.length, 0);
    const sessions = libraries.reduce((total, lib) => total + lib.dailyRecords.length, 0);
    return { libraries: libraries.length, words, sessions, progress: words };
  }

  const { data: libraries, count: libraryCount, error: librariesError } = await client
    .from("libraries")
    .select("id", { count: "exact" })
    .eq("owner_id", user.id);
  if (librariesError) throw librariesError;
  const libraryIds = (libraries || []).map(library => library.id);

  const words = libraryIds.length
    ? await getExactCount(client.from("words").select("id", { count: "exact", head: true }).in("library_id", libraryIds))
    : 0;
  const sessions = await getExactCount(
    client.from("dictation_sessions").select("id", { count: "exact", head: true }).eq("user_id", user.id)
  );
  const progress = await getExactCount(
    client.from("user_word_progress").select("id", { count: "exact", head: true }).eq("user_id", user.id)
  );

  return {
    libraries: Number(libraryCount || 0),
    words,
    sessions,
    progress
  };
}

const CLOUD_PAGE_SIZE = 1000;

async function fetchAllCloudRows(client, table, columns, applyFilters) {
  const rows = [];
  let from = 0;
  while (true) {
    let query = client
      .from(table)
      .select(columns)
      .order("id", { ascending: true })
      .range(from, from + CLOUD_PAGE_SIZE - 1);
    if (applyFilters) query = applyFilters(query);
    const { data, error } = await query;
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < CLOUD_PAGE_SIZE) break;
    from += CLOUD_PAGE_SIZE;
  }
  return rows;
}

function datePart(value, fallback = null) {
  if (!value) return fallback;
  return String(value).slice(0, 10);
}

function cloudFallbackId(prefix, cloudId) {
  return prefix + "_cloud_" + String(cloudId).replaceAll("-", "");
}

function makeUniqueRestoredId(preferredId, usedIds, fallbackPrefix, cloudId) {
  const base = String(preferredId || cloudFallbackId(fallbackPrefix, cloudId));
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = base + "_" + suffix;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function makeRestoredSourceMap(record) {
  const sourceMap = {};
  const addSource = (ids, source) => {
    (ids || []).forEach(id => {
      sourceMap[id] = sourceMap[id] || [];
      if (!sourceMap[id].includes(source)) sourceMap[id].push(source);
    });
  };
  addSource(record.newWordIds, "new");
  addSource(record.pendingWrongWordIds, "wrong");
  addSource(record.delayedReviewWordIds, "review");
  return sourceMap;
}

function restoreCloudWordIds(cloudIds, cloudWordToLocalId) {
  const restored = [];
  const missing = [];
  uniqueIds(cloudIds).forEach(cloudWordId => {
    const localWordId = cloudWordToLocalId.get(cloudWordId);
    if (localWordId) restored.push(localWordId);
    else missing.push(cloudWordId);
  });
  return { restored: uniqueIds(restored), missing };
}

function restoredSettings(settingsRow) {
  if (!settingsRow) return {};
  const settings = {
    ...(settingsRow.settings_json && typeof settingsRow.settings_json === "object"
      ? settingsRow.settings_json
      : {})
  };
  if (settingsRow.daily_target_words != null) settings.dailyTargetWords = settingsRow.daily_target_words;
  if (settingsRow.daily_review_words != null) settings.dailyReviewWords = settingsRow.daily_review_words;
  if (settingsRow.review_delay_days != null) settings.reviewDelayDays = settingsRow.review_delay_days;
  if (settingsRow.pause_new_words != null) settings.pauseNewWords = settingsRow.pause_new_words;
  if (settingsRow.speech_rate != null) settings.speechRate = settingsRow.speech_rate;
  if (settingsRow.speech_voice != null) settings.speechVoiceName = settingsRow.speech_voice;
  return settings;
}

function restoreProgressOnWord(word, progress) {
  if (!progress) return;
  word.firstLearnDay = positiveDayOrNull(progress.first_learn_day);
  word.wrongCount = Number(progress.wrong_count || 0);
  word.isPendingWrong = Boolean(progress.is_pending_wrong);
  word.correctStreakInWrongPool = Number(progress.correct_streak || 0);
  word.wrongReviewDueDay = positiveDayOrNull(progress.wrong_review_due_day);
  word.delayedReviewDay = positiveDayOrNull(progress.wrong_review_due_day);
  word.wrongReviewStage = Number(progress.wrong_review_stage || 0);
  word.wrongReviewCompletedCount = Math.max(0, word.wrongReviewStage - 1);
  word.lastExitedWrongPoolDay = positiveDayOrNull(progress.last_exited_wrong_pool_day);
  word.delayedReviewCompleted = word.wrongReviewDueDay == null && !word.isPendingWrong && word.wrongCount > 0;
  word.manualFocus = booleanOrNull(progress.manual_focus);
  word.manualStubborn = booleanOrNull(progress.manual_stubborn);
  word.isFocus = word.manualFocus == null ? word.wrongCount >= 2 : word.manualFocus;
  word.isStubborn = word.manualStubborn == null ? word.wrongCount >= 3 : word.manualStubborn;
  word.skipDelayedReviewSchedule = Boolean(progress.skip_delayed_review_schedule);
  word.delayedReviewPostponed = Boolean(progress.delayed_review_postponed);
}

export async function downloadCloudDataForLocalStorage(appVersion = "1.0.0", preferredActiveLibraryLocalId = null) {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");

  const canonical = await readDictationState(client, user.id);
  if (canonical) {
    const libraries = canonical.data.libraries;
    const words = libraries.flatMap(lib => lib.words);
    const sessions = libraries.reduce((sum, lib) => sum + lib.dailyRecords.length, 0);
    const cloudCounts = {
      libraries: libraries.length, words: words.length, sessions, progress: words.length,
      maxDayNumber: libraries.reduce((max, lib) => lib.dailyRecords.reduce((m, r) => Math.max(m, r.dayNumber || 0), max), 0),
      pendingWrongProgress: words.filter(word => word.isPendingWrong).length,
      firstLearnDayNonNullProgress: words.filter(word => word.firstLearnDay != null).length,
      firstLearnDayValidProgress: words.filter(word => Number(word.firstLearnDay) > 0).length,
      skippedSessionCount: 0, skippedSessionAffectedWordCount: 0, userId: user.id
    };
    return { ...cloudCounts, skipped: 0, failed: 0, failureReasons: [], cloudCounts,
      revision: canonical.revision, updatedAt: canonical.updatedAt,
      restoredData: { ...canonical.data, losslessCloudStateVersion: DICTATION_STATE_FORMAT } };
  }

  const result = {
    libraries: 0,
    words: 0,
    sessions: 0,
    progress: 0,
    skipped: 0,
    failed: 0,
    failureReasons: [],
    cloudCounts: null,
    restoredData: null
  };

  const cloudLibraries = await fetchAllCloudRows(
    client,
    "libraries",
    "id,source_local_id,name,description,visibility,upload_complete,created_at,updated_at",
    query => query.eq("owner_id", user.id)
  );
  if (!cloudLibraries.length) throw new Error("云端没有可恢复的词库，本地数据未被覆盖");

  // Fix S3：upload_complete === false 说明这个词库上一次上传中途失败/被打断过。
  // 不阻止本次下载（云端现有数据仍然是目前能拿到的最好数据），但要清楚地记录下来，
  // 方便用户/开发者判断"要不要回那台设备重新点一次上传"。
  const incompleteUploadLibraries = cloudLibraries.filter(library => library.upload_complete === false);
  if (incompleteUploadLibraries.length) {
    console.warn(
      "[cloudSync] 检测到以下词库的上一次云端上传未完整跑完（可能中途网络中断或应用被杀死）：",
      incompleteUploadLibraries.map(library => library.name || library.id)
    );
  }

  const cloudLibraryIds = cloudLibraries.map(library => library.id);
  const cloudWords = [];
  for (const cloudLibraryId of cloudLibraryIds) {
    cloudWords.push(...await fetchAllCloudRows(
      client,
      "words",
      "id,library_id,source_local_id,original_no,entry_text,meaning,sort_order,created_at,updated_at",
      query => query.eq("library_id", cloudLibraryId)
    ));
  }
  const cloudSettings = await fetchAllCloudRows(
    client,
    "user_library_settings",
    "id,user_id,library_id,daily_target_words,daily_review_words,review_delay_days,pause_new_words,speech_rate,speech_voice,settings_json,updated_at",
    query => query.eq("user_id", user.id)
  );
  const cloudSessions = await fetchAllCloudRows(
    client,
    "dictation_sessions",
    "id,user_id,library_id,source_local_id,day_number,record_date,task_word_ids,new_word_ids,pending_wrong_word_ids,review_word_ids,wrong_word_ids,total_count,wrong_count,accuracy,created_at,updated_at",
    query => query.eq("user_id", user.id)
  );
  const cloudProgress = await fetchAllCloudRows(
    client,
    "user_word_progress",
    "id,user_id,library_id,word_id,first_learn_day,wrong_count,is_pending_wrong,correct_streak,wrong_review_due_day,wrong_review_stage,last_exited_wrong_pool_day,manual_focus,manual_stubborn,skip_delayed_review_schedule,delayed_review_postponed,created_at,updated_at",
    query => query.eq("user_id", user.id)
  );
  result.cloudCounts = {
    libraries: cloudLibraries.length,
    words: cloudWords.length,
    sessions: cloudSessions.length,
    maxDayNumber: cloudSessions.length
      ? Math.max(...cloudSessions.map(session => Number(session.day_number || 0)))
      : 0,
    progress: cloudProgress.length,
    firstLearnDayNonNullProgress: cloudProgress.filter(progress => progress.first_learn_day != null).length,
    firstLearnDayValidProgress: cloudProgress.filter(progress => positiveDayOrNull(progress.first_learn_day) != null).length,
    pendingWrongProgress: cloudProgress.filter(progress => progress.is_pending_wrong === true).length,
    userId: user.id,
    hasIncompleteUpload: incompleteUploadLibraries.length > 0,
    incompleteUploadLibraryNames: incompleteUploadLibraries.map(library => library.name || library.id)
  };
  const knownCloudWordIds = new Set(cloudWords.map(word => word.id));
  const derivedLearnedCloudWordIds = new Set();
  cloudProgress.forEach(progress => {
    if (positiveDayOrNull(progress.first_learn_day) != null && knownCloudWordIds.has(progress.word_id)) {
      derivedLearnedCloudWordIds.add(progress.word_id);
    }
  });
  cloudSessions.forEach(session => {
    uniqueIds(session.task_word_ids).forEach(wordId => {
      if (knownCloudWordIds.has(wordId)) derivedLearnedCloudWordIds.add(wordId);
    });
  });
  result.cloudCounts.derivedLearned = derivedLearnedCloudWordIds.size;

  const usedLibraryIds = new Set();
  const cloudLibraryToLocalId = new Map();
  cloudLibraries.forEach(library => {
    cloudLibraryToLocalId.set(
      library.id,
      makeUniqueRestoredId(library.source_local_id, usedLibraryIds, "lib", library.id)
    );
  });

  const cloudWordToLocalId = new Map();
  const localWordsByLibrary = new Map();
  cloudLibraries.forEach(library => localWordsByLibrary.set(library.id, []));
  cloudLibraries.forEach(library => {
    const usedWordIds = new Set();
    cloudWords
      .filter(word => word.library_id === library.id)
      .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
      .forEach((cloudWord, index) => {
        const localWordId = makeUniqueRestoredId(
          cloudWord.source_local_id,
          usedWordIds,
          "word",
          cloudWord.id
        );
        cloudWordToLocalId.set(cloudWord.id, localWordId);
        localWordsByLibrary.get(library.id).push({
          id: localWordId,
          word: String(cloudWord.entry_text || localWordId),
          meaning: cloudWord.meaning || "",
          index: numberOrNull(cloudWord.sort_order) ?? index,
          originalNo: numberOrNull(cloudWord.original_no) ?? index + 1,
          firstLearnDay: null,
          delayedReviewDay: null,
          delayedReviewCompleted: false,
          delayedReviewPostponed: false,
          wrongReviewDueDay: null,
          wrongReviewStage: 0,
          wrongReviewCompletedCount: 0,
          lastExitedWrongPoolDay: null,
          wrongCount: 0,
          lastWrongDay: null,
          lastWrongDate: null,
          isPendingWrong: false,
          correctStreakInWrongPool: 0,
          isFocus: false,
          isStubborn: false,
          manualFocus: null,
          manualStubborn: null,
          skipDelayedReviewSchedule: false
        });
      });
  });

  const progressByCloudWordId = new Map();
  cloudProgress.forEach(progress => {
    if (!cloudWordToLocalId.has(progress.word_id)) {
      result.skipped += 1;
      result.failed += 1;
      const reason = "学习进度引用了不存在的云端单词：" + progress.word_id;
      result.failureReasons.push(reason);
      // Fix S6：只跳过这一条坏的 progress 记录，不影响其余数据继续正常恢复；
      // 必须留下明确日志，避免以后再遇到类似问题只能靠人工推理代码定位。
      console.warn("[cloudSync] 已跳过一条学习进度记录（不影响其余数据恢复）：", reason);
      return;
    }
    progressByCloudWordId.set(progress.word_id, progress);
    result.progress += 1;
  });
  cloudWords.forEach(cloudWord => {
    const localWordId = cloudWordToLocalId.get(cloudWord.id);
    const localWord = (localWordsByLibrary.get(cloudWord.library_id) || [])
      .find(word => word.id === localWordId);
    if (localWord) restoreProgressOnWord(localWord, progressByCloudWordId.get(cloudWord.id));
  });

  const settingsByLibraryId = new Map(cloudSettings.map(settings => [settings.library_id, settings]));
  const sessionsByLibraryId = new Map();
  cloudLibraries.forEach(library => sessionsByLibraryId.set(library.id, []));
  // Fix S6：单条听写记录因为引用了缺失的词库/单词而无法还原时，只跳过这一条，
  // 其余记录和数据仍然正常同步下载。这里额外记录"跳过了多少条、影响了多少个单词"，
  // 供 validateCloudRestoredDataForImport 在做数量核对时把这部分正常跳过的差异排除掉，
  // 而不是因为一条坏记录就把整批恢复数据判定为 invalid、导致自动同步永久静默失效。
  let skippedSessionCount = 0;
  let skippedSessionAffectedWordCount = 0;
  cloudSessions.forEach(session => {
    if (!sessionsByLibraryId.has(session.library_id)) {
      result.skipped += 1;
      result.failed += 1;
      skippedSessionCount += 1;
      skippedSessionAffectedWordCount += uniqueIds(session.task_word_ids).length;
      const reason = "听写记录引用了不存在的云端词库：" + session.id;
      result.failureReasons.push(reason);
      console.warn("[cloudSync] 已跳过一条听写记录（其余记录仍正常恢复）：", reason);
      return;
    }

    const restoredArrays = {};
    const arrayFields = {
      taskWordIds: session.task_word_ids,
      newWordIds: session.new_word_ids,
      pendingWrongWordIds: session.pending_wrong_word_ids,
      delayedReviewWordIds: session.review_word_ids,
      wrongWordIds: session.wrong_word_ids
    };
    const missing = new Set();
    Object.entries(arrayFields).forEach(([localKey, cloudIds]) => {
      const restored = restoreCloudWordIds(cloudIds, cloudWordToLocalId);
      restoredArrays[localKey] = restored.restored;
      restored.missing.forEach(id => missing.add(id));
    });
    if (missing.size) {
      result.skipped += 1;
      result.failed += 1;
      skippedSessionCount += 1;
      skippedSessionAffectedWordCount += uniqueIds(session.task_word_ids).length;
      const reason =
        "Day " + session.day_number + " 有 " + missing.size + " 个单词无法还原（可能是单词已被删除但记录还在），已跳过该听写记录：" +
        Array.from(missing).join(",");
      result.failureReasons.push(reason);
      console.warn("[cloudSync] 已跳过一条听写记录（其余记录仍正常恢复）：", reason);
      return;
    }

    const record = {
      recordId: String(session.source_local_id || cloudFallbackId("rec", session.id)),
      dayNumber: Number(session.day_number),
      date: session.record_date || datePart(session.created_at),
      taskWordIds: restoredArrays.taskWordIds,
      newWordIds: restoredArrays.newWordIds,
      pendingWrongWordIds: restoredArrays.pendingWrongWordIds,
      delayedReviewWordIds: restoredArrays.delayedReviewWordIds,
      postponedReviewWordIds: [],
      wrongWordIds: restoredArrays.wrongWordIds,
      completedAt: session.created_at || session.updated_at || new Date().toISOString(),
      source: "cloud-restored",
      plannedNewCount: restoredArrays.newWordIds.length,
      actualNewCount: restoredArrays.newWordIds.length
    };
    record.sourceMap = makeRestoredSourceMap(record);
    sessionsByLibraryId.get(session.library_id).push(record);
    result.sessions += 1;
  });
  result.cloudCounts.skippedSessionCount = skippedSessionCount;
  result.cloudCounts.skippedSessionAffectedWordCount = skippedSessionAffectedWordCount;

  const restoredLibraries = cloudLibraries.map(cloudLibrary => {
    const words = localWordsByLibrary.get(cloudLibrary.id) || [];
    const dailyRecords = (sessionsByLibraryId.get(cloudLibrary.id) || [])
      .sort((a, b) => Number(a.dayNumber) - Number(b.dayNumber));
    const wordById = new Map(words.map(word => [word.id, word]));
    dailyRecords.forEach(record => {
      record.taskWordIds.forEach(wordId => {
        const word = wordById.get(wordId);
        if (!word) return;
        const dayNumber = positiveDayOrNull(record.dayNumber);
        if (dayNumber != null && (word.firstLearnDay == null || dayNumber < Number(word.firstLearnDay))) {
          word.firstLearnDay = dayNumber;
        }
      });
      record.wrongWordIds.forEach(wordId => {
        const word = wordById.get(wordId);
        if (!word) return;
        if (word.lastWrongDay == null || Number(record.dayNumber) >= Number(word.lastWrongDay)) {
          word.lastWrongDay = Number(record.dayNumber);
          word.lastWrongDate = record.date || null;
        }
      });
    });
    result.words += words.length;
    return {
      libraryId: cloudLibraryToLocalId.get(cloudLibrary.id),
      libraryName: cloudLibrary.name || "未命名词库",
      createdAt: datePart(cloudLibrary.created_at, new Date().toISOString().slice(0, 10)),
      // 用恢复时刻（而非 libraries 表的 Step1 时间戳）写入 updatedAt，
      // 确保它 ≥ 云端 user_word_progress.updated_at（Step5），从根源上防止时间戳误判死循环。
      updatedAt: new Date().toISOString(),
      settings: restoredSettings(settingsByLibraryId.get(cloudLibrary.id)),
      words,
      dailyRecords,
      currentDraftTask: null,
      reviewRuleVersion: "wrong-only-review-v1"
    };
  });

  result.libraries = restoredLibraries.length;
  // 取出随词库设置一起存的合并听写勾选；旧数据里没有就不带，恢复时沿用本机设置。
  const studyPlan = extractStudyPlan(restoredLibraries.map(lib => ({ libraryId: lib.libraryId, settings: lib.settings })));
  // Fix R4：自动拉取不应该把用户当前正在看的词库切换成云端返回的第一个词库。
  // 只要本机当前激活的词库在恢复结果里仍然存在，就保持它继续激活；只有在它已经不存在时
  // （比如那个词库被删了）才退回到第一个词库。
  const preferredStillExists = preferredActiveLibraryLocalId
    && restoredLibraries.some(lib => lib.libraryId === preferredActiveLibraryLocalId);
  result.restoredData = {
    version: appVersion || "1.0.0",
    activeLibraryId: preferredStillExists ? preferredActiveLibraryLocalId : (restoredLibraries[0]?.libraryId || null),
    libraries: restoredLibraries,
    ...(studyPlan || {})
  };
  return result;
}
