#!/usr/bin/env python3
"""Split data/seed.json into one JSON file per deal for ArtifactData batch writes.
Writes data/seed_docs/deals/<id>.json and data/seed_docs/settings/team.json.
Optional: --existing <file> = ArtifactData list output saved as JSON; deals already
present in the db are written as merges that keep the team's edits (stage, priority,
owner, next_action, due_date, notes)."""
import json, os, shutil, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
seed = json.load(open(os.path.join(ROOT, 'data', 'seed.json')))
out = os.path.join(ROOT, 'data', 'seed_docs')
shutil.rmtree(out, ignore_errors=True)
os.makedirs(os.path.join(out, 'deals')); os.makedirs(os.path.join(out, 'settings'))
existing = {}
if '--existing' in sys.argv:
    ex = json.load(open(sys.argv[sys.argv.index('--existing') + 1]))
    for doc in ex.get('documents', ex if isinstance(ex, list) else []):
        existing[doc.get('id') or doc.get('doc_id')] = doc.get('data', doc)
if '--existing-dir' in sys.argv:  # a directory of <doc_id>.json files as ArtifactData list --out_dir writes them
    ddir = sys.argv[sys.argv.index('--existing-dir') + 1]
    for fn in os.listdir(ddir):
        if fn.endswith('.json'):
            existing[fn[:-5]] = json.load(open(os.path.join(ddir, fn)))
last_seed = {}
if '--last-seed-dir' in sys.argv:  # what the db was seeded with last time: a db doc equal to it carries no human edits
    ldir = sys.argv[sys.argv.index('--last-seed-dir') + 1]
    for fn in os.listdir(ldir):
        if fn.endswith('.json'):
            last_seed[fn[:-5]] = json.load(open(os.path.join(ldir, fn)))
def strip(d): return {k: v for k, v in (d or {}).items() if not k.startswith('__')}
KEEP = ('stage', 'priority', 'owner', 'next_action', 'due_date', 'notes', 'summary', 'interest', 'plan', 'revenue_hint', 'est_monthly_spend', 'tags', 'contacts', 'company', 'type', 'referrer')
n = 0
for d in seed['deals']:
    doc = dict(d)
    if d['id'] in existing and last_seed.get(d['id']) is not None and strip(existing[d['id']]) == strip(last_seed[d['id']]):
        # untouched since the last seed: the fresh build wins, but keep the clock fields steady when nothing real changed
        old = existing[d['id']]
        doc['created_at'] = old.get('created_at', doc['created_at'])
        same = all(old.get(k) == doc.get(k) for k in ('stage', 'next_action', 'last_contact', 'priority'))
        if same:
            doc['due_date'] = old.get('due_date', doc['due_date'])
            doc['updated_at'] = old.get('updated_at', doc['updated_at'])
    elif d['id'] in existing:
        old = existing[d['id']]
        for k in KEEP:
            if k in old and old[k] not in ('', None, []):
                doc[k] = old[k]
        if old.get('last_contact', '') > doc.get('last_contact', ''):
            doc['last_contact'] = old['last_contact']; doc['last_from'] = old.get('last_from', doc.get('last_from'))
        seen = {(m.get('date'), m.get('name')) for m in old.get('meetings', [])}
        doc['meetings'] = list(old.get('meetings', [])) + [m for m in doc.get('meetings', []) if (m.get('date'), m.get('name')) not in seen]
        doc['thread_urls'] = list(dict.fromkeys(list(old.get('thread_urls', [])) + doc.get('thread_urls', [])))
        doc['created_at'] = old.get('created_at', doc['created_at'])
    json.dump(doc, open(os.path.join(out, 'deals', d['id'] + '.json'), 'w'), ensure_ascii=False)
    n += 1
json.dump(seed['team'], open(os.path.join(out, 'settings', 'team.json'), 'w'), ensure_ascii=False)
ids = [d['id'] for d in seed['deals']]
json.dump(ids, open(os.path.join(out, 'ids.json'), 'w'))
print(f'{n} deal docs written to {out} ({len(existing)} merged with existing)')
