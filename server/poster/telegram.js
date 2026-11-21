// Register only the dedicated bot selected by its server-side token.
export async function registerWebhook(env,http=fetch) {
  const {TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, POSTER_SITE_ORIGIN: origin}=env;
  if(!token || !/^[a-zA-Z0-9_-]{1,256}$/.test(secret||'') || !origin?.startsWith('https://')) throw Error('봇 토큰·웹훅 인증값·HTTPS 운영 주소를 환경변수에 설정해주세요.');
  const url=new URL('/api/poster-delivery?action=telegram-hook',origin).href;
  async function telegram(method,body={}) {
    const res=await http('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)}).catch(()=>null);
    const data=res && await res.json().catch(()=>null);
    if(!data?.ok)throw Error('텔레그램 봇 인증 또는 웹훅 등록에 실패했습니다.');
    return data.result;
  }
  const bot=await telegram('getMe');
  if(!bot?.is_bot || !bot.username) throw Error('텔레그램 봇 인증에 실패했습니다.');
  const info=await telegram('getWebhookInfo');
  if(info.url && info.url!==url)throw Error('이 봇은 다른 서비스에 연결돼 있습니다. 현장 포스터 전용 봇을 사용해주세요.');
  await telegram('setWebhook',{url,secret_token:secret,allowed_updates:['message']});
  if((await telegram('getWebhookInfo')).url!==url)throw Error('웹훅 주소를 확인하지 못했습니다.');
  return bot.username;
}
