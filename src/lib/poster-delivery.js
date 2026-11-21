const dayNames=['월','화','수','목','금','토','일'];
const statuses={preparing:'준비 중',sending:'발송 중',sent:'메신저 접수 완료',failed:'발송 실패',unknown:'수신 확인 필요'};

export function mountPosterDelivery({workspace,admin,session}) {
  const root=document.getElementById('posterDelivery');
  const el=name=>root.querySelector('[data-delivery="'+name+'"]');
  const channel=el('channel'),form=el('form'),controls=el('controls');
  let generation=0,saved=null,busy=false,initialChannel=true;
  el('days').innerHTML=dayNames.map((name,i)=>`<label><input type="checkbox" value="${i+1}"> ${name}</label>`).join('');
  function reset() {
    generation++;saved=null;busy=false;initialChannel=true;controls.disabled=false;root.open=false;
    el('telegram').hidden=!admin();channel.value=admin()?'telegram':'kakao';
    form.hidden=true;el('links').replaceChildren();el('status').textContent='';el('feedback').textContent='';
  }
  async function run(action) {
    const site=workspace(),chosen=channel.value;
    if(!site || (busy && action!=='state'))return;
    const version=++generation;
    const current=()=>version===generation && root.open && workspace()?.id===site.id && channel.value===chosen;
    const send=async (operation,extra={})=>{
      const token=await session();
      if(!current()) throw Error('현장이 변경됐습니다.');
      if(!token)throw Error('다시 로그인해주세요.');
      const response=await fetch('/api/poster-delivery?action='+operation,{method:'POST',
        headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
        body:JSON.stringify({workspace:site.id,channel:chosen,revision:saved?.revision||null,...extra})});
      const data=await response.json().catch(()=>null);
      if(!response.ok || !data || data.error)throw Error(data?.error || '자동 발송 서버 설정을 확인해주세요.');
      return data;
    };
    busy=true;controls.disabled=true;el('refresh').disabled=true;
    const feedback=el('feedback');
    delete feedback.dataset.tone;
    feedback.textContent=action==='test'?'이미지를 생성해 보내는 중입니다…':'설정을 확인하고 있습니다…';
    if(action==='state'){saved=null;form.hidden=true;el('status').textContent='';}
    try {
      let result;
      if(action!=='state'){
        const extra=action==='save'?{enabled:el('enabled').checked,time:el('time').value,
          days:[...el('days').querySelectorAll(':checked')].map(c=>Number(c.value))}:{};
        if(action==='save' && (!extra.time || !extra.days.length))throw Error('발송 시각과 요일을 선택해주세요.');
        result=await send(action,extra);
      }
      if(!current())return;
      const data=await send('state');
      if(!current())return;
      saved=data;form.hidden=false;
      el('enabled').checked=data.enabled;el('time').value=data.time;
      for(const c of el('days').querySelectorAll('input'))c.checked=data.days.includes(+c.value);
      el('status').textContent=site.name+' · '+(data.connected?data.label+(data.enabled?' · 자동 발송 중':' · 자동 발송 꺼짐'):'수신처 미연결');
      el('hint').textContent=data.configured?(chosen==='telegram'?'봇을 받을 방에 추가한 뒤, 연결 상태를 새로고침하고 방 이름을 확인하세요.':'본인 카카오 계정으로 동의하면 나와의 채팅에 포스터 카드가 도착합니다.'):
        (chosen==='telegram'?'운영자가 공용 텔레그램 봇을 등록하면 연결할 수 있습니다.':'운영자가 카카오 개발 앱을 등록하면 연결할 수 있습니다.');
      if(data.configured && data.connected && !data.pending)el('hint').textContent='테스트 이미지를 보내 수신처를 확인할 수 있습니다.';
      if(data.configured && !data.schedulerReady)el('hint').textContent+=' 예약 작업 등록을 기다리고 있습니다.';
      el('enabled').disabled=!data.schedulerReady && !data.enabled;
      el('connect').disabled=!data.configured;el('connect').textContent=data.connected?'수신처 다시 연결':chosen==='telegram'?'텔레그램 연결 시작':'카카오 계정 연결 시작';
      el('confirm').hidden=!data.pending;el('confirm').textContent=data.pending?'‘'+data.pending+'’ 방 연결 확정':'수신처 확인';
      el('test').disabled=!data.connected;el('save').disabled=!data.connected;
      el('disconnect').hidden=!data.connected && !data.pending;
      const last=data.latest;
      el('last').textContent=last?`최근 ${last.slot.startsWith('test-')?'테스트':'예약 발송'} · ${new Date(last.updated_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})} · ${statuses[last.status]||''}${last.detail && last.status!=='sent'?' · '+last.detail:''}`:'발송 이력이 없습니다.';
      if(action!=='state' || data.pending || data.connected)el('links').replaceChildren();
      if(result?.url){
        const link=(url,label)=>{const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.className='btn btn-outline';a.textContent=label;el('links').append(a);};
        link(result.url,chosen==='telegram'?'단체방 선택하기':'카카오 로그인하기');
        if(result.privateUrl)link(result.privateUrl,'개인 채팅 선택하기');
      }
      if(['save','test','confirm','disconnect'].includes(action)) feedback.dataset.tone='success';
      feedback.textContent=({save:'발송 설정을 저장했습니다.',test:'메신저가 이미지를 접수했습니다. 수신처에서 확인하세요.',confirm:'수신처를 연결했습니다. 발송 요일과 시간을 저장하세요.',disconnect:'연결을 해제했습니다.',connect:'아래 연결 링크는 10분 동안 유효합니다.'})[action]||'';
    } catch(e) {
      if(current()){feedback.dataset.tone='error';feedback.textContent=e.message;}
    }
    finally { if(current()){busy=false;controls.disabled=false;el('refresh').disabled=false;} }
  }
  channel.onchange=()=>{el('links').replaceChildren();run('state');};
  root.ontoggle=()=>{
    if(!root.open){generation++;busy=false;el('refresh').disabled=false;return;}
    const manager=admin();el('telegram').hidden=!manager;
    if(initialChannel || !manager)channel.value=manager?'telegram':'kakao';
    initialChannel=false;
    run('state');
  };
  root.addEventListener('click',e=>{
    const button=e.target.closest('button[data-action]');if(!button)return;
    if(button.dataset.action==='disconnect' && !window.confirm('자동 발송을 끄고 수신처 연결을 해제할까요?'))return;
    run(button.dataset.action);
  });
  return {reset};
}
