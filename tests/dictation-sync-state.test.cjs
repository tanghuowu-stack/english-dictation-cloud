const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const stateModule = () => import('../src/dictationSyncState.js');
const cycleModule = () => import('../src/dictationSyncCycle.js');
const sample = () => ({ version:'1.0.0', activeLibraryId:'lib', studyLibraryIds:['lib'], studyPlayOrder:'random',
  pendingCloudUpload:true, pendingCloudUploadSince:'2026-09-01',
  combinedDraftTask:{ mode:'mark', currentIndex:0, checkedWrongWordIds:[], parts:[{libraryId:'lib'}] },
  libraries:[{libraryId:'lib', libraryName:'词库', settings:{pauseNewWords:false, dailyReviewWords:0},
    currentDraftTask:{currentIndex:0, answerShown:false, optional:null},
    words:[{id:'zero', wrongCount:0, wrongReviewDueDay:null, delayedReviewDay:12, hasWrongReviewFailure:false, wrongReviewCompletedCount:3}, {id:'missing'}],
    dailyRecords:[{recordId:'rec', plannedNewCount:0, supplementReviewWordIds:['zero'], actualNewCount:0, source:'normal'}]}] });

function isolatedApp() {
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const source=html.slice(html.indexOf('  <script>')+'  <script>'.length,html.indexOf('    window.addEventListener("beforeunload"'));
  const storage=new Map();
  const ctx=vm.createContext({console,localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}});
  ctx.window=ctx;
  vm.runInContext(source,ctx);
  return {ctx, storage};
}

test('exact state survives cloud serialization, app restore and restart without running legacy derivation', async () => {
  const {learningSnapshot, decodeDictationState} = await stateModule();
  const input = process.env.DICTATION_ROUND_TRIP_FIXTURE
    ? JSON.parse(fs.readFileSync(process.env.DICTATION_ROUND_TRIP_FIXTURE)) : sample();
  const expected = learningSnapshot(input);
  const row = process.env.DICTATION_CLOUD_ROUND_TRIP_FIXTURE
    ? JSON.parse(fs.readFileSync(process.env.DICTATION_CLOUD_ROUND_TRIP_FIXTURE)).dictation_sync_states[0]
    : JSON.parse(JSON.stringify({format_version:1, revision:1, updated_at:'2026-11-25', payload:expected}));
  const result = decodeDictationState(row);
  const {ctx} = isolatedApp();
  ctx.replaceLocalDictationDataFromCloud({...result.data,losslessCloudStateVersion:1});
  vm.runInContext('loadData()',ctx);
  assert.deepEqual(learningSnapshot(ctx.getLocalDictationDataForCloudUpload()), expected);
  assert.equal('pendingCloudUpload' in result.data,false);
  if (!process.env.DICTATION_ROUND_TRIP_FIXTURE) {
    assert.equal(result.data.libraries[0].words[0].wrongReviewDueDay,null);
    assert.equal(result.data.libraries[0].words[0].hasWrongReviewFailure,false);
    assert.equal(result.data.libraries[0].words[0].wrongCount,0);
    assert.equal(Object.hasOwn(result.data.libraries[0].words[1],'wrongCount'),false);
  }
});

test('validates IDs and rejects unrecognized or malformed cloud snapshots without fallback', async () => {
  const {learningSnapshot,decodeDictationState}=await stateModule();
  const data=learningSnapshot(sample());
  assert.equal(decodeDictationState(null),null);
  assert.throws(()=>decodeDictationState({format_version:2,revision:1,payload:data}),/不受支持/);
  data.libraries[0].words[1].id='zero';
  assert.throws(()=>decodeDictationState({format_version:1,revision:1,payload:data}),/不受支持/);
});

test('exact restore cannot replace live state if local storage rejects writes', async () => {
  const {ctx}=isolatedApp();
  const d={...sample(),losslessCloudStateVersion:1};
  ctx.replaceLocalDictationDataFromCloud(d);
  ctx.localStorage.setItem=()=>{throw new Error('quota');};
  assert.throws(()=>ctx.replaceLocalDictationDataFromCloud({...d,studyPlayOrder:'ordered'}),/quota/);
  assert.equal(vm.runInContext('data.studyPlayOrder',ctx),'random');
  assert.equal(ctx.getLocalDictationDataForCloudUpload().studyPlayOrder,'random');
});

test('write requires a known revision and never treats a rejected compare-and-swap as success', async () => {
  const {writeDictationState}=await stateModule();
  const rpc=async (name,args)=>{
    assert.equal(name,'save_dictation_sync_state_for_owner');
    assert.equal(args.p_owner,'uid');
    assert.equal(args.p_expected_revision,3);
    assert.equal('pendingCloudUpload' in args.p_payload,false);
    return {data:null,error:null};
  };
  assert.equal(await writeDictationState({rpc},'uid',3,sample()),null);
  await assert.rejects(writeDictationState({rpc},'uid',undefined,sample()),/版本/);
});

async function syncFixture({ synced = true, pending = false } = {}) {
  const {learningSnapshot,learningFingerprint}=await stateModule();
  const original=learningSnapshot(sample());
  let local={...structuredClone(original),pendingCloudUpload:pending,dictationSyncJournal:synced
    ? {owner:'uid',revision:1,baseHash:await learningFingerprint(original)} : {}};
  let remote={ revision:1, updatedAt:'2026-11-25', data:original };
  let user={id:'uid'};
  let writes=0;
  const raw=()=>JSON.stringify(local);
  const io={readLocal:raw, isCurrent:expected=>expected===raw(),getUser:async()=>user,isOwner:async owner=>owner===user?.id,
    readRemote:async()=>remote, hasLegacy:async()=>false,
    checkpoint(expected,{journal,pending,replacement}){
      if(expected!==raw())return false;
      local={...(replacement||local),dictationSyncJournal:journal,pendingCloudUpload:pending};return true;
    },
    writeRemote:async(owner,expected,data)=>{
      writes++;
      if(owner!==user?.id || expected!==remote?.revision)return null;
      remote={revision:expected+1, updatedAt:'2026-11-26',data};return remote;
    }
  };
  return {io, get local(){return local;}, get remote(){return remote;}, set remote(value){remote=value;},
    get writes(){return writes;}, set user(value){user=value;}};
}

test('pending state remains queued while signed out and is sent on authentication recovery', async () => {
  const {runDictationSyncCycle}=await cycleModule();
  const f=await syncFixture({pending:true});
  f.local.combinedDraftTask.currentIndex=9;
  f.user=null;
  assert.equal(await runDictationSyncCycle(f.io),'signed-out');
  assert.equal(f.local.pendingCloudUpload,true);
  assert.match(f.local.dictationSyncJournal.error,/未登录/);
  f.user={id:'uid'};
  assert.equal(await runDictationSyncCycle(f.io),'push');
  assert.equal(f.local.pendingCloudUpload,false);
  assert.equal(f.local.dictationSyncJournal.error,null);
  assert.equal(f.remote.data.combinedDraftTask.currentIndex,9);
});

test('pending data, unbased or imported snapshots and dirty older devices never overwrite the cloud', async () => {
  const {runDictationSyncCycle}=await cycleModule();
  for (const kind of ['stale','unbased','imported','wrong-account']) {
    const f=await syncFixture({synced:kind!=='unbased',pending:true});
    f.local.combinedDraftTask.currentIndex=8;
    f.local.pendingCloudUploadSince='2026-08-21T00:00:00Z';
    if(kind==='stale')f.remote={...f.remote,revision:2};
    if(kind==='imported')f.local.dictationSyncJournal.requiresReview=true;
    if(kind==='wrong-account')f.user={id:'another'};
    assert.equal(await runDictationSyncCycle(f.io),'conflict');
    assert.equal(f.local.pendingCloudUpload,true);
    assert.equal(f.local.pendingCloudUploadSince,'2026-08-21T00:00:00Z');
    assert.equal(f.local.combinedDraftTask.currentIndex,8);
    assert.equal(f.writes,0);
  }
});

test('a verified cloud write acknowledges only the data it sent, retaining edits during upload', async () => {
  const {runDictationSyncCycle}=await cycleModule();
  const f=await syncFixture({pending:true});
  f.local.combinedDraftTask.currentIndex=4;
  const save=f.io.writeRemote;
  f.io.writeRemote=async (...args)=>{
    f.local.combinedDraftTask.currentIndex=5;
    return save(...args);
  };
  assert.equal(await runDictationSyncCycle(f.io),'changed');
  assert.equal(f.remote.data.combinedDraftTask.currentIndex,4);
  assert.equal(f.local.pendingCloudUpload,true);
  assert.equal(f.local.dictationSyncJournal.revision,2);
  f.io.writeRemote=save;
  assert.equal(await runDictationSyncCycle(f.io),'push');
  assert.equal(f.remote.data.combinedDraftTask.currentIndex,5);
  assert.equal(f.local.pendingCloudUpload,false);
});

test('a new browser can restore exactly, but a draft or mid-read edit stops automatic overwrite', async () => {
  const {runDictationSyncCycle}=await cycleModule();
  const blank=await syncFixture({synced:false});
  blank.local.libraries[0].words=[];
  blank.local.combinedDraftTask=null;
  blank.local.dictationSyncJournal={pristine:true};
  assert.equal(await runDictationSyncCycle(blank.io),'pull');
  assert.deepEqual(blank.local.combinedDraftTask,blank.remote.data.combinedDraftTask);

  const draft=await syncFixture();
  draft.remote={...draft.remote,revision:2,data:{...draft.remote.data,combinedDraftTask:null}};
  assert.equal(await runDictationSyncCycle(draft.io),'conflict');
  assert.ok(draft.local.combinedDraftTask);

  const changed=await syncFixture({synced:false});
  changed.local.dictationSyncJournal={pristine:true};
  changed.local.libraries[0].words=[];
  changed.io.readRemote=async()=>{
    changed.local.libraries[0].words.push({id:'just-added'});
    return changed.remote;
  };
  assert.equal(await runDictationSyncCycle(changed.io),'changed');
  assert.equal(changed.local.libraries[0].words[0].id,'just-added');
});

test('draft changes and pending metadata survive refresh without mixing them into the cloud payload', async () => {
  const {ctx}=isolatedApp();
  ctx.replaceLocalDictationDataFromCloud({...sample(),pendingCloudUpload:false,losslessCloudStateVersion:1});
  vm.runInContext('data.combinedDraftTask.currentIndex = 6; saveData(); loadData();',ctx);
  const saved=ctx.getLocalDictationDataForCloudUpload();
  assert.equal(saved.combinedDraftTask.currentIndex,6);
  assert.equal(saved.pendingCloudUpload,true);
  assert.ok(saved.pendingCloudUploadSince);
  const {learningSnapshot}=await stateModule();
  assert.equal('dictationSyncJournal' in learningSnapshot(saved),false);
});

test('acknowledging the original device also disables legacy history inference on its next reload', () => {
  const {ctx,storage}=isolatedApp();
  const old=sample();
  storage.set('family_english_dictation_v1',JSON.stringify(old));
  vm.runInContext('loadData()',ctx);
  const raw=ctx.readDictationSyncLocal();
  assert.equal(ctx.checkpointDictationSync(raw,{journal:{owner:'uid',revision:1},pending:false}),true);
  assert.equal(ctx.getLocalDictationDataForCloudUpload().losslessCloudStateVersion,1);
  const {ctx:next,storage:nextStorage}=isolatedApp();
  nextStorage.set('family_english_dictation_v1',ctx.readDictationSyncLocal());
  vm.runInContext('migrateLibrary = () => { throw Error("legacy migration called"); }; loadData()',next);
});

test('legacy records without an ID may be identified by an unambiguous Day without inserting a field', async () => {
  const {learningSnapshot,validLearningSnapshot}=await stateModule();
  const data=sample();
  data.libraries[0].dailyRecords=[{dayNumber:1},{dayNumber:2,recordId:null}];
  assert.equal(validLearningSnapshot(data),true);
  const records=learningSnapshot(data).libraries[0].dailyRecords;
  assert.equal(Object.hasOwn(records[0],'recordId'),false);
  assert.equal(records[1].recordId,null);
  records.push({dayNumber:1});
  assert.equal(validLearningSnapshot(data),true);
  data.libraries[0].dailyRecords.push({dayNumber:1});
  assert.equal(validLearningSnapshot(data),false);
});
