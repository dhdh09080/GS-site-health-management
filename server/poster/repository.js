import { randomUUID } from 'node:crypto';
import { Problem, required, vault, weatherPoster, kakaoToken, sendMessage } from './service.js';

export async function read(query) {
  const {data,error}=await query;
  if(error) throw new Problem('발송 설정 저장소를 사용할 수 없습니다. 잠시 후 다시 시도해주세요.',503);
  return data;
}
export async function access(db,workspaceId,userId) {
  const site=await read(db.from('workspaces').select('id,name,address,latitude,longitude,owner_id,status').eq('id',workspaceId).maybeSingle());
  const denied=()=>{throw new Problem('이 현장에 접근할 권한이 없습니다.',403);};
  if(!site || ['suspended','archived'].includes(site.status)) denied();
  if(site.owner_id===userId) return {site,admin:true};
  const member=await read(db.from('workspace_members').select('role').eq('workspace_id',workspaceId).eq('user_id',userId).maybeSingle());
  if(!member) denied();
  return {site,admin:member.role==='admin'};
}
export async function subscription(db,ws,channel,user,create=false) {
  const rows=db.from('poster_subscriptions');
  const scope=channel==='kakao'?user:null;
  if(create) await read(rows.upsert({workspace_id:ws,channel,user_id:scope},{onConflict:'workspace_id,channel,user_id',ignoreDuplicates:true}));
  let q=rows.select('*').eq('workspace_id',ws).eq('channel',channel);
  return read((scope?q.eq('user_id',scope):q.is('user_id',null)).maybeSingle());
}
export async function update(db,row,changes,rotate=true) {
  const changed=await read(db.from('poster_subscriptions').update(rotate?{...changes,revision:randomUUID()}:changes)
    .eq('id',row.id).eq('revision',row.revision).select('id').maybeSingle());
  if(!changed) throw new Problem('설정이 변경됐습니다. 새로고침한 뒤 다시 시도해주세요.',409);
}
export async function publicState(db,row) {
  if(!row) return {enabled:false,time:'06:00',days:[1,2,3,4,5,6,7],connected:false,revision:null};
  const latest=await read(db.from('poster_deliveries').select('slot,status,detail,updated_at').eq('subscription_id',row.id)
    .order('updated_at',{ascending:false}).limit(1).maybeSingle());
  return {enabled:row.enabled,days:row.days,time:[Math.floor(row.minute/60),row.minute%60].map(x=>String(x).padStart(2,'0')).join(':'),
    connected:!!row.destination,label:row.label,pending:Date.parse(row.binding_until)>Date.now()?row.candidate_label:null,latest,revision:row.revision};
}
export function dispatcher(db,env,origin,http=fetch) {
  return {
    async prepare(job) {
      const row=await read(db.from('poster_subscriptions').select('*').eq('id',job.subscription_id).single());
      if(row.revision!==job.revision || !row.destination) throw new Problem('설정이 변경됐습니다.');
      const site=await read(db.from('workspaces').select('id,name,address,latitude,longitude').eq('id',row.workspace_id).single());
      const png=await weatherPoster(site,async body=>{
        const {data,error}=await db.functions.invoke('site-weather',{body,signal:AbortSignal.timeout(12000)});
        if(error || !data?.result) throw new Problem('현장 날씨를 불러오지 못했습니다.');
        return data.result;
      });
      const store=vault(env.POSTER_ENCRYPTION_KEY),target=store.open(row.destination,row.id);
      if(row.channel==='telegram') return {channel:row.channel,png,siteName:site.name,target,token:required(env.TELEGRAM_BOT_TOKEN,'텔레그램 봇 설정을 확인해주세요.')};
      const tokens=await kakaoToken({grant_type:'refresh_token',refresh_token:target},env,http);
      if(tokens.refresh_token) await update(db,row,{destination:store.seal(tokens.refresh_token,row.id)},false);
      const image=await read(db.from('poster_message_images').insert({subscription_id:row.id,png:png.toString('base64')}).select('id').single());
      return {channel:row.channel,token:tokens.access_token,siteName:site.name,origin,url:origin+'/api/poster-delivery?action=image&id='+image.id};
    },
    begin:job=>read(db.rpc('begin_poster_send',{p_subscription:job.subscription_id,p_slot:job.slot,p_attempt:job.attempt,p_revision:job.revision})),
    send:data=>sendMessage(data,http),
    finish:(job,status,detail)=>read(db.from('poster_deliveries').update({status,detail,updated_at:new Date().toISOString()})
      .eq('subscription_id',job.subscription_id).eq('slot',job.slot).eq('attempt',job.attempt).in('status',['preparing','sending']))
  };
}
