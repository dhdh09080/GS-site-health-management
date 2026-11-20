import test from 'node:test';
import assert from 'node:assert/strict';
import { siteAdvisory, posterNotice } from '../src/lib/poster-advisories.js';
import { buildHealthPosterSvg } from '../src/lib/weather-poster.js';

const site = {name:'가상 현장',address:'서울 성동구 용답중앙3길 10'};
const forecast = {date:'2026-11-21', hours:[{hour:7,temp:2,wind:3.8}]};
const issuedAt = '2026-11-21T05:30:00+09:00';
const match = (active, address=site.address) => siteAdvisory({report:{active,issuedAt,preliminary:'서울특별시 강풍예비특보'}},address);

test('regional official warnings apply independently of low forecast wind and exclude other regions',()=>{
 const result=match('o 강풍주의보 : 경기도(수원, 안산), 서울특별시(서울동북권)\\r\\no 대설경보 : 서울특별시(서울동남권)\no 건조주의보 : 서울');
 assert.deepEqual(result.labels,['강풍주의보','건조주의보']);
 assert.equal(result.area,'서울 성동구');
 const svg=buildHealthPosterSvg(forecast,site,'auto','ko',{advisory:result});
 for(const word of ['강풍주의보','건조주의보','기상청 발표 11.21 05:30','작업 전 자재·가림막','현장 예보 최대 풍속','3.8 m/s'])assert.ok(svg.includes(word));
 assert.doesNotMatch(svg,/대설경보|예비특보|가상 예시|발효 11/);
});

test('administrative areas are province-scoped, exclusions and ambiguous subregions require review',()=>{
 assert.equal(match('강풍주의보 : 서울특별시(서울서북권)').state,'unmatched');
 assert.equal(match('강풍주의보 : 서울특별시(성동구 제외)').state,'review');
 assert.equal(match('호우경보 : 경기도(광주)','광주광역시 서구').state,'unmatched');
 assert.equal(match('호우경보 : 경기도(광주)','경기 광주시 역동').state,'active');
 assert.equal(match('대설경보 : 강원도(강릉산지)','강원특별자치도 강릉시 강동면').state,'review');
 assert.equal(match('강풍주의보 : 전국 육상').state,'active');
});
test('missing feed, uncertain address and explicit empty bulletin do not print a warning',()=>{
 assert.equal(siteAdvisory(null,site.address).state,'unavailable');
 assert.equal(match('특보 없음').state,'unmatched');
 assert.equal(match('호우경보 : 서울특별시','주소 미설정').state,'review');
 assert.equal(match('발표문 형식 변경').state,'review');
 for(const lang of ['ko','zh','ru','my']){
   const svg=buildHealthPosterSvg(forecast,site,'auto',lang,{advisory:{state:'unavailable'}});
   assert.ok(svg.includes(posterNotice({state:'unavailable'},lang).note));
   assert.ok(!svg.includes('#fff1d2'));
 }
});
