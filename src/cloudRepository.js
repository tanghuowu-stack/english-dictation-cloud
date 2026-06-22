import { supabase } from "./supabaseClient.js";

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

export async function ensureProfile(profile = {}) {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");

  const payload = {
    id: user.id,
    display_name: profile.displayName ?? user.user_metadata?.display_name ?? null,
    updated_at: new Date().toISOString()
  };
  const { data, error } = await client
    .from("profiles")
    .upsert(payload, { onConflict: "id" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function listCloudLibraries() {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) return [];
  const { data, error } = await client
    .from("libraries")
    .select("id, owner_id, name, description, visibility, created_at, updated_at")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function uploadLibrarySkeleton(library) {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");
  if (!library || !String(library.name || "").trim()) throw new Error("词库名称不能为空");

  const payload = {
    owner_id: user.id,
    name: String(library.name).trim(),
    description: library.description || null,
    visibility: "private"
  };
  const { data, error } = await client.from("libraries").insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function downloadLibrarySkeleton(libraryId) {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");
  const { data, error } = await client
    .from("libraries")
    .select("id, owner_id, name, description, visibility, created_at, updated_at")
    .eq("id", libraryId)
    .single();
  if (error) throw error;
  return data;
}

const CLOUD_BATCH_SIZE = 200;

function chunkRows(rows, size = CLOUD_BATCH_SIZE) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function uniqueIds(ids) {
  return Array.from(new Set((ids || []).filter(Boolean).map(String)));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validTimestamp(value, fallback = null) {
  if (!value) return fallback;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? fallback : timestamp.toISOString();
}

function recordSourceLocalId(record) {
  if (record?.recordId) return String(record.recordId);
  return "day:" + String(record?.dayNumber ?? "unknown");
}

function addFailure(result, count, context, error) {
  const amount = Math.max(1, Number(count || 1));
  result.failed += amount;
  const message = error?.message || String(error || "未知错误");
  result.failureReasons.push(context + "：" + message);
}

function mapRecordWordIds(record, wordIdMap) {
  const keys = [
    "taskWordIds",
    "newWordIds",
    "pendingWrongWordIds",
    "delayedReviewWordIds",
    "wrongReviewWordIds",
    "reviewWordIds",
    "wrongWordIds"
  ];
  const mapped = {};
  const missing = new Set();
  keys.forEach(key => {
    mapped[key] = [];
    uniqueIds(record?.[key]).forEach(localWordId => {
      const cloudWordId = wordIdMap.get(localWordId);
      if (cloudWordId) mapped[key].push(cloudWordId);
      else missing.add(localWordId);
    });
  });
  mapped.reviewWordIds = uniqueIds([
    ...mapped.reviewWordIds,
    ...mapped.delayedReviewWordIds,
    ...mapped.wrongReviewWordIds
  ]);
  return { mapped, missing: Array.from(missing) };
}

async function upsertRows(client, table, rows, onConflict, selectColumns = "") {
  const returnedRows = [];
  for (const batch of chunkRows(rows)) {
    let query = client.from(table).upsert(batch, { onConflict });
    if (selectColumns) query = query.select(selectColumns);
    const { data, error } = await query;
    if (error) throw error;
    if (Array.isArray(data)) returnedRows.push(...data);
  }
  return returnedRows;
}

export async function uploadLocalDataToCloud(localData) {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");
  if (!localData || !Array.isArray(localData.libraries)) {
    throw new Error("没有读取到有效的本地听写数据");
  }

  const result = {
    libraries: 0,
    words: 0,
    sessions: 0,
    progress: 0,
    failed: 0,
    failureReasons: []
  };

  try {
    await ensureProfile();
  } catch (error) {
    addFailure(result, 1, "用户资料", error);
  }

  for (const library of localData.libraries) {
    const localLibraryId = String(library.libraryId || "").trim();
    if (!localLibraryId) {
      addFailure(result, 1, "词库", new Error("缺少本地 libraryId"));
      continue;
    }

    let cloudLibrary;
    try {
      const { data, error } = await client
        .from("libraries")
        .upsert({
          owner_id: user.id,
          source_local_id: localLibraryId,
          name: String(library.libraryName || "未命名词库"),
          description: null,
          visibility: "private",
          updated_at: new Date().toISOString()
        }, { onConflict: "owner_id,source_local_id" })
        .select("id,source_local_id")
        .single();
      if (error) throw error;
      cloudLibrary = data;
      result.libraries += 1;
    } catch (error) {
      addFailure(result, 1, "词库“" + (library.libraryName || localLibraryId) + "”", error);
      continue;
    }

    try {
      const settings = library.settings || {};
      const { error } = await client.from("user_library_settings").upsert({
        user_id: user.id,
        library_id: cloudLibrary.id,
        daily_target_words: numberOrNull(settings.dailyTargetWords) ?? 30,
        daily_review_words: numberOrNull(settings.dailyReviewWords) ?? 30,
        review_delay_days: numberOrNull(settings.reviewDelayDays) ?? 15,
        pause_new_words: Boolean(settings.pauseNewWords),
        speech_rate: numberOrNull(settings.speechRate) ?? 0.9,
        speech_voice: settings.speechVoiceName || null,
        settings_json: settings,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,library_id" });
      if (error) throw error;
    } catch (error) {
      addFailure(result, 1, "词库设置“" + (library.libraryName || localLibraryId) + "”", error);
    }

    const localWords = Array.isArray(library.words) ? library.words : [];
    const wordRows = localWords.map((word, index) => ({
      library_id: cloudLibrary.id,
      source_local_id: String(word.id),
      original_no: numberOrNull(word.originalNo) ?? index + 1,
      entry_text: String(word.word || word.entryText || word.id || ""),
      meaning: word.meaning || null,
      sort_order: numberOrNull(word.index) ?? index,
      updated_at: new Date().toISOString()
    }));
    const wordIdMap = new Map();
    for (const batch of chunkRows(wordRows)) {
      try {
        const uploaded = await upsertRows(
          client,
          "words",
          batch,
          "library_id,source_local_id",
          "id,source_local_id"
        );
        uploaded.forEach(word => wordIdMap.set(String(word.source_local_id), word.id));
        result.words += batch.length;
      } catch (error) {
        addFailure(result, batch.length, "词库“" + (library.libraryName || localLibraryId) + "”的单词", error);
      }
    }

    const sessionRows = [];
    (library.dailyRecords || []).forEach(record => {
      const { mapped, missing } = mapRecordWordIds(record, wordIdMap);
      if (missing.length) {
        addFailure(
          result,
          1,
          "词库“" + (library.libraryName || localLibraryId) + "” Day " + record.dayNumber,
          new Error("找不到 " + missing.length + " 个单词的云端 ID")
        );
        return;
      }
      const totalCount = mapped.taskWordIds.length;
      const wrongCount = mapped.wrongWordIds.length;
      sessionRows.push({
        user_id: user.id,
        library_id: cloudLibrary.id,
        source_local_id: recordSourceLocalId(record),
        day_number: numberOrNull(record.dayNumber) ?? 0,
        record_date: record.date || null,
        task_word_ids: mapped.taskWordIds,
        new_word_ids: mapped.newWordIds,
        pending_wrong_word_ids: mapped.pendingWrongWordIds,
        review_word_ids: mapped.reviewWordIds,
        wrong_word_ids: mapped.wrongWordIds,
        total_count: totalCount,
        wrong_count: wrongCount,
        accuracy: totalCount ? Math.round(((totalCount - wrongCount) / totalCount) * 10000) / 100 : null,
        created_at: validTimestamp(record.completedAt || record.createdAt, new Date().toISOString()),
        updated_at: new Date().toISOString()
      });
    });
    for (const batch of chunkRows(sessionRows)) {
      try {
        await upsertRows(client, "dictation_sessions", batch, "user_id,library_id,source_local_id");
        result.sessions += batch.length;
      } catch (error) {
        addFailure(result, batch.length, "词库“" + (library.libraryName || localLibraryId) + "”的听写记录", error);
      }
    }

    const progressRows = localWords.flatMap(word => {
      const cloudWordId = wordIdMap.get(String(word.id));
      if (!cloudWordId) return [];
      return [{
        user_id: user.id,
        library_id: cloudLibrary.id,
        word_id: cloudWordId,
        first_learn_day: numberOrNull(word.firstLearnDay),
        wrong_count: numberOrNull(word.wrongCount) ?? 0,
        is_pending_wrong: Boolean(word.isPendingWrong),
        correct_streak: numberOrNull(word.correctStreakInWrongPool) ?? 0,
        wrong_review_due_day: numberOrNull(word.wrongReviewDueDay ?? word.delayedReviewDay),
        wrong_review_stage: numberOrNull(word.wrongReviewStage) ?? 0,
        last_exited_wrong_pool_day: numberOrNull(word.lastExitedWrongPoolDay),
        updated_at: new Date().toISOString()
      }];
    });
    for (const batch of chunkRows(progressRows)) {
      try {
        await upsertRows(client, "user_word_progress", batch, "user_id,library_id,word_id");
        result.progress += batch.length;
      } catch (error) {
        addFailure(result, batch.length, "词库“" + (library.libraryName || localLibraryId) + "”的学习进度", error);
      }
    }
  }

  return result;
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
  word.firstLearnDay = progress.first_learn_day ?? null;
  word.wrongCount = Number(progress.wrong_count || 0);
  word.isPendingWrong = Boolean(progress.is_pending_wrong);
  word.correctStreakInWrongPool = Number(progress.correct_streak || 0);
  word.wrongReviewDueDay = progress.wrong_review_due_day ?? null;
  word.delayedReviewDay = progress.wrong_review_due_day ?? null;
  word.wrongReviewStage = Number(progress.wrong_review_stage || 0);
  word.wrongReviewCompletedCount = Math.max(0, word.wrongReviewStage - 1);
  word.lastExitedWrongPoolDay = progress.last_exited_wrong_pool_day ?? null;
  word.delayedReviewCompleted = word.wrongReviewDueDay == null && !word.isPendingWrong && word.wrongCount > 0;
  word.isFocus = word.wrongCount >= 2;
  word.isStubborn = word.wrongCount >= 3;
}

export async function downloadCloudDataForLocalStorage(appVersion = "1.0.0") {
  const client = requireCloudClient();
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录云端");

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
    "id,source_local_id,name,description,visibility,created_at,updated_at",
    query => query.eq("owner_id", user.id)
  );
  if (!cloudLibraries.length) throw new Error("云端没有可恢复的词库，本地数据未被覆盖");

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
    "id,user_id,library_id,word_id,first_learn_day,wrong_count,is_pending_wrong,correct_streak,wrong_review_due_day,wrong_review_stage,last_exited_wrong_pool_day,created_at,updated_at",
    query => query.eq("user_id", user.id)
  );
  result.cloudCounts = {
    libraries: cloudLibraries.length,
    words: cloudWords.length,
    sessions: cloudSessions.length,
    progress: cloudProgress.length
  };

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
          manualStubborn: null
        });
      });
  });

  const progressByCloudWordId = new Map();
  cloudProgress.forEach(progress => {
    if (!cloudWordToLocalId.has(progress.word_id)) {
      result.skipped += 1;
      result.failed += 1;
      result.failureReasons.push("学习进度引用了不存在的云端单词：" + progress.word_id);
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
  cloudSessions.forEach(session => {
    if (!sessionsByLibraryId.has(session.library_id)) {
      result.skipped += 1;
      result.failed += 1;
      result.failureReasons.push("听写记录引用了不存在的云端词库：" + session.id);
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
      result.failureReasons.push(
        "Day " + session.day_number + " 有 " + missing.size + " 个单词无法还原，已跳过该听写记录"
      );
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

  const restoredLibraries = cloudLibraries.map(cloudLibrary => {
    const words = localWordsByLibrary.get(cloudLibrary.id) || [];
    const dailyRecords = (sessionsByLibraryId.get(cloudLibrary.id) || [])
      .sort((a, b) => Number(a.dayNumber) - Number(b.dayNumber));
    const wordById = new Map(words.map(word => [word.id, word]));
    dailyRecords.forEach(record => {
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
      updatedAt: datePart(cloudLibrary.updated_at, new Date().toISOString().slice(0, 10)),
      settings: restoredSettings(settingsByLibraryId.get(cloudLibrary.id)),
      words,
      dailyRecords,
      currentDraftTask: null,
      reviewRuleVersion: "wrong-only-review-v1"
    };
  });

  result.libraries = restoredLibraries.length;
  result.restoredData = {
    version: appVersion || "1.0.0",
    activeLibraryId: restoredLibraries[0]?.libraryId || null,
    libraries: restoredLibraries
  };
  return result;
}
