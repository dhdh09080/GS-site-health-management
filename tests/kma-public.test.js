import test from 'node:test';
import assert from 'node:assert/strict';
import { currentAdvisories, gridObservation } from '../supabase/functions/site-weather/kma-public.ts';
import { siteObservations } from '../supabase/functions/site-weather/observations.ts';

const success = rows => Response.json({ response: { header: { resultCode: '00' }, body: { items: { item: rows } } } });
function mockProvider(t, handler) {
  const original = globalThis.Deno;
  globalThis.Deno = { env: { get: name => name === 'KMA_SERVICE_KEY' ? 'fixture%2Bkey' : undefined } };
  t.after(() => { if (original) globalThis.Deno = original; else delete globalThis.Deno; });
  return t.mock.method(globalThis, 'fetch', url => {
    assert.equal(url.origin, 'https://apis.data.go.kr');
    assert.equal(url.searchParams.get('serviceKey'), 'fixture+key');
    return handler(url);
  });
}

test('national advisories retain the latest official active and preliminary bulletin and issue time', async t => {
  mockProvider(t, url => {
    assert.equal(url.pathname, '/1360000/WthrWrnInfoService/getPwnStatus');
    assert.equal(url.searchParams.has('stnId'), false);
    return success([{ tmFc: 202610180600, t6: '없음' },
      { tmFc: 202610190630, t6: ' 가상지역 강풍주의보 ', t7: '가상지역 예비특보' }]);
  });
  const {report, checkedAt} = await currentAdvisories();
  assert.deepEqual(report, {issuedAt:'2026-10-19T06:30:00+09:00', active:'가상지역 강풍주의보', preliminary:'가상지역 예비특보'});
  assert.ok(Number.isFinite(Date.parse(checkedAt)));
});

test('only an explicit KMA bulletin can report no advisories', async t => {
  const responses = [success([{tmFc:202610190600, t6:'발효 중인 특보 없음'}]), success([]),
    success([{tmFc:202610190600, t6:''}]), Response.json({response:{header:{resultCode:'03'}}}),
    new Response('fixture+key', {status:403})];
  mockProvider(t, () => responses.shift());
  assert.equal((await currentAdvisories()).report.active, '발효 중인 특보 없음');
  await assert.rejects(currentAdvisories, /자료가 없습니다/);
  await assert.rejects(currentAdvisories, /확인하지 못했습니다/);
  await assert.rejects(currentAdvisories, /제공하지 않았습니다/);
  await assert.rejects(currentAdvisories, e => e.message.includes('활용승인') && !e.message.includes('fixture'));
});

test('when no stations are available the grid uses the published KST hour, recording zero and missing separately', async t => {
  const now = Date.parse('2026-10-19T00:15:00+09:00');
  t.mock.method(Date, 'now', () => now);
  const {mock} = mockProvider(t, url => {
    assert.equal(url.pathname, '/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst');
    const p = url.searchParams;
    assert.deepEqual(['nx','ny','base_date','base_time'].map(k => p.get(k)), ['60','127','20261018','2300']);
    return success([['T1H','-3'],['RN1','0'],['REH','-999']].map(([category, obsrValue]) =>
      ({category, obsrValue, baseDate:20261018, baseTime:2300})));
  });
  const result = await siteObservations(37.5665,126.978);
  assert.equal(mock.callCount(), 1);
  assert.equal(result.grid.temp, -3);
  assert.equal(result.grid.rain60m, 0);
  assert.equal(result.grid.humidity, null);
  assert.equal(result.grid.observedAt, '2026-10-18T23:00:00+09:00');
  assert.match(result.warnings[0], /API허브/);
});

test('grid refuses a temperature from another observation hour', async t => {
  mockProvider(t, () => success([{baseDate:'20260101',baseTime:'0800',category:'T1H',obsrValue:'10'}]));
  await assert.rejects(() => gridObservation(37.56,126.98,Date.parse('2026-10-19T10:00:00+09:00')), /기온을 확인하지/);
});
