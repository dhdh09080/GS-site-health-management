import {createClient} from 'npm:@supabase/supabase-js@2.108.2';
import {posterOperations} from '../_shared/poster-operations.js';

Deno.serve(async req=>{
  const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
  if(req.method!=='POST') return reply({error:'method'},405);
  const secret=req.headers.get('x-poster-storage-key');
  if(!secret || !/^[a-f0-9]{64}$/.test(secret)) return reply({error:'unauthorized'},403);
  const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
  try {
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret))),b=>b.toString(16).padStart(2,'0')).join('');
    const verified=await db.rpc('poster_storage_authorized',{p_digest:digest});
    if(verified.error) return reply({error:'storage unavailable'},503);
    if(verified.data!==true) return reply({error:'unauthorized'},403);
    const {operation,args}=await req.json();
    if(typeof operation!=='string' || !Object.hasOwn(posterOperations,operation) || !args || typeof args!=='object' || Array.isArray(args)) return reply({error:'operation'},400);
    const result=await posterOperations[operation as keyof typeof posterOperations](db,args);
    if(result.error) return reply({error:'storage unavailable'},503);
    return reply({data:result.data});
  } catch {return reply({error:'storage unavailable'},503);}
});
