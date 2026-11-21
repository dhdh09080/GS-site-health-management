import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { buildHealthPosterSvg, kstDate } from '../../src/lib/weather-poster.js';
import { siteAdvisory } from '../../src/lib/poster-advisories.js';

export class Problem extends Error {
  constructor(message, status=400) { super(message); this.status=status; }
}
export function required(value, message) { if (!value) throw new Problem(message,503); return value; }
export function hash(value) { return createHash('sha256').update(value).digest('hex'); }
export function equalSecret(value, secret) {
  return typeof value==='string' && !!secret && timingSafeEqual(Buffer.from(hash(value)),Buffer.from(hash(secret)));
}
export function vault(key) {
  const bytes=Buffer.from(key||'','base64');
  required(bytes.length===32,'운영자의 발송 암호키 설정이 필요합니다.');
  return {
    seal(value,scope) {
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',bytes,iv);
      cipher.setAAD(Buffer.from(scope));
      const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
      return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');
    },
    open(value,scope) {
      const buf=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',bytes,buf.subarray(0,12));
      cipher.setAAD(Buffer.from(scope)); cipher.setAuthTag(buf.subarray(12,28));
      return Buffer.concat([cipher.update(buf.subarray(28)),cipher.final()]).toString('utf8');
    }
  };
}
export function schedule(input) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) || !Array.isArray(input.days)
    || !input.days.length || input.days.length>7 || !input.days.every(d=>Number.isInteger(d)&&d>=1&&d<=7)
    || typeof input.enabled!=='boolean') throw new Problem('발송 시각과 요일을 확인해주세요.');
  return {minute:Number(input.time.slice(0,2))*60+Number(input.time.slice(3)),days:[...new Set(input.days)].sort(),enabled:input.enabled};
}
export function renderPng(forecast,site,bulletin) {
  if (forecast?.date!==kstDate() || !forecast?.hours?.length) throw new Problem('오늘의 현장 예보를 불러오지 못했습니다.');
  const svg=buildHealthPosterSvg(forecast,site,'auto','ko',{advisory:siteAdvisory(bulletin,site.address)});
  const renderer=new Resvg(svg,{fitTo:{mode:'width',value:2520},font:{
    loadSystemFonts:false,fontFiles:[fileURLToPath(new URL('./PosterSans.otf',import.meta.url))],
    defaultFontFamily:'Noto Sans CJK KR',sansSerifFamily:'Noto Sans CJK KR'
  }});
  return renderer.render().asPng();
}
export async function weatherPoster(site,call) {
  if (!site.address || !Number.isFinite(site.latitude) || !Number.isFinite(site.longitude)) throw new Problem('날씨 메뉴에서 현장 주소와 좌표를 먼저 설정해주세요.');
  const [fc,report]=await Promise.all([call({action:'forecast',latitude:site.latitude,longitude:site.longitude,address:site.address}),
    call({action:'advisories'}).catch(()=>null)]);
  return renderPng(fc,site,report);
}
export async function kakaoToken(params,env,http=fetch) {
  const body=new URLSearchParams({...params,client_id:env.KAKAO_REST_API_KEY});
  if (env.KAKAO_CLIENT_SECRET) body.set('client_secret',env.KAKAO_CLIENT_SECRET);
  const r=await http('https://kauth.kakao.com/oauth/token',{method:'POST',body,signal:AbortSignal.timeout(8000)});
  const result=await r.json();
  if (!r.ok || !result.access_token) throw new Problem('카카오 인증을 갱신하지 못했습니다. 카카오 계정을 다시 연결해주세요.');
  return result;
}
export async function sendMessage({channel,target,token,png,url,siteName,origin},http=fetch) {
  let endpoint,body,headers={};
  if (channel==='telegram') {
    endpoint='https://api.telegram.org/bot'+token+'/sendPhoto';
    body=new FormData();body.set('chat_id',target);body.set('caption',siteName+' · '+kstDate()+' 현장 날씨');
    body.set('photo',new Blob([png],{type:'image/png'}),'weather.png');
  } else {
    endpoint='https://kapi.kakao.com/v2/api/talk/memo/default/send';headers.Authorization='Bearer '+token;
    const link={web_url:url,mobile_web_url:url};
    body=new URLSearchParams({template_object:JSON.stringify({object_type:'feed',content:{title:siteName+' · 현장 날씨',
      description:kstDate()+' · 포스터를 눌러 원본을 확인하세요.',image_url:url,link},
      buttons:[{title:'원본 포스터 보기',link},{title:'현장 사이트',link:{web_url:origin,mobile_web_url:origin}}]})});
  }
  const response=await http(endpoint,{method:'POST',body,headers,signal:AbortSignal.timeout(15000)});
  const result=await response.json();
  // Only an explicit rejection is safe to classify as failed. A lost acknowledgement is ambiguous.
  if (response.status>=500) throw new Error('unknown');
  if (!response.ok || (channel==='telegram'?result.ok===false:typeof result.code==='number' && result.code!==0))
    throw new Problem('메신저에서 거절했습니다. 수신처 연결과 발송 권한을 확인해주세요.');
  if (channel==='telegram' ? result.ok!==true || !result.result?.message_id : result.result_code!==0) throw new Error('unknown');
}
export async function deliver(job,io) {
  let sending=false;
  try {
    const data=await io.prepare(job);
    if (!await io.begin(job)) throw new Problem('설정 또는 현장 권한이 변경되어 발송을 취소했습니다.');
    sending=true;
    await io.send(data);
  } catch (e) {
    const uncertain=sending && !(e instanceof Problem);
    const status=uncertain?'unknown':'failed';
    const message=uncertain?'메신저의 수신 확인이 지연됐습니다. 채팅방을 확인해주세요.':
      e instanceof Problem?e.message:'포스터 준비에 실패했습니다. 연결과 현장 설정을 확인해주세요.';
    await io.finish(job,status,message);
    return {status,message};
  }
  await io.finish(job,'sent','메신저 접수 완료');
  return {status:'sent',message:'메신저 접수 완료'};
}
