import json,sys,collections
ev=json.load(open(sys.argv[1]))['traceEvents']
names={(e['pid'],e['tid']):e['args']['name'] for e in ev if e.get('ph')=='M' and e.get('name')=='thread_name'}
long=collections.defaultdict(list)
for e in ev:
  if e.get('ph')=='X' and e['name']=='RunTask' and e.get('dur',0)>50000: long[names.get((e['pid'],e['tid']),'?')].append(e['dur']/1000)
docs=[e for e in ev if e['name']=='FunctionCall' and e.get('args',{}).get('data',{}).get('functionName')=='doUpdate']
print(sys.argv[2], {k:(len(v),round(sum(v)),round(max(v))) for k,v in long.items()}, 'doUpdate calls:',len(docs))
names_main=[k for k,v in names.items() if v=='CrRendererMain']
inv=sum(1 for e in ev if e['name']=='PaintInvalidator::InvalidatePaint()' and (e['pid'],e['tid']) in names_main)
mf=[e['dur']/1000 for e in ev if e['name']=='ProxyMain::BeginMainFrame' and e.get('ph')=='X']
print(f"{sys.argv[2]} InvalidatePaint={inv} main-frames>1500ms={sum(x>1500 for x in mf)} max-main-frame={max(mf):.0f}ms")
