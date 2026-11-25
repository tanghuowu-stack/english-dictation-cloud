import { decideDictationSync, hasLearningDraft, learningFingerprint, learningSnapshot, validLearningSnapshot } from './dictationSyncState.js';

const conflictMessages = {
  'data-conflict': '本机与云端版本不一致，两份数据均已保留。请先导出本机备份，再核对差异。',
  'account-conflict': '本机数据属于另一云端账号；未上传或覆盖。',
  'legacy-conflict': '未找到对应的无损云端版本，或云端仍是旧版数据；未上传或覆盖。',
  'draft-conflict': '本机有听写草稿，已暂停云端覆盖。请先处理草稿。'
};

export async function runDictationSyncCycle(io) {
  const raw = io.readLocal();
  if (!io.isCurrent(raw)) return 'changed';
  const local = JSON.parse(raw);
  const snapshot = learningSnapshot(local);
  if (!validLearningSnapshot(snapshot)) throw new Error('本机学习数据结构无效；未同步。');
  const user = await io.getUser();
  const journal = local.dictationSyncJournal || {};
  const pending = Boolean(local.pendingCloudUpload);
  if (!user) {
    if (pending || journal.owner) io.checkpoint(raw, { journal: { ...journal, error: '未登录云端；本机学习数据已保留。' }, pending });
    return 'signed-out';
  }
  const localHash = await learningFingerprint(snapshot);
  const remote = await io.readRemote(user.id, journal);
  const remoteHash = remote?.hash || (remote ? await learningFingerprint(remote.data) : null);
  const legacyExists = !remote && await io.hasLegacy(user.id);
  if (!io.isCurrent(raw)) return 'changed';
  const choice = decideDictationSync({ userId: user.id, journal, pending, localHash, remote, remoteHash, legacyExists,
    draft: hasLearningDraft(snapshot), canInitialize: snapshot.libraries.some(lib => lib.words.length || lib.dailyRecords.length) });
  if (conflictMessages[choice]) {
    io.checkpoint(raw, { journal: { ...journal, error: conflictMessages[choice] }, pending });
    return 'conflict';
  }
  if (choice === 'idle') return 'idle';
  const receipt = (rev, at, baseHash, successAt = at) => ({ owner:user.id, revision:rev, baseHash, lastSuccessAt:successAt, pristine:false, error:null });
  if (choice === 'ack' || choice === 'pull') {
    if (!await io.isOwner(user.id)) return 'changed';
    const syncAt = choice === 'ack' && journal.revision === remote.revision && !pending
      ? journal.lastSuccessAt || remote.updatedAt : new Date().toISOString();
    if (!io.checkpoint(raw, { journal: receipt(remote.revision,remote.updatedAt,remoteHash,syncAt), pending:false,
      replacement: choice === 'pull' ? remote.data : undefined })) return 'changed';
    return choice;
  }
  const saved = await io.writeRemote(user.id, choice === 'new' ? 0 : remote.revision, snapshot);
  if (!saved) return 'changed'; // A concurrent remote commit may be identical, or a conflict, on the next read.
  if (!await io.isOwner(user.id)) return 'changed';
  const latestRaw = io.readLocal();
  if (!io.isCurrent(latestRaw)) return 'changed';
  const latest = JSON.parse(latestRaw);
  if ((latest.dictationSyncJournal?.owner && latest.dictationSyncJournal.owner !== user.id)
    || (latest.dictationSyncJournal?.revision || 0) > saved.revision) return 'changed';
  const latestHash = latestRaw === raw ? localHash : await learningFingerprint(learningSnapshot(latest));
  if (!io.checkpoint(latestRaw, { journal:receipt(saved.revision,saved.updatedAt,localHash), pending:latestHash !== localHash })) return 'changed';
  return latestHash === localHash ? 'push' : 'changed';
}
