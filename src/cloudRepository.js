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
