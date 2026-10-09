import json,sys
ev=json.load(open(sys.argv[1]))['traceEvents']
names={(e['pid'],e['tid']):e['args']['name'] for e in ev if e.get('ph')=='M' and e.get('name')=='thread_name'}
# scroll window: from first to last GestureScrollUpdate-ish input on compositor
sc=[e['ts'] for e in ev if e['name']=='ScrollTree::SetScrollOffset' or ('GestureScrollUpdate' in json.dumps(e.get('args',{})) and e['name']=='EventLatency')]
lo,hi=min(sc),max(sc)
sw=sorted(e['ts'] for e in ev if e['name']=='Swap' and e.get('ph')=='b' and names.get((e['pid'],e['tid']))=='Compositor' and lo<=e['ts']<=hi)
sw=[t for i,t in enumerate(sw) if i==0 or t-sw[i-1]>2000]
d=sorted((b-a)/1000 for a,b in zip(sw,sw[1:]))
dur=(hi-lo)/1e6
q=lambda p:d[min(len(d)-1,int(p*len(d)))]
print(f"{sys.argv[2]:14} window={dur:4.1f}s swaps={len(sw):4} fps={len(sw)/dur:5.1f} p50={q(.5):5.1f} p95={q(.95):6.1f} max={d[-1]:6.1f} >33ms={sum(x>33 for x in d):3} >100ms={sum(x>100 for x in d):3}")
