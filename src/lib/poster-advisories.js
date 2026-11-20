// KMA land warning districts: https://www.kma.go.kr/metropolitan/html/info/business02.jsp
const seoulZones = {
  서울동북권: '도봉구 노원구 강북구 성북구 동대문구 중랑구 성동구 광진구',
  서울서북권: '은평구 종로구 마포구 서대문구 중구 용산구',
  서울서남권: '강서구 양천구 구로구 영등포구 동작구 관악구 금천구',
  서울동남권: '강동구 송파구 강남구 서초구',
};
const provinces = [
  '서울 서울시 서울특별시', '인천 인천시 인천광역시', '경기 경기도', '부산 부산시 부산광역시',
  '대구 대구시 대구광역시', '울산 울산시 울산광역시', '광주 광주시 광주광역시', '대전 대전시 대전광역시',
  '세종 세종시 세종특별자치시', '제주 제주도 제주특별자치도', '강원 강원도 강원특별자치도',
  '충남 충청남도', '충북 충청북도', '경남 경상남도', '경북 경상북도',
  '전남 전라남도', '전북 전라북도 전북특별자치도', '전남광주통합특별시',
].map(row => row.split(' '));

// Split only between complete areas. Qualifiers like 강릉평지 or 산지 제외
// cannot establish a match to the entire municipality.
function areaList(text) {
  let depth = 0, start = 0;
  const list = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    if (depth < 0) return [];
    if (text[i] === ',' && depth === 0) { list.push(text.slice(start,i).trim()); start=i+1; }
  }
  return depth ? [] : [...list, text.slice(start).trim()];
}

export function siteAdvisory(result, address) {
  const report = result?.report;
  if (typeof report?.active !== 'string' || !report.active.trim() || !Number.isFinite(Date.parse(report.issuedAt))) return {state:'unavailable'};
  const [provinceName, city = '', district = ''] = String(address || '').trim().replace(/^대한민국\s+/, '').split(/\s+/);
  const province = provinces.find(names => names.includes(provinceName));
  if (!province) return {state:'review'};
  const local = [city, district].filter(token => /^[가-힣]+[시군구]$/.test(token));
  const names = new Set(local.includes(city) ? [city] : []);
  if (names.has(city) && /[시군]$/.test(city)) names.add(city.slice(0,-1));
  const zone = province[0] === '서울' && Object.keys(seoulZones).find(z => seoulZones[z].split(' ').includes(city));
  if (zone) { names.add(zone); names.add(zone.slice(2)); }
  const alerts = new Set();
  let review = false;
  const lines = report.active.replace(/\\r\\n|\\n|\r\n/g,'\n').trim().split(/\n\s*(?=[o○ㅇ●]\s*|[가-힣]+(?:주의보|경보)\s*[:：])/);
  for (const line of lines) {
    const item = line.trim().match(/^(?:[o○ㅇ●]\s*)?([가-힣]+(?:경보|주의보))\s*[:：]\s*([\s\S]+)$/);
    if (!item) { if (!/^(?:없음|특보\s*없음|발효 중인 특보 없음)\.?$/.test(line.trim())) review=true; continue; }
    const areas = areaList(item[2]);
    if (!areas.length) review = true;
    for (const area of areas) {
      const region = area.match(/^([^()]+?)(?:\(([\s\S]*)\))?$/);
      if (!region) { review=true; continue; }
      const parent = region[1].trim(), subset = region[2];
      if ((parent === '전국' || parent === '전국 육상') && subset === undefined) { alerts.add(item[1]); continue; }
      if (!province.includes(parent)) {
        if (zone && parent === zone && subset === undefined) alerts.add(item[1]);
        else if (!provinces.some(p => p.includes(parent)) && !/먼바다|앞바다|해상/.test(parent)) {
          if (province[0] !== '서울' || !/^(서해5도|울릉도[.·]독도)$/.test(parent)) review=true;
        }
        continue;
      }
      if (subset === undefined) { alerts.add(item[1]); continue; }
      const parts = areaList(subset);
      if (/제외|이외/.test(subset) || !parts.length) { review=true; continue; }
      if (parts.some(p => names.has(p) || p === '전역' || p === '전체')) alerts.add(item[1]);
      else if (!zone || !parts.every(p => Object.hasOwn(seoulZones,p) || Object.values(seoulZones).some(s=>s.split(' ').includes(p)))) review=true;
    }
  }
  if (!alerts.size) return {state: review ? 'review' : 'unmatched'};
  const labels = [...alerts].sort((a,b) => Number(b.endsWith('경보')) - Number(a.endsWith('경보')));
  return {state:'active', area:[province[0], ...local].join(' '), labels, issuedAt:report.issuedAt, review};
}

const copy = {
  ko: ['기상청 기상특보','기상청 발표','작업 전 자재·가림막의 고정 상태를 확인하세요.','작업 전 특보 내용을 확인하고 현장 관리자의 안내를 따르세요.','현장 특보구역 확인 필요 · 날씨 → 기상특보','기상특보 조회 실패 · 기상청 최신 발표를 확인하세요.','현장 예보 최대 풍속','작업 중 확인','가상 예시','06–19시 현장 예보 기준','강한 돌풍이 느껴지면 작업을 멈추고 관리자에게 알리세요.'],
  zh: ['韩国气象厅预警','韩国气象厅发布','作业前请确认材料和围挡已固定。','作业前请核实预警内容并遵从现场管理人员指引。','请在天气预警页面核对工地所属区域','未能获取预警，请查看韩国气象厅最新公告。','工地预报最大风速','作业中注意','模拟示例','工地预报 06–19时','遇到强阵风时，请停止作业并报告管理人员。'],
  ru: ['Предупреждение KMA','Опубликовано KMA','До начала работ проверьте крепление материалов и ограждений.','Проверьте предупреждение и следуйте указаниям руководителя.','Уточните зону объекта в разделе предупреждений','Не удалось получить предупреждения. Проверьте сводку KMA.','Прогноз макс. скорости ветра','Во время работы','Учебный пример','Прогноз на объекте, 06–19 ч','При сильных порывах остановите работу и сообщите руководителю.'],
  my: ['ကိုရီးယား မိုးလေဝသ သတိပေးချက်','ထုတ်ပြန်ချိန်','အလုပ်မစမီ ပစ္စည်းများနှင့် အကာအရံများ ခိုင်မြဲစွာ ချည်နှောင်ထားကြောင်း စစ်ဆေးပါ။','အလုပ်မစမီ သတိပေးချက်ကို စစ်ဆေးပြီး တာဝန်ခံ၏ လမ်းညွှန်ချက်ကို လိုက်နာပါ။','သတိပေးချက် စာမျက်နှာတွင် ဒေသကို စစ်ဆေးပါ။','သတိပေးချက် မရရှိပါ။ နောက်ဆုံးထုတ်ပြန်ချက်ကို စစ်ဆေးပါ။','ခန့်မှန်း အမြင့်ဆုံး လေတိုက်နှုန်း','အလုပ်လုပ်စဉ်','နမူနာ','လုပ်ငန်းခွင် ခန့်မှန်းချက် 06–19 နာရီ','လေပြင်းတိုက်လျှင် အလုပ်ရပ်ပြီး တာဝန်ခံကို အကြောင်းကြားပါ။'],
};
export function posterNotice(advisory, lang='ko') {
  const [heading,issued,windAction,otherAction,review,unavailable,windLabel,tipsLabel,example,period,windTip]=copy[lang] || copy.ko;
  const common={windLabel,tipsLabel,period};
  if (advisory?.state!=='active') return {...common,note:advisory?.state==='review'?review:advisory?.state==='unavailable'?unavailable:''};
  const wind=advisory.labels[0].startsWith('강풍') || advisory.labels[0].startsWith('태풍');
  const stamp=new Date(Date.parse(advisory.issuedAt)+9*3600000).toISOString();
  return {...common,heading:advisory.example?heading+' · '+example:heading, title:advisory.area+' '+advisory.labels.join(' · '),
    time:issued+' '+stamp.slice(5,10).replace('-','.')+' '+stamp.slice(11,16)+' KST',action:wind?windAction:otherAction,
    tip:wind?windTip:'',note:advisory.review?review:''};
}
