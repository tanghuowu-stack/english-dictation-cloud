export const DICTATION_STATE_FORMAT = 1;

// Transport the actual persisted learning state, not a reconstruction from
// session summaries. Keep device bookkeeping out of the account snapshot.
const DEVICE_KEYS = new Set(['pendingCloudUpload', 'pendingCloudUploadSince', 'losslessCloudStateVersion', 'dictationSyncJournal']);

export function learningSnapshot(data) {
  if (!data || !Array.isArray(data.libraries)) throw new Error('无效的本地学习数据');
  return JSON.parse(JSON.stringify(Object.fromEntries(
    Object.entries(data).filter(([key]) => !DEVICE_KEYS.has(key))
  )));
}

export function validLearningSnapshot(data) {
  if (!data || !Array.isArray(data.libraries) || !data.libraries.length) return false;
  const ids = new Set();
  for (const lib of data.libraries) {
    if (!lib || typeof lib.libraryId !== 'string' || !lib.libraryId || ids.has(lib.libraryId)
      || !lib.settings || typeof lib.settings !== 'object' || Array.isArray(lib.settings)
      || !Array.isArray(lib.words) || !Array.isArray(lib.dailyRecords)) return false;
    ids.add(lib.libraryId);
    for (const [rows, key] of [[lib.words, 'id'], [lib.dailyRecords, 'recordId']]) {
      const rowIds = rows.map(row => row?.[key]);
      if (rowIds.some(id => typeof id !== 'string' || !id) || new Set(rowIds).size !== rows.length) return false;
    }
  }
  return ids.has(data.activeLibraryId);
}

export const canonicalJson = data => JSON.stringify(data, (_key, value) => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
    : value
));

export async function learningFingerprint(snapshot) {
  const bytes = new TextEncoder().encode(canonicalJson(snapshot));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

export const hasLearningDraft = data => Boolean(data.combinedDraftTask || data.libraries.some(lib => lib.currentDraftTask));

export function decideDictationSync({ userId, journal, pending, localHash, remote, remoteHash, legacyExists, draft, canInitialize }) {
  if (journal.owner && journal.owner !== userId) return 'account-conflict';
  if (remote && localHash === remoteHash) return 'ack';
  if (journal.requiresReview) return 'data-conflict';
  if (!remote) {
    if (journal.revision > 0 || legacyExists) return 'legacy-conflict';
    return pending && canInitialize ? 'new' : 'idle';
  }
  if (journal.pristine && !pending) return 'pull';
  if (journal.revision === remote.revision && pending && localHash !== journal.baseHash) return 'push';
  if (journal.revision > 0 && journal.revision < remote.revision && !pending && localHash === journal.baseHash) {
    return draft ? 'draft-conflict' : 'pull';
  }
  return 'data-conflict';
}

export function decodeDictationState(row) {
  if (row == null) return null;
  if (row.format_version !== DICTATION_STATE_FORMAT || !Number.isSafeInteger(row.revision) || row.revision < 1
    || !validLearningSnapshot(row.payload)) throw new Error('云端学习快照格式不受支持；没有覆盖本机数据。');
  return { revision: row.revision, updatedAt: row.updated_at, data: learningSnapshot(row.payload) };
}

export async function readDictationState(client, userId) {
  const { data, error } = await client.from('dictation_sync_states')
    .select('format_version,revision,updated_at,payload').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return decodeDictationState(data);
}

export async function readDictationRevision(client, userId) {
  const { data, error } = await client.from('dictation_sync_states')
    .select('format_version,revision,updated_at').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (data && (data.format_version !== DICTATION_STATE_FORMAT || !Number.isSafeInteger(data.revision) || data.revision < 1)) {
    throw new Error('云端版本不受支持。');
  }
  return data;
}

export async function writeDictationState(client, userId, expectedRevision, snapshot) {
  if (!validLearningSnapshot(snapshot)) throw new Error('学习数据结构无效；未上传。');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('缺少已确认的云端版本；未上传。');
  if (!userId) throw new Error('未登录云端；未上传。');
  const { data, error } = await client.rpc('save_dictation_sync_state_for_owner', {
    p_owner: userId,
    p_expected_revision: expectedRevision,
    p_payload: learningSnapshot(snapshot)
  });
  if (error) throw error;
  return data && Number.isSafeInteger(data.revision) && data.revision === expectedRevision + 1
    ? { revision: data.revision, updatedAt: data.updated_at }
    : null;
}
