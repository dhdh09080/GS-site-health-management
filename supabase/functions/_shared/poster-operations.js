// Both runtimes use these fixed queries. Clients cannot supply table names, projections or filters.
export const posterOperations = {
  site: (db, {workspace}) => db.from('workspaces').select('id,name,address,latitude,longitude,owner_id,status').eq('id',workspace).maybeSingle(),
  member: (db, {workspace,user}) => db.from('workspace_members').select('role').eq('workspace_id',workspace).eq('user_id',user).maybeSingle(),
  addSubscription: (db, {workspace,channel,user}) => db.from('poster_subscriptions')
    .upsert({workspace_id:workspace,channel,user_id:user},{onConflict:'workspace_id,channel,user_id',ignoreDuplicates:true}),
  subscription(db, {workspace,channel,user}) {
    const q=db.from('poster_subscriptions').select('*').eq('workspace_id',workspace).eq('channel',channel);
    return (user?q.eq('user_id',user):q.is('user_id',null)).maybeSingle();
  },
  byId: (db, {id}) => db.from('poster_subscriptions').select('*').eq('id',id).single(),
  change(db, {id,revision,changes}) {
    const allowed=['revision','enabled','days','minute','destination','label','binding_hash','binding_until','candidate','candidate_label'];
    if(!changes || Object.keys(changes).some(k=>!allowed.includes(k))) throw Error('Invalid subscription update');
    return db.from('poster_subscriptions').update(changes).eq('id',id).eq('revision',revision).select('id').maybeSingle();
  },
  latest: (db, {id}) => db.from('poster_deliveries').select('slot,status,detail,updated_at').eq('subscription_id',id)
    .order('updated_at',{ascending:false}).limit(1).maybeSingle(),
  findBinding: (db, {channel,code,now}) => db.from('poster_subscriptions').select('*').eq('channel',channel)
    .eq('binding_hash',code).gt('binding_until',now).maybeSingle(),
  telegramCandidate: (db, {id,code,revision,candidate,label}) => db.from('poster_subscriptions')
    .update({binding_hash:null,candidate,candidate_label:label}).eq('id',id).eq('channel','telegram').eq('binding_hash',code).eq('revision',revision),
  kakaoNonce: (db, {code,next,now}) => db.from('poster_subscriptions').update({binding_hash:next})
    .eq('channel','kakao').eq('binding_hash',code).gt('binding_until',now).select('id').maybeSingle(),
  getImage: (db, {id,now}) => db.from('poster_message_images').select('png').eq('id',id).gt('expires_at',now).maybeSingle(),
  saveImage: (db, {id,png}) => db.from('poster_message_images').insert({subscription_id:id,png}).select('id').single(),
  ready: db => db.rpc('poster_scheduler_ready',{}),
  claim: (db, {id,revision}) => db.rpc('claim_poster_deliveries',id?{p_test:id,p_expected:revision}:{}),
  begin: (db, job) => db.rpc('begin_poster_send',{p_subscription:job.subscription_id,p_slot:job.slot,p_attempt:job.attempt,p_revision:job.revision}),
  finish: (db, {job,status,detail}) => db.from('poster_deliveries').update({status,detail,updated_at:new Date().toISOString()})
    .eq('subscription_id',job.subscription_id).eq('slot',job.slot).eq('attempt',job.attempt).in('status',['preparing','sending'])
};
