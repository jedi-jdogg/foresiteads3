#!/usr/bin/env python3
"""Fold incremental sweeps (data/sources/delta_*.json) into the 12-month source files, then delete the deltas.
A delta record replaces the older record for the same company (normalized name or primary-contact domain);
Calendly delta events are merged by uri."""
import json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__)); SRC = os.path.join(os.path.dirname(HERE), 'data', 'sources')
sys.path.insert(0, HERE)

def norm(n): return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9]+', ' ', re.sub(r'\(.*?\)', ' ', (n or '').lower()).split(' / ')[0])).strip()
def dom(c):
    e = ((c or [{}])[0].get('email') or '').lower()
    d = e.split('@')[-1] if '@' in e else ''
    return '' if d in ('gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','foresiteads.com') else d
def keys(r): return {k for k in (('n:' + norm(r.get('company'))), ('d:' + dom(r.get('contacts')))) if not k.endswith(':')}

for base in ('gmail_pipeline', 'gmail_other', 'gmail_sent'):
    dpath = os.path.join(SRC, f'delta_{base}.json'); mpath = os.path.join(SRC, f'{base}.json')
    if not os.path.exists(dpath): continue
    delta = json.load(open(dpath)); main = json.load(open(mpath)) if os.path.exists(mpath) else []
    if isinstance(delta, dict): delta = delta.get('prospects') or delta.get('results') or []
    dk = set().union(*[keys(r) for r in delta]) if delta else set()
    kept = [r for r in main if not (keys(r) & dk)]
    merged = kept + delta
    json.dump(merged, open(mpath, 'w'), indent=1, ensure_ascii=False)
    print(f'{base}: {len(main)} -> {len(merged)} ({len(delta)} delta, {len(main)-len(kept)} replaced)')
    os.remove(dpath)

dpath = os.path.join(SRC, 'delta_calendly.json'); mpath = os.path.join(SRC, 'calendly.json')
if os.path.exists(dpath):
    delta = json.load(open(dpath)); main = json.load(open(mpath))
    by = {e['uri']: e for e in main.get('events', [])}
    for e in delta.get('events', []): by[e['uri']] = e
    canceled = {e['uri'] for e in delta.get('canceled_events', [])}
    main['events'] = [e for e in by.values() if e['uri'] not in canceled]
    main['generated_at'] = delta.get('generated_at', main.get('generated_at'))
    json.dump(main, open(mpath, 'w'), ensure_ascii=False)
    print(f'calendly: {len(main["events"])} events after merge ({len(delta.get("events", []))} delta, {len(canceled)} canceled)')
    os.remove(dpath)
