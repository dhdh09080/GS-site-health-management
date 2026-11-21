import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {schedule,vault,weatherPoster,sendMessage,deliver,Problem,kakaoToken} from '../server/poster/service.js';
import {kstDate} from '../src/lib/weather-poster.js';

test('KST schedule selection, validation and credential binding',()=>{
 assert.deepEqual(schedule({time:'06:15',days:[6,1,4],enabled:true}),{minute:375,days:[1,4,6],enabled:true});
 for(const invalid of [{time:'24:00'},{time:'06:60'},{days:[]},{days:[0]},{enabled:1}])
   assert.throws(()=>schedule({time:'06:00',days:[1],enabled:true,...invalid}),Problem);
 const v=vault(randomBytes(32).toString('base64')),cipher=v.seal('fictional-destination','A');
 assert.equal(v.open(cipher,'A'),'fictional-destination');assert.throws(()=>v.open(cipher,'B'));
});
test('real poster PNG reaches Telegram multipart and Kakao original image card in isolated transports',async()=>{
 const date=kstDate(), forecast={date,hours:Array.from({length:14},(_,i)=>({hour:6+i,temp:5,wind:3,feel:2}))};
 const site={name:'가상 기계설비 건설 현장',address:'서울특별시 성동구',latitude:37.5,longitude:127.04};
 const png=await weatherPoster(site,async b=>b.action==='forecast'?forecast:{report:{issuedAt:date+'T05:00:00+09:00',active:'강풍주의보 : 서울특별시(서울동북권)'}});
 assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),2520);assert.equal(png.readUInt32BE(20),3564);
 await sendMessage({channel:'telegram',target:'fixture-room',token:'fixture',siteName:site.name,png},async(url,opts)=>{
   assert.match(url,/\/sendPhoto$/);assert.equal(opts.body.get('chat_id'),'fixture-room');
   assert.deepEqual(Buffer.from(await opts.body.get('photo').arrayBuffer()),png);
   return Response.json({ok:true,result:{message_id:123}});
 });
 const original='https://example.test/api/poster-delivery?action=image&id='+randomUUID();
 await sendMessage({channel:'kakao',token:'fixture',siteName:site.name,url:original,origin:'https://example.test'},async(url,opts)=>{
   assert.match(url,/memo\/default\/send$/);const card=JSON.parse(opts.body.get('template_object'));
   assert.equal(card.content.image_url,original);assert.equal(card.content.link.web_url,original);
   assert.equal(opts.headers.Authorization,'Bearer fixture');return Response.json({result_code:0});
 });
 const fresh=await kakaoToken({grant_type:'refresh_token',refresh_token:'fake'},{KAKAO_REST_API_KEY:'fake'},async(_,opts)=>{
   assert.equal(opts.body.get('grant_type'),'refresh_token');return Response.json({access_token:'rotated',refresh_token:'new'});
 });assert.equal(fresh.refresh_token,'new');
 await assert.rejects(weatherPoster({...site,latitude:null},()=>{}),/좌표/);
});
test('gateway uncertainty, explicit rejection and stale settings keep distinct delivery outcomes',async()=>{
 for(const [begin,send,status] of [[false,()=>{},'failed'],[true,()=>{throw Error('lost acknowledgement');},'unknown'],
   [true,()=>{throw new Problem('메신저 거절');},'failed'],[true,()=>{},'sent']]){
   let attempts=0,results=[];
   await deliver({}, {prepare:async()=>({}),begin:async()=>begin,send:async()=>{attempts++;send();},finish:async(_,s)=>results.push(s)});
   assert.equal(attempts,begin?1:0);assert.deepEqual(results,[status]);
 }
});
test('SQL worker isolates two sites, claims one slot, fences disconnect and enforces member removal',async()=>{
 const db=new PGlite();try {
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key);create table workspaces(id uuid primary key,owner_id uuid,status text);
 create table workspace_members(workspace_id uuid,user_id uuid,role text);`);
 await db.exec(await readFile(new URL('../supabase/site_poster_delivery.sql',import.meta.url),'utf8'));
 const u=randomUUID(),v=randomUUID(),a=randomUUID(),b=randomUUID(),sub=randomUUID(),priv=randomUUID();
 await db.query('insert into auth.users values($1),($2)',[u,v]);
 await db.query("insert into workspaces values($1,$2,'active'),($3,$2,'active')",[a,u,b]);await db.query("insert into workspace_members values($1,$2,'member')",[a,v]);
 const minute="extract(hour from now() at time zone 'Asia/Seoul')::int*60+extract(minute from now() at time zone 'Asia/Seoul')::int";
 await db.query(`insert into poster_subscriptions(id,workspace_id,user_id,channel,enabled,destination,minute)
 values ($1,$2,null,'telegram',true,'encrypted',${minute}),($3,$2,$4,'kakao',false,'private',${minute}),($5,$6,null,'telegram',false,'different',${minute})`,[sub,a,priv,v,randomUUID(),b]);
 const claim=()=>db.query('select * from claim_poster_deliveries()');
 const j=(await claim()).rows[0];assert.equal(j.subscription_id,sub);assert.equal((await claim()).rows.length,0);
 const begin=(job)=>db.query('select begin_poster_send($1,$2,$3,$4) as ok',[job.subscription_id,job.slot,job.attempt,job.revision]);
 const revision=(await db.query('select revision from poster_subscriptions where id=$1',[priv])).rows[0].revision;
 const personal=(await db.query('select * from claim_poster_deliveries($1,$2)',[priv,revision])).rows[0];assert.equal(personal.subscription_id,priv);
 await db.query('delete from workspace_members where user_id=$1',[v]);assert.equal((await begin(personal)).rows[0].ok,false);
 assert.equal((await begin(j)).rows[0].ok,true);assert.equal((await begin(j)).rows[0].ok,false);
 await db.query("update poster_deliveries set updated_at=now()-interval '6 minutes'");await claim();
 assert.equal((await db.query('select status from poster_deliveries where subscription_id=$1',[sub])).rows[0].status,'unknown');
 await db.exec('set role authenticated');await assert.rejects(db.query('select * from poster_subscriptions'),/permission denied/);
 await assert.rejects(claim(),/permission denied/);await db.exec('reset role;set role anon');
 await assert.rejects(db.query('select png from poster_message_images'),/permission denied/);
 } finally {await db.close();}
});

test('API gates channel changes by current workspace role and personal recipient by authenticated user',async t=>{
 const {default:handler}=await import('../api/poster-delivery.js');
 const user=randomUUID(),ws=randomUUID(),strangerSite=randomUUID(),calls=[];
 t.mock.method(globalThis,'fetch',async(input,opts)=>{
   const url=new URL(input);calls.push(url);
   if(url.pathname==='/auth/v1/user')return Response.json({id:user,app_metadata:{},user_metadata:{}});
   if(url.pathname.endsWith('/workspaces'))return Response.json([{id:ws,status:'active',owner_id:'someone-else'}]);
   if(url.pathname.endsWith('/workspace_members'))return Response.json(url.searchParams.get('workspace_id')==='eq.'+ws?[{role:'member'}]:[]);
   if(url.pathname.endsWith('/poster_subscriptions'))return Response.json([]);
   throw Error('Unexpected recipient request');
 });
 const old=[process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY];
 process.env.SUPABASE_URL='https://fixture.example';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';
 t.after(()=>{for(const [i,k] of ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'].entries()){if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];}});
 const invoke=async(workspace,channel)=>{
   const result={code:200,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;}};
   await handler({method:'POST',query:{action:'state'},headers:{authorization:'Bearer fixture'},body:{workspace,channel,user_id:'different-user'}},result);
   return result;
 };
 assert.equal((await invoke(ws,'telegram')).code,403);
 assert.equal((await invoke(strangerSite,'kakao')).code,403);
 assert.equal((await invoke(ws,'kakao')).code,200);
 const q=calls.find(url=>url.pathname.endsWith('/poster_subscriptions')).searchParams;
 assert.equal(q.get('user_id'),'eq.'+user);assert.equal(q.get('workspace_id'),'eq.'+ws);
});

test('production storage uses a fixed operation with a server credential and fails closed',async t=>{
  const {data}=await import('../server/poster/data.js');
  const prior=process.env.POSTER_STORAGE_KEY;
  process.env.POSTER_STORAGE_KEY='fixture-only';
  t.after(()=>{if(prior===undefined) delete process.env.POSTER_STORAGE_KEY;else process.env.POSTER_STORAGE_KEY=prior;});
  const db={functions:{invoke:async(name,{headers,body})=>{
    assert.equal(name,'poster-storage');assert.equal(headers['x-poster-storage-key'],'fixture-only');
    assert.deepEqual(body,{operation:'ready',args:{}});return {data:{data:false}};
  }}};
  assert.equal(await data(db,'ready'),false);
  db.functions.invoke=async()=>({error:new Error('unavailable')});
  await assert.rejects(data(db,'ready'),e=>e.status===503);
});
test('webhook registration verifies the provider and preserves an existing different destination',async()=>{
  const {registerWebhook,botToken}=await import('../server/poster/telegram.js');
  assert.equal(botToken('  "123:fixture"\n'),'123:fixture');
  assert.equal(botToken('https://api.telegram.org/bot123:fixture'),'123:fixture');
  const env={TELEGRAM_BOT_TOKEN:'123:fixture',TELEGRAM_WEBHOOK_SECRET:'test',POSTER_SITE_ORIGIN:'https://example.test'};
  let destination='https://other.test/callback',setCount=0;
  const telegram=async(url,opts)=>{
    const method=url.split('/').pop();
    if(method==='setWebhook'){destination=JSON.parse(opts.body).url;setCount++;}
    return Response.json({ok:true,result:method==='getMe'?{is_bot:true,username:'fixture_bot'}:method==='getWebhookInfo'?{url:destination}:true});
  };
  await assert.rejects(registerWebhook(env,telegram),/다른 서비스/);assert.equal(setCount,0);
  destination='';assert.equal(await registerWebhook(env,telegram),'fixture_bot');
  assert.equal(destination,'https://example.test/api/poster-delivery?action=telegram-hook');
});
