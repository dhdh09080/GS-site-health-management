import {registerWebhook} from '../server/poster/telegram.js';
await registerWebhook(process.env);
console.log('현장 포스터 웹훅 등록을 확인했습니다.');
