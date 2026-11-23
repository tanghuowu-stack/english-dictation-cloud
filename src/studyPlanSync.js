// 学习计划里“勾了哪些词库合并听写、播放顺序”是用户级设置。
// 云端没有单独的用户设置表，这里借用每个词库已有的 user_library_settings.settings_json 存一份：
// 每个词库记下自己是否被勾选、排第几个，以及播放顺序。这样不需要改数据库表。
export const STUDY_PLAN_KEY = "studyPlanSync";

// 上传时：把本机的勾选状态写进这个词库的 settings_json。
export function attachStudyPlan(settings, localData, libraryId) {
  const ids = Array.isArray(localData?.studyLibraryIds) ? localData.studyLibraryIds : [];
  const position = ids.indexOf(libraryId);
  return {
    ...(settings || {}),
    [STUDY_PLAN_KEY]: {
      selected: position >= 0,
      position: position >= 0 ? position : null,
      playOrder: localData?.studyPlayOrder === "random" ? "random" : "ordered"
    }
  };
}

// 恢复时：从各词库的设置里取出勾选状态，并把这个字段从词库设置里去掉。
// entries 是 [{ libraryId, settings }]；云端数据都是旧版本上传的（没有这个字段）时返回 null，交给本机设置决定。
export function extractStudyPlan(entries) {
  let found = false;
  let playOrder = null;
  const selected = [];
  (entries || []).forEach(({ libraryId, settings }) => {
    const plan = settings && typeof settings === "object" ? settings[STUDY_PLAN_KEY] : null;
    if (settings && typeof settings === "object") delete settings[STUDY_PLAN_KEY];
    if (!plan || typeof plan !== "object") return;
    found = true;
    if (!playOrder && plan.playOrder) playOrder = plan.playOrder === "random" ? "random" : "ordered";
    if (plan.selected && libraryId) selected.push({ libraryId, position: Number(plan.position ?? 0) });
  });
  if (!found) return null;
  selected.sort((a, b) => a.position - b.position);
  return { studyLibraryIds: selected.map(item => item.libraryId), studyPlayOrder: playOrder || "ordered" };
}
