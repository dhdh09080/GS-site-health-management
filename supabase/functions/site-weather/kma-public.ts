import { kmaGrid, numeric } from './lib/forecast.js';

// Keep service keys and credential-bearing provider errors inside the Edge Function.
async function fetchItems(operation: string, params: Record<string, string>) {
  const key = Deno.env.get('KMA_SERVICE_KEY')?.trim();
  if (!key) throw new Error('기상청 공공데이터포털 인증키가 설정되지 않았습니다.');
  const url = new URL('https://apis.data.go.kr/1360000/' + operation);
  let rawKey = key;
  try { rawKey = decodeURIComponent(key); } catch { /* already decoded */ }
  url.search = new URLSearchParams({ serviceKey: rawKey, dataType: 'JSON', pageNo: '1', numOfRows: '100', ...params }).toString();
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(10000) }); }
  catch { throw new Error('기상청 연결이 지연되고 있습니다. 잠시 후 다시 조회해주세요.'); }
  const response = (await res.json().catch(() => null))?.response;
  const code = response?.header?.resultCode;
  if ([401,403].includes(res.status) || ['20','21','30','31','32'].includes(code)) {
    throw new Error('공공데이터포털의 기상청 서비스 활용승인과 서버 인증키를 확인해주세요.');
  }
  if (code === '03') throw new Error('기상청에서 조회할 자료를 제공하지 않았습니다.');
  if (res.status === 429 || code === '22') throw new Error('기상청 API의 조회 한도에 도달했습니다. 잠시 후 다시 조회해주세요.');
  if (!res.ok || code !== '00') throw new Error('기상청 응답을 확인하지 못했습니다. 잠시 후 다시 조회해주세요.');
  const items = response?.body?.items?.item;
  if (!Array.isArray(items) || !items.length) throw new Error('기상청 응답에 현황 자료가 없습니다.');
  return items;
}

export async function currentAdvisories() {
  const items = await fetchItems('WthrWrnInfoService/getPwnStatus', {});
  const reports = items.map(row => {
    const issued = String(row.tmFc ?? '');
    if (!/^\d{12}$/.test(issued) || typeof row.t6 !== 'string' || !row.t6.trim()) {
      throw new Error('기상청 특보 발효현황을 확인하지 못했습니다.');
    }
    const issuedAt = issued.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:00+09:00');
    if (!Number.isFinite(Date.parse(issuedAt))) throw new Error('기상청 특보 발표 시각을 확인하지 못했습니다.');
    return { issuedAt, active: row.t6.trim(), preliminary: String(row.t7 ?? '').trim() };
  }).sort((a,b) => b.issuedAt.localeCompare(a.issuedAt));
  return { source: '기상청 기상특보 조회서비스', checkedAt: new Date().toISOString(), report: reports[0] };
}

export async function gridObservation(latitude: number, longitude: number, now = Date.now()) {
  // The hourly ultra-short observation is published after HH:40 KST.
  const base = new Date(now + (9 * 60 - 40) * 60000).toISOString();
  const date = base.slice(0, 10), hour = base.slice(11, 13);
  const baseDate = date.replaceAll('-', '');
  const baseTime = hour + '00';
  const {nx, ny} = kmaGrid(latitude, longitude);
  const rows = await fetchItems('VilageFcstInfoService_2.0/getUltraSrtNcst', {
    nx: String(nx), ny: String(ny), base_date: baseDate, base_time: baseTime,
  });
  const values = Object.fromEntries(rows.filter(row => String(row.baseDate) === baseDate && String(row.baseTime).padStart(4, '0') === baseTime)
    .map(row => [row.category, numeric(row.obsrValue)]));
  if (values.T1H == null || values.T1H < -90 || values.T1H > 65) throw new Error('현장 격자의 기온을 확인하지 못했습니다.');
  const measure = (key: string, max: number) => values[key] >= 0 && values[key] <= max ? values[key] : null;
  return { source: '기상청 초단기실황', observedAt: date + 'T' + hour + ':00:00+09:00',
    temp: values.T1H, humidity: measure('REH', 100), wind: measure('WSD', 150),
    direction: measure('VEC', 360), rain60m: measure('RN1', 1000) };
}
