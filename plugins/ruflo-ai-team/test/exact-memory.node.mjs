import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStore, FirestoreStore } from '../src/store.mjs';
import { TenantVectorMemory } from '../src/vector-memory.mjs';

test('exact key wins over identical distractor text and avoids index construction', async () => {
  const store = new InMemoryStore();
  await store.remember('a',{teamId:'team-a',key:'receipt:2026:accepted',text:'actual retained finding'});
  await store.remember('a',{teamId:'team-a',key:'distractor',text:'receipt:2026:accepted'});
  store.listMemories = async () => { throw Error('must not build snapshot'); };
  const vectors = new TenantVectorMemory(store,{VectorDb:class { constructor(){throw Error('must not initialize native');} }});
  const result = await vectors.search('a',{teamId:'team-a',query:'receipt:2026:accepted',limit:1});
  assert.equal(result.backend,'canonical-exact');
  assert.equal(result.degraded,false); assert.equal(result.results[0].score,1);
  assert.equal(result.results[0].match,'exact-id');
  assert.equal(result.results[0].memory.text,'actual retained finding');
  assert.equal(vectors.indexes.size,0);
});

test('exact reads enforce tenant and team isolation and return copies', async () => {
  const s = new InMemoryStore();
  await s.remember('a',{teamId:'one',key:'shared-key',text:'private'});
  assert.equal(await s.getMemory('b','shared-key',{teamId:'one'}),null);
  assert.equal(await s.getMemory('a','shared-key',{teamId:'two'}),null);
  const copy=await s.getMemory('a','shared-key',{teamId:'one'}); copy.text='mutated';
  assert.equal((await s.getMemory('a','shared-key')).text,'private');
  const r=await new TenantVectorMemory(s).search('a',{teamId:'two',query:'shared-key'});
  assert.deepEqual(r.results,[]);
});

test('canonical read observes updates even with a warm stale similarity index', async () => {
  const s=new InMemoryStore(), v=new TenantVectorMemory(s);
  await s.remember('a',{teamId:'one',key:'stable',text:'old'});
  await v.search('a',{teamId:'one',query:'old text'});
  await s.remember('a',{teamId:'one',key:'stable',text:'new'});
  assert.equal((await v.search('a',{teamId:'one',query:'stable'})).results[0].memory.text,'new');
  await s.remember('a',{teamId:'two',key:'stable',text:'moved'});
  assert.deepEqual((await v.search('a',{teamId:'one',query:'stable'})).results,[]);
});

test('missing exact key retains similarity fallback and legacy store adapters', async () => {
  const s=new InMemoryStore(); await s.remember('a',{teamId:'one',key:'id',text:'known concept'});
  const v=new TenantVectorMemory(s);
  const r=await v.search('a',{teamId:'one',query:'known'});
  assert.equal(r.backend,'lexical-degraded'); assert.equal(r.results[0].memory.id,'id');
  s.getMemory=undefined;
  assert.equal((await new TenantVectorMemory(s).search('a',{query:'known concept'})).results[0].memory.id,'id');
});

test('Firestore exact lookup bypasses listing cap, scopes tenant path, and filters team', async () => {
  const rows=new Map(); for(let i=0;i<1001;i++) rows.set('r'+i,{id:'r'+i,teamId:'one',text:'item'});
  let reads=0; const paths=[];
  const db={collection(name){paths.push(name);return {doc(tenant){paths.push(tenant);return {collection(kind){paths.push(kind);return {doc(id){paths.push(id);return {async get(){reads++;const d=tenant==='a'?rows.get(id):null;return {exists:!!d,data:()=>d};}};}};}};}};}};
  const s=new FirestoreStore(db), v=new TenantVectorMemory(s);
  const r=await v.search('a',{teamId:'one',query:'r1000'});
  assert.equal(r.results[0].memory.id,'r1000'); assert.equal(reads,1);
  assert.deepEqual(paths,['ruflo_ai_team_tenants','a','memories','r1000']);
  assert.equal(await s.getMemory('b','r1000',{teamId:'one'}),null);
  assert.equal(await s.getMemory('a','r1000',{teamId:'other'}),null);
});

test('unsafe/reserved document keys never reach Firestore', async () => {
  const s=new FirestoreStore({collection(){throw Error('unexpected database call');}});
  for(const key of ['a/b','.','..','__reserved__','x'.repeat(161),'\0']) assert.equal(await s.getMemory('a',key),null);
});

test('canonical database errors propagate rather than becoming approximate success', async () => {
  const s={getMemory:async()=>{throw Error('unavailable');},listMemories:async()=>[]};
  await assert.rejects(new TenantVectorMemory(s).search('a',{teamId:'one',query:'receipt-id'}),/unavailable/);
});

test('native fallback excludes stale canonical keys after team reassignment', async () => {
  const s=new InMemoryStore(); await s.remember('a',{teamId:'one',key:'stable',text:'old'});
  class FakeDb { async insert(x){this.id=x.id;} async search(){return [{id:this.id,score:1}];} }
  const v=new TenantVectorMemory(s,{VectorDb:FakeDb});
  await v.search('a',{teamId:'one',query:'some words'});
  await s.remember('a',{teamId:'two',key:'stable',text:'new'});
  assert.deepEqual((await v.search('a',{teamId:'one',query:'stable'})).results,[]);
});

test('legacy reserved keys retain similarity fallback', async () => {
  const s=new InMemoryStore(); await s.remember('a',{teamId:'one',key:'__legacy__',text:'legacy'});
  const r=await new TenantVectorMemory(s).search('a',{teamId:'one',query:'__legacy__'});
  assert.equal(r.backend,'lexical-degraded'); assert.equal(r.results[0].memory.id,'__legacy__');
});
