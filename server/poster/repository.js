import { randomUUID } from 'node:crypto';
import { Problem, required, vault, weatherPoster, kakaoToken, sendMessage } from './service.js';

import {data} from './data.js';
import {botToken} from './telegram.js';

export async function access(db,workspaceId,userId) {
  const site=await data(db,'site',{workspace:workspaceId});
  const denied=()=>{throw new Problem('이 현장에 접근할 권한이 없습니다.',403);};
  if(!site || ['suspended','archived'].includes(site.status)) denied();
  if(site.owner_id===userId) return {site,admin:true};
  const member=await data(db,'member',{workspace:workspaceId,user:userId});
  if(!member) denied();
  return {site,admin:member.role==='admin'};
}
export async function subscription(db,ws,channel,user,create=false) {
  const args={workspace:ws,channel,user:channel==='kakao'?user:null};
  if(create) await data(db,'addSubscription',args);
  return data(db,'subscription',args);
}
export async function update(db,row,changes,rotate=true) {
  const changed=await data(db,'change',{id:row.id,revision:row.revision,changes:rotate?{...changes,revision:randomUUID()}:changes});
  if(!changed) throw new Problem('설정이 변경됐습니다. 새로고침한 뒤 다시 시도해주세요.',409);
}
export async function publicState(db,row) {
  if(!row) return {enabled:false,time:'06:00',days:[1,2,3,4,5,6,7],connected:false,revision:null};
  const latest=await data(db,'latest',{id:row.id});
  return {enabled:row.enabled,days:row.days,time:[Math.floor(row.minute/60),row.minute%60].map(x=>String(x).padStart(2,'0')).join(':'),
    connected:!!row.destination,label:row.label,pending:Date.parse(row.binding_until)>Date.now()?row.candidate_label:null,latest,revision:row.revision};
}
export function dispatcher(db,env,origin,http=fetch) {
  return {
    async prepare(job) {
      const row=await data(db,'byId',{id:job.subscription_id});
      if(row.revision!==job.revision || !row.destination) throw new Problem('설정이 변경됐습니다.');
      const site=await data(db,'site',{workspace:row.workspace_id});
      const png=await weatherPoster(site,async body=>{
        const {data,error}=await db.functions.invoke('site-weather',{body,signal:AbortSignal.timeout(12000)});
        if(error || !data?.result) throw new Problem('현장 날씨를 불러오지 못했습니다.');
        return data.result;
      });
      const store=vault(env.POSTER_ENCRYPTION_KEY),target=store.open(row.destination,row.id);
      if(row.channel==='telegram') return {channel:row.channel,png,siteName:site.name,target,token:required(botToken(env.TELEGRAM_BOT_TOKEN),'텔레그램 봇 설정을 확인해주세요.')};
      const tokens=await kakaoToken({grant_type:'refresh_token',refresh_token:target},env,http);
      if(tokens.refresh_token) await update(db,row,{destination:store.seal(tokens.refresh_token,row.id)},false);
      const image=await data(db,'saveImage',{id:row.id,png:png.toString('base64')});
      return {channel:row.channel,token:tokens.access_token,siteName:site.name,origin,url:origin+'/api/poster-delivery?action=image&id='+image.id};
    },
    begin:job=>data(db,'begin',job),
    send:message=>sendMessage(message,http),
    finish:(job,status,detail)=>data(db,'finish',{job,status,detail})
  };
}
