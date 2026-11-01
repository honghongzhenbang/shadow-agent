import { Worker } from 'node:worker_threads';

function safeBucket(bucket) {
  if (!bucket) return undefined;
  const { groups, ...publicBucket } = bucket;
  return publicBucket;
}
function paginate(items, page, pageSize) {
  const total=items.length,totalPages=Math.ceil(total/pageSize);
  page=Math.min(page,Math.max(totalPages,1));
  return {items:items.slice((page-1)*pageSize,page*pageSize),pagination:{page,pageSize,total,totalPages,
    hasPrevious:page>1,hasNext:page<totalPages}};
}

export function createVoiceReview({ database, root, projectRoot, matching={}, debounceMs=400, pollMs=5000 }) {
  let worker,closed=false,epoch=0,timer,busy=false,state='loading',payload,revision='',progress={loaded:0,total:0},error,metrics;
  function launch() {
    if (closed || worker) return;
    worker=new Worker(new URL('./voice-review-worker.mjs',import.meta.url),{
      workerData:{database,root,projectRoot,matching},execArgv:[] });
    const own=worker;
    worker.on('message',message=>{
      if (closed || own!==worker || message.epoch!==epoch) return;
      if (message.type==='progress') { progress=message.progress;state=payload?'refreshing':'loading'; }
      if (message.type==='ready') {
        payload=message.payload;revision=message.revision;progress=message.progress;metrics=message.metrics;
        state='ready';error=undefined;busy=false;
      }
      if (message.type==='unchanged') {busy=false;state=payload?'ready':'loading';}
      if (message.type==='stale') {busy=false;invalidate();}
      if (message.type==='failure') {busy=false;state='error';error=message.error;}
    });
    worker.on('error',()=>{if(own===worker&&!closed){busy=false;state='error';error='声音匹配线程不可用，请刷新重试。';}});
    worker.on('exit',()=>{if(own===worker){worker=undefined;busy=false;if(!closed){state='error';error='声音匹配已停止，请刷新重试。';}}});
  }
  function send(force=false,background=false) {
    if (closed || (background && (busy||timer))) return;
    launch();busy=true;worker.postMessage({type:'refresh',epoch,force});
  }
  function invalidate({force=false}={}) {
    if(closed)return;
    epoch++;clearTimeout(timer);state=payload?'refreshing':'loading';error=undefined;
    timer=setTimeout(()=>{timer=undefined;send(force);},debounceMs);
  }
  launch();send();
  const poll=pollMs>0?setInterval(()=>send(false,true),pollMs):null;
  poll?.unref();
  return {
    invalidate,
    refresh(){invalidate({force:true});return {state,revision,progress};},
    diagnostics(){return metrics?{...metrics}:null;},
    assignment(recordingId,speakerLabel){
      return state==='ready'?payload?.groups.find(g=>g.recordingId===recordingId&&g.speakerLabel===speakerLabel)?.assignment:undefined;
    },
    read({view='recommended',bucketId,page=1,pageSize=30}={}) {
      if(!['recommended','people','recordings'].includes(view)||!Number.isSafeInteger(page)||page<1
        ||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100
        ||(bucketId!==undefined&&(typeof bucketId!=='string'||bucketId.length>500))) throw new Error('Invalid voice review query.');
      const base={state,revision,progress,error,counts:payload?.counts??{},items:[],groups:[]};
      if(!payload)return {...base,pagination:paginate([],page,pageSize).pagination};
      const bucket=bucketId===undefined?undefined:payload.buckets.find(b=>b.id===bucketId);
      if(bucketId!==undefined||view==='recordings') {
        const keys=new Set(bucket?.groups??[]);
        const list=payload.groups.filter(g=>bucketId===undefined||keys.has(g.key))
          .sort((a,b)=>b.recordedAt.localeCompare(a.recordedAt)||a.key.localeCompare(b.key));
        const slice=paginate(list,page,pageSize);
        return {...base,groups:slice.items,bucket:safeBucket(bucket),pagination:slice.pagination};
      }
      const list=view==='recommended'?payload.recommended:payload.buckets;
      const slice=paginate(list,page,pageSize);
      return {...base,items:slice.items.map(safeBucket),pagination:slice.pagination};
    },
    async close(){closed=true;clearTimeout(timer);clearInterval(poll);const own=worker;worker=undefined;await own?.terminate();},
  };
}
