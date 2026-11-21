import {posterOperations} from '../../supabase/functions/_shared/poster-operations.js';
import {Problem} from './service.js';

export async function data(db, operation, args={}) {
  const key=process.env.POSTER_STORAGE_KEY;
  if(key) {
    const result=await db.functions.invoke('poster-storage',{headers:{'x-poster-storage-key':key},body:{operation,args},signal:AbortSignal.timeout(12000)});
    if(!result.error && result.data && Object.hasOwn(result.data,'data')) return result.data.data;
  } else {
    const result=await posterOperations[operation](db,args);
    if(!result.error) return result.data;
  }
  throw new Problem('발송 설정 저장소를 사용할 수 없습니다. 잠시 후 다시 시도해주세요.',503);
}
