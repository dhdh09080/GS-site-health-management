import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { Problem, required, vault, hash, equalSecret, schedule, kakaoToken, deliver } from '../server/poster/service.js';
import { read, access, subscription, update, publicState, dispatcher } from '../server/poster/repository.js';

const uuid=v=>typeof v==='string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const expires=()=>new Date(Date.now()+10*60000).toISOString();
const endpoint='/api/poster-delivery';
const cookie='poster_kakao_state';
const env=process.env;
const origin=()=>new URL(required(env.POSTER_SITE_ORIGIN,'운영 사이트 주소 설정이 필요합니다.')).origin;
function configured(channel) {
  return !!(env.POSTER_ENCRYPTION_KEY && env.POSTER_SITE_ORIGIN && (channel==='telegram'?env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET:env.KAKAO_REST_API_KEY));
}
async function telegramHook(db,req) {
  if(!equalSecret(req.headers['x-telegram-bot-api-secret-token'],env.TELEGRAM_WEBHOOK_SECRET)) throw new Problem('인증이 필요합니다.',403);
  const m=req.body?.message;
  const code=m?.text?.match(/^\/start(?:@[\w]+)? ([\w-]{32})$/)?.[1];
  if(!code || !['private','group','supergroup'].includes(m.chat?.type) || !Number.isSafeInteger(m.chat.id) || m.from?.is_bot) return;
  const row=await read(db.from('poster_subscriptions').select('id,revision').eq('channel','telegram')
    .eq('binding_hash',hash(code)).gt('binding_until',new Date().toISOString()).maybeSingle());
  if(!row) return;
  const label=String(m.chat.title || m.chat.first_name || '개인 채팅').slice(0,100)+' (…'+String(m.chat.id).slice(-4)+')';
  await read(db.from('poster_subscriptions').update({binding_hash:null,candidate:vault(env.POSTER_ENCRYPTION_KEY).seal(String(m.chat.id),row.id),candidate_label:label})
    .eq('id',row.id).eq('binding_hash',hash(code)).eq('revision',row.revision));
}
async function kakaoStart(db,req,res) {
  const ticket=req.query.ticket;
  if(typeof ticket!=='string' || !/^[\w-]{32}$/.test(ticket)) throw new Problem('연결 링크를 다시 발급해주세요.');
  const nonce=randomBytes(24).toString('base64url');
  const row=await read(db.from('poster_subscriptions').update({binding_hash:hash(nonce)}).eq('channel','kakao')
    .eq('binding_hash',hash(ticket)).gt('binding_until',new Date().toISOString()).select('id').maybeSingle());
  if(!row) throw new Problem('이미 사용했거나 만료된 연결 링크입니다.');
  // Start on the canonical domain so the callback cookie also works when the site was opened via an alias.
  res.setHeader('Set-Cookie',cookie+'='+nonce+'; Max-Age=600; Path='+endpoint+'; HttpOnly; Secure; SameSite=Lax');
  const params=new URLSearchParams({client_id:env.KAKAO_REST_API_KEY,redirect_uri:origin()+endpoint+'?action=kakao-return',
    response_type:'code',scope:'talk_message',state:nonce});
  res.setHeader('Location','https://kauth.kakao.com/oauth/authorize?'+params);
  return res.status(302).send('');
}
async function kakaoCallback(db,req,res) {
  const state=req.query.state;
  const proof=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookie+'='))?.slice(cookie.length+1);
  res.setHeader('Set-Cookie',cookie+'=; Max-Age=0; Path='+endpoint+'; HttpOnly; Secure; SameSite=Lax');
  if(!equalSecret(state,proof) || !req.query.code) throw new Problem('카카오 연결이 취소되거나 만료됐습니다. 사이트에서 다시 연결해주세요.');
  const row=await read(db.from('poster_subscriptions').select('*').eq('channel','kakao').eq('binding_hash',hash(state)).gt('binding_until',new Date().toISOString()).maybeSingle());
  if(!row) throw new Problem('연결 시간이 만료됐습니다.');
  await access(db,row.workspace_id,row.user_id);
  const tokens=await kakaoToken({grant_type:'authorization_code',code:req.query.code,redirect_uri:origin()+endpoint+'?action=kakao-return'},env);
  let hasConsent=String(tokens.scope||'').split(/[ ,]+/).includes('talk_message');
  if(!tokens.scope) {
    const scopes=await fetch('https://kapi.kakao.com/v2/user/scopes',{headers:{Authorization:'Bearer '+tokens.access_token},signal:AbortSignal.timeout(8000)});
    hasConsent=scopes.ok && (await scopes.json()).scopes?.some(s=>s.id==='talk_message' && s.agreed===true);
  }
  if(!tokens.refresh_token || !hasConsent) throw new Problem('카카오톡 메시지 전송 동의가 필요합니다.');
  await update(db,row,{destination:vault(env.POSTER_ENCRYPTION_KEY).seal(tokens.refresh_token,row.id),label:'나와의 채팅',binding_hash:null,binding_until:null,enabled:false});
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.status(200).send('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>카카오 연결 완료</title><h1>나와의 채팅 연결 완료</h1><p>현장 날씨 화면으로 돌아가 연결 상태를 새로고침하고 발송 시간을 저장해주세요.</p><a href="/">현장 사이트 열기</a></html>');
}
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  try {
    const action=req.query.action||'state';
    if(req.method!==(['image','kakao-start','kakao-return'].includes(action)?'GET':'POST')) throw new Problem('지원하지 않는 요청입니다.',405);
    const db=createClient(required(env.SUPABASE_URL||env.VITE_SUPABASE_URL,'현장 연결 설정이 필요합니다.'),required(env.SUPABASE_SERVICE_ROLE_KEY,'운영자의 자동 발송 서버 설정이 필요합니다.'),{auth:{persistSession:false,autoRefreshToken:false}});
    if(action==='image') {
      if(!uuid(req.query.id)) throw new Problem('이미지가 없습니다.',404);
      const img=await read(db.from('poster_message_images').select('png').eq('id',req.query.id).gt('expires_at',new Date().toISOString()).maybeSingle());
      if(!img) throw new Problem('이미지가 만료됐습니다.',404);
      res.setHeader('Content-Type','image/png');return res.status(200).send(Buffer.from(img.png,'base64'));
    }
    if(action==='telegram-hook') { await telegramHook(db,req);return res.json({ok:true}); }
    if(action==='kakao-start') return await kakaoStart(db,req,res);
    if(action==='kakao-return') return await kakaoCallback(db,req,res);
    if(action==='tick') {
      if(!equalSecret(req.headers.authorization?.replace(/^Bearer /,''),env.POSTER_CRON_SECRET)) throw new Problem('인증이 필요합니다.',403);
      const io=dispatcher(db,env,origin());
      const deadline=Date.now()+20000;
      let processed=0;
      do {
        const jobs=await read(db.rpc('claim_poster_deliveries',{}));
        if(!jobs.length) break;
        await Promise.all(jobs.map(job=>deliver(job,io)));
        processed+=jobs.length;
      } while(Date.now()<deadline);
      return res.json({processed});
    }
    const jwt=req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if(!jwt) throw new Problem('로그인이 필요합니다.',401);
    const {data,error}=await db.auth.getUser(jwt);
    if(error || !data?.user) throw new Problem('다시 로그인해주세요.',401);
    const user=data.user.id, {workspace,channel}=req.body||{};
    if(!uuid(workspace) || !['telegram','kakao'].includes(channel)) throw new Problem('현장과 채널을 확인해주세요.');
    const {admin}=await access(db,workspace,user);
    if(channel==='telegram' && !admin) throw new Problem('현장 관리자만 단체 발송을 설정할 수 있습니다.',403);
    const row=await subscription(db,workspace,channel,user,action==='connect');
    const schedulerReady=async()=>!!env.POSTER_CRON_SECRET && await read(db.rpc('poster_scheduler_ready',{}));
    if(action==='state') return res.json({...await publicState(db,row),configured:configured(channel),schedulerReady:await schedulerReady()});
    if(!row) throw new Problem('수신처를 먼저 연결해주세요.');
    if(req.body.revision!==row.revision && !(action==='connect' && req.body.revision===null && !row.destination && !row.binding_hash))
      throw new Problem('연결 상태를 새로고침한 뒤 다시 시도해주세요.',409);
    if(action==='disconnect') {
      await update(db,row,{enabled:false,destination:null,label:null,binding_hash:null,binding_until:null,candidate:null,candidate_label:null});
    } else if(action==='save') {
      const changes=schedule(req.body);
      if(changes.enabled && !row.destination) throw new Problem('수신처를 먼저 연결해주세요.');
      if(changes.enabled && (!configured(channel) || !await schedulerReady())) throw new Problem('운영자의 예약 작업과 채널 설정이 필요합니다.',503);
      await update(db,row,changes);
    } else if(action==='connect') {
      required(configured(channel),'운영자가 메신저 설정을 완료한 뒤 연결할 수 있습니다.');
      const nonce=randomBytes(24).toString('base64url');
      let url;
      if(channel==='kakao') {
        url=origin()+endpoint+'?action=kakao-start&ticket='+nonce;
      } else {
        const response=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/getMe',{signal:AbortSignal.timeout(8000)});
        const name=(await response.json()).result?.username;
        if(!response.ok || !/^\w+$/.test(name||'')) throw new Problem('운영자의 텔레그램 봇 설정을 확인해주세요.');
        url='https://t.me/'+name+'?startgroup='+nonce;
      }
      await update(db,row,{binding_hash:hash(nonce),binding_until:expires(),candidate:null,candidate_label:null});
      return res.json({url,privateUrl:channel==='telegram'?url.replace('?startgroup=','?start='):undefined});
    } else if(action==='confirm' && channel==='telegram') {
      if(!row.candidate || Date.parse(row.binding_until)<=Date.now()) throw new Problem('텔레그램에서 방을 선택하고 연결 상태를 새로고침해주세요.');
      await update(db,row,{destination:row.candidate,label:row.candidate_label,candidate:null,candidate_label:null,binding_until:null,enabled:false});
    } else if(action==='test') {
      if(!row.destination) throw new Problem('수신처를 먼저 연결해주세요.');
      const jobs=await read(db.rpc('claim_poster_deliveries',{p_test:row.id,p_expected:row.revision}));
      if(!jobs.length) throw new Problem('이미 발송 중이거나 이번 분에 테스트했습니다. 최근 결과를 확인해주세요.',429);
      const result=await deliver(jobs[0],dispatcher(db,env,origin()));
      if(result.status!=='sent') throw new Problem(result.message,502);
    } else throw new Problem('지원하지 않는 설정입니다.');
    return res.json({ok:true});
  } catch(e) {
    return res.status(e instanceof Problem?e.status:503).json({error:e instanceof Problem?e.message:'발송 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.'});
  }
}
