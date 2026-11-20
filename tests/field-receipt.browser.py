"""Exercise both roles on the built app with isolated Auth, REST, RPC and Storage fixtures."""
import asyncio
import base64
import json
import os
import time
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:3012')
OUT = Path(os.environ.get('FIELD_ARTIFACT_DIR', 'work/field-review'))
USER = dict(id='11111111-1111-4111-8111-111111111111', email='health@example.test',
            user_metadata={'name': '가상 관리자'}, app_metadata={}, aud='authenticated',
            created_at='2026-01-01T00:00:00Z')
SITE = dict(id='22222222-2222-4222-8222-222222222222', name='가상 송도 건설현장', owner_id=USER['id'])
COMPANY = dict(id='33333333-3333-4333-8333-333333333333', name='가상대한산업건설 주식회사 송도현장 기계설비사업부')
NAME = '가상_지하주차장_기계설비_보수작업용_에폭시_물질안전보건자료_개정본.pdf'


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    records, objects, inserts = {}, {}, []
    diagnostics, http_errors, failed_requests, console_errors = [], [], [], []
    fail_storage = True
    fail_receipt = True
    expired = False
    advisories_requested = 0

    async def backend(route):
        nonlocal fail_receipt, fail_storage, advisories_requested
        request = route.request
        url = urlsplit(request.url)
        if url.hostname == urlsplit(BASE).hostname:
            return await route.continue_()
        if url.hostname != 'fixture.supabase.co':
            return await route.fulfill(body='')
        name = url.path.rsplit('/', 1)[-1]
        if '/storage/v1/object/' in url.path:
            if fail_storage:
                fail_storage = False
                return await route.fulfill(status=400, json={'message': 'synthetic transfer failure'})
            assert name not in objects and request.method == 'POST'
            objects[name] = request.post_data_buffer
            return await route.fulfill(json={'Key': name})
        if name == 'token':
            parts = [{'alg': 'HS256'}, {'sub': USER['id'], 'exp': int(time.time()) + 3600}, {}]
            jwt = '.'.join(base64.urlsafe_b64encode(json.dumps(v).encode()).decode().rstrip('=') for v in parts)
            return await route.fulfill(json=dict(access_token=jwt, refresh_token='fixture',
                                                expires_in=3600, token_type='bearer', user=USER))
        if name == 'site-weather' and request.post_data_json.get('action') == 'advisories':
            advisories_requested += 1
            if advisories_requested == 1:
                return await route.fulfill(status=503, json={'error': '기상청 연결이 지연되고 있습니다.'})
            return await route.fulfill(json={'result': {
                'checkedAt': '2026-10-19T01:00:00Z', 'report': {'issuedAt': '2026-10-19T09:00:00+09:00',
                'active': '가상지역 강풍주의보', 'preliminary': '가상지역 호우 예비특보'}}})
        if name == 'get_contractor_portal':
            if expired:
                return await route.fulfill(status=400, json={'message': 'invalid or expired upload token'})
            return await route.fulfill(json=dict(workspace=SITE, contractor=COMPANY, work_types=[],
                                                records=list(records.values()), license=None))
        if name == 'msds_records':
            if request.method == 'POST':
                row = request.post_data_json
                assert row['workspace_id'] == SITE['id'] and row['contractor'] == COMPANY['name']
                inserts.append(row['id'])
                if len(inserts) == 1:
                    return await route.fulfill(status=400, json={'message': 'synthetic write failure'})
                assert row['id'] not in records
                records[row['id']] = row
                # Simulate a gateway error after the database commit.
                return await route.fulfill(status=504, json={'message': 'synthetic acknowledgement loss'})
            if request.method == 'PATCH':
                assert 'workspace_id=' in url.query
                if fail_receipt:
                    fail_receipt = False
                    return await route.fulfill(status=403, json={'message': 'synthetic denial'})
                row = next(iter(records.values()))
                row.update(request.post_data_json)
                return await route.fulfill(json=row)
            assert 'workspace_id=' in url.query
            return await route.fulfill(json=list(records.values()))
        responses = dict(user=USER, workspace_members=[dict(workspace_id=SITE['id'], user_id=USER['id'], role='admin')],
                         workspaces=[SITE], contractors=[
                             dict(id=f'fixture-{i}', name=f'가상 기계설비 {i:02}호') for i in range(30)
                         ] + [COMPANY], get_contractor_workspace={'contacts': []},
                         is_system_admin=False, is_current_user_system_admin=False)
        return await route.fulfill(json=responses.get(name, []))

    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        async def new_page(width, height):
            context = await browser.new_context(viewport={'width': width, 'height': height}, locale='ko-KR')
            await context.route('**/*', backend)
            if hasattr(context, 'route_web_socket'):
                await context.route_web_socket('**/*', lambda socket: None)
            page = await context.new_page()
            page.on('pageerror', lambda e: diagnostics.append(type(e).__name__))
            page.on('response', lambda r: http_errors.append((urlsplit(r.url).path.split('/')[-1], r.status)) if r.status >= 400 else None)
            page.on('requestfailed', lambda r: failed_requests.append(urlsplit(r.url).path.split('/')[-1]))
            page.on('console', lambda msg: console_errors.append(msg.text.split(':')[0]) if msg.type == 'error' else None)
            return page

        portal = await new_page(390, 844)
        await portal.goto(BASE + '/upload.html?token=synthetic', wait_until='commit')
        await portal.get_by_role('button', name='MSDS 파일 제출', exact=True).click()
        assert await portal.locator('#headerWS').inner_text() == COMPANY['name']
        assert await portal.locator('#headerDesc').inner_text() == SITE['name']
        assert await portal.locator('#uploadExistingCount').inner_text() == '0건'
        picker = portal.locator('#fileInput')
        await picker.set_input_files(dict(name='가상.txt', mimeType='text/plain', buffer=b'x'))
        assert '가상.txt' in await portal.locator('#fileSelectionError').inner_text()
        assert await portal.locator('#uploadBtn').is_disabled()
        sheet = await browser.new_page()
        await sheet.set_content('<p>Synthetic MSDS for testing</p>')
        pdf = await sheet.pdf()
        await sheet.close()
        await picker.set_input_files(dict(name=NAME, mimeType='application/pdf', buffer=pdf))
        await portal.locator('#uploadBtn').evaluate('b => {b.click(); b.click()}')
        await portal.locator('.file-item.error').wait_for()
        assert not records and not objects
        assert '원본 파일' in await portal.locator('.fi-error').inner_text()
        await portal.get_by_role('button', name='재시도', exact=True).click()
        await portal.locator('#uploadBtn').click()
        await portal.locator('.file-item.error').wait_for()
        assert not records and len(objects) == 1 and not await portal.locator('#stepView3').is_visible()
        await portal.get_by_role('button', name='재시도', exact=True).click()
        await portal.locator('#uploadBtn').click()
        await portal.locator('#receiptHeading').wait_for()
        assert await portal.locator('#receiptFiles').inner_text() == NAME
        assert len(records) == len(objects) == 1 and inserts == [inserts[0], inserts[0]]
        assert pdf in next(iter(objects.values()))
        await portal.screenshot(path=str(OUT/'receipt-390.png'))
        await portal.reload(wait_until='commit')
        await portal.locator('#uploadExistingList').get_by_text(NAME, exact=True).wait_for()

        manager = await new_page(1366, 768)
        await manager.goto(BASE, wait_until='commit')
        await manager.locator('#loginEmail').fill(USER['email'])
        await manager.locator('#loginPassword').fill('fixture-password')
        await manager.locator('#loginBtn').click()
        for width, height in [(1366, 768), (1920, 1080)]:
            await manager.set_viewport_size(dict(width=width, height=height))
            await manager.locator('#page-home.active #gsGreeting').wait_for()
            await manager.locator('#gsSiteName').get_by_text(SITE['name'], exact=True).wait_for()
            await manager.screenshot(path=str(OUT/f'home-restored-{width}.png'))
            await manager.locator('#nav-contractors').click()
            await manager.locator('#conMgrFilter').select_option('missing-license')
            await manager.locator('#conMgrSearch').fill('기계설비')
            await manager.locator('#companyNext').click()
            row = manager.locator('#conMgrList .contractor-row')
            await row.get_by_role('button', name=COMPANY['name']+' MSDS 1건 보기').click()
            await manager.locator('#searchInput').fill(NAME)
            await manager.locator('#filterStatus').select_option('active')
            await manager.locator('#msdsTableBody').get_by_role('button', name='상세보기').click()
            await manager.locator('#detailBody').get_by_text(NAME, exact=True).wait_for()
            assert COMPANY['name'] in await manager.locator('#detailBody').inner_text()
            if width == 1366:
                await manager.locator('#detailBody').get_by_text('수령 정보 확인·수정').click()
                await manager.locator('#rc_note').fill('가상 서류 확인')
                await manager.locator('#receiptSave').click()
                await manager.get_by_text('수령 정보 저장을 확인하지 못했습니다.', exact=False).wait_for()
                assert not next(iter(records.values())).get('receipt_note')
                await manager.locator('#receiptSave').click()
                await manager.locator('#receiptModal.open').wait_for(state='hidden')
                assert next(iter(records.values()))['receipt_note'] == '가상 서류 확인'
            else:
                await manager.locator('#msdsDetailModal .modal-close').click()
            assert await manager.locator('#searchInput').input_value() == NAME
            assert await manager.locator('#filterStatus').input_value() == 'active'
            await manager.locator('#msdsReturn').click()
            assert await manager.locator('#conMgrSearch').input_value() == '기계설비'
            assert await manager.locator('#conMgrFilter').input_value() == 'missing-license'
            assert await manager.locator('#companyPageStatus').inner_text() == '2 / 2 페이지'
            assert await row.count() == 1
            assert await row.locator('.con-row-actions').evaluate('e => e.getBoundingClientRect().right <= innerWidth')
            assert await manager.evaluate('document.documentElement.scrollWidth <= innerWidth')
            await manager.locator('#toastWrap .toast').last.wait_for(state='detached')
            await manager.screenshot(path=str(OUT/f'manager-{width}.png'))
            await manager.reload(wait_until='commit')
            await manager.locator('#page-home.active #gsGreeting').wait_for()
        await manager.locator('#nav-weather').click()
        await manager.get_by_role('tab', name='기상특보', exact=True).click()
        advisory = manager.locator('#wxAdvisoryBody')
        await advisory.get_by_role('alert').wait_for()
        assert '특보 없음' not in await advisory.inner_text()
        await advisory.get_by_role('button', name='다시 조회').click()
        await advisory.get_by_text('가상지역 강풍주의보', exact=True).wait_for()
        assert '가상지역 호우 예비특보' in await advisory.inner_text()
        assert advisories_requested == 2
        for width, height in [(390, 844), (1366, 768), (1920, 1080)]:
            await manager.set_viewport_size(dict(width=width, height=height))
            assert not await manager.locator('#page-weather .wx-site-card').is_visible()
            assert await manager.locator('#wxView-advisories').evaluate('e => e.getBoundingClientRect().right <= innerWidth')
            assert await manager.evaluate('document.documentElement.scrollWidth <= innerWidth')
            await manager.screenshot(path=str(OUT/f'weather-advisories-{width}.png'))
        expired = True
        await picker.set_input_files(dict(name=NAME, mimeType='application/pdf', buffer=pdf))
        await portal.locator('#uploadBtn').click()
        await portal.locator('#fileSelectionError').get_by_text('만료', exact=False).wait_for()
        await portal.reload(wait_until='commit')
        await portal.locator('#errorView').get_by_text('새 링크', exact=False).wait_for()
        assert len(records) == len(objects) == 1
        assert not diagnostics and not failed_requests, (diagnostics, failed_requests)
        assert sorted(http_errors) == sorted([(inserts[0] + '.pdf',400), ('msds_records',400), ('msds_records',504), ('msds_records',403),
                                              ('get_contractor_portal',400), ('get_contractor_portal',400), ('site-weather',503)]), http_errors
        assert all(msg.startswith('Failed to load resource') for msg in console_errors), console_errors
        print('PASS: both roles, same original, refresh, duplicate click, rejected insert, committed response loss,')
        print('receipt edit denied then saved, expired link, viewport fit; advisory failure/retry, only seven injected HTTP errors.')
        await browser.close()

asyncio.run(main())
