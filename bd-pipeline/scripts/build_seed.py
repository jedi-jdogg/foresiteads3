#!/usr/bin/env python3
"""Merge every BD source into one scored pipeline (data/seed.json) and a markdown report.

Sources (all optional, skipped when missing):
  data/sources/gmail_pipeline.json   A-Pipeline + Hot Leads labels (Claude Gmail sweep)
  data/sources/gmail_other.json      White Glove / GTM / Urgent / CS labels
  data/sources/gmail_sent.json       Sent-mail + Calendly-notification sweep
  data/sources/calendly.json         Calendly scheduled events + invitees
  data/sheet_pipeline.json           "Foresite AI Pipeline - Jonathan / Santiago" Google Sheet
  data/foresite_platform.json        Foresite platform tenants + subscription state
  data/overrides.json                Hand edits that win over everything else (keyed by company)

Usage: python3 scripts/build_seed.py [--today YYYY-MM-DD]
"""
import json, re, sys, os, hashlib, datetime, collections

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'data')
SRC = os.path.join(DATA, 'sources')
REPORTS = os.path.join(ROOT, 'reports')

TODAY = datetime.date.today().isoformat()
for i, a in enumerate(sys.argv):
    if a == '--today' and i + 1 < len(sys.argv):
        TODAY = sys.argv[i + 1]

TEAM_DOMAINS = {'foresiteads.com', 'lindas.com', 'chiefcxofficer.com', 'gmail.com', 'calendly.com'}
INTERNAL_PEOPLE = {'jonathan', 'arun', 'santiago', 'matt frary'}

STAGES = ['new', 'intro', 'call_scheduled', 'discovery', 'proposal', 'negotiating', 'won', 'customer', 'stalled', 'lost']
STAGE_W = {'new': 5, 'intro': 10, 'call_scheduled': 25, 'discovery': 30, 'proposal': 40, 'negotiating': 42, 'stalled': 8}
STAGE_RANK = {s: i for i, s in enumerate(STAGES)}
OPEN = {'new', 'intro', 'call_scheduled', 'discovery', 'proposal', 'negotiating', 'stalled'}


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as e:
        print(f'!! {path}: {e}', file=sys.stderr)
        return default


def norm_company(name):
    s = (name or '').lower()
    s = re.sub(r'\b(inc|llc|ltd|gmbh|co|corp|sa de cv|the)\b\.?', ' ', s)
    s = re.sub(r'[^a-z0-9]+', ' ', s).strip()
    return re.sub(r'\s+', ' ', s)


def domain_of(email_or_url):
    if not email_or_url:
        return ''
    s = email_or_url.strip().lower()
    if '@' in s:
        s = s.split('@', 1)[1]
    s = re.sub(r'^https?://', '', s)
    s = s.split('/')[0]
    s = re.sub(r'^(www|us|shop|store)\.', '', s)
    return s


def map_stage(text):
    """Free-text stage from agents / sheet -> canonical stage id."""
    t = (text or '').lower()
    if not t:
        return 'new'
    if any(k in t for k in ['closed-won', 'closed won', 'active customer', 'onboard', 'contract signed', 'signed', 'invoice sent', 'live', 'customer']):
        if 'onboard' in t and 'complete' not in t:
            return 'won'
        return 'customer' if ('active' in t or 'onboarded' in t or 'live' in t) else 'won'
    if any(k in t for k in ['closed-lost', 'closed lost', 'lost', 'declined', 'not interested', 'passed', 'churn']):
        return 'lost'
    if 'stall' in t or 'nurture' in t or 'no response' in t or 'went quiet' in t or 'dormant' in t:
        return 'stalled'
    if 'nda' in t or 'negotiat' in t or 'redline' in t or 'legal' in t or 'terms' in t:
        return 'negotiating'
    if 'proposal' in t or 'contract' in t or 'agreement' in t or 'quote' in t or 'pricing sent' in t:
        return 'proposal'
    if 'call done' in t or 'discovery' in t or 'met' in t or 'demo done' in t or 'call completed' in t or 'follow-up after call' in t or 'post-call' in t:
        return 'discovery'
    if 'scheduled' in t or 'booked' in t or 'call set' in t or 'meeting set' in t or 'upcoming call' in t:
        return 'call_scheduled'
    if 'intro' in t or 'outreach' in t or 'reached out' in t or 'sent' in t or 'pitched' in t or 'follow' in t:
        return 'intro'
    if 'new' in t or 'lead' in t or 'inbound' in t:
        return 'new'
    return 'new'


def parse_money(s):
    if not s:
        return None
    m = re.search(r'\$?\s*([\d.]+)\s*(k|m|mm|b)?', str(s).replace(',', ''), re.I)
    if not m:
        return None
    try:
        v = float(m.group(1))
    except ValueError:
        return None
    u = (m.group(2) or '').lower()
    if u == 'k':
        v *= 1e3
    elif u in ('m', 'mm'):
        v *= 1e6
    elif u == 'b':
        v *= 1e9
    return v


def days_between(a, b):
    try:
        return (datetime.date.fromisoformat(b[:10]) - datetime.date.fromisoformat(a[:10])).days
    except Exception:
        return None


def score(d):
    st = d.get('stage', 'new')
    if st not in OPEN:
        return 0
    s = STAGE_W.get(st, 5)
    rev = parse_money(d.get('revenue_hint')) or 0
    spend = float(d.get('est_monthly_spend') or 0)
    if spend >= 100000 or rev >= 20e6:
        s += 22
    elif spend >= 25000 or rev >= 5e6:
        s += 16
    elif rev >= 1e6 or spend > 0:
        s += 9
    else:
        s += 6
    if d.get('last_contact'):
        n = days_between(d['last_contact'], TODAY)
        if n is not None:
            s += 15 if n <= 7 else 10 if n <= 30 else 4 if n <= 90 else 0
            if n > 120 and st != 'stalled':
                s -= 5
    if d.get('last_from') == 'them':
        s += 10
    if any((m.get('date') or '') >= TODAY for m in d.get('meetings', [])):
        s += 18
    if d.get('due_date') and d['due_date'] < TODAY:
        s += 4
    if d.get('type') == 'partner':
        s += 6
    return max(0, round(s))


def suggest_priority(d):
    if d.get('stage') not in OPEN:
        return 'low'
    s = score(d)
    return 'high' if s >= 60 else 'medium' if s >= 38 else 'low'


def suggest_action(d):
    st = d.get('stage')
    them = d.get('last_from') == 'them'
    return {
        'new': 'Send intro email with the one-pager and offer a 20-minute call',
        'intro': 'Reply and propose two call times' if them else 'Follow up on the intro (2nd touch) with a proof point',
        'call_scheduled': 'Confirm the call, send agenda, pull their store and ad accounts for review',
        'discovery': 'Send recap with 90-day plan and the agreement',
        'proposal': 'Nudge on the contract; offer to walk through terms live',
        'negotiating': 'Close open terms; get signature and kickoff date',
        'stalled': 'Re-engage with a new result or a Q4 / BFCM angle',
        'won': 'Kick off onboarding: access, tracking, first campaign live',
        'customer': 'Monthly check-in: results review and expansion (flows, identities, CTV)',
    }.get(st, '')


def default_due(d):
    st = d.get('stage')
    p = d.get('priority') or suggest_priority(d)
    if st in ('won',):
        return add_days(TODAY, 5)
    if st in ('customer', 'lost'):
        return ''
    if d.get('due_date'):
        return d['due_date']
    return add_days(TODAY, 2 if p == 'high' else 7 if p == 'medium' else 21)


def add_days(d, n):
    return (datetime.date.fromisoformat(d) + datetime.timedelta(days=n)).isoformat()


def stable_id(key):
    return 'd_' + hashlib.sha1(key.encode()).hexdigest()[:10]


def clean_contacts(contacts):
    out, seen = [], set()
    for c in contacts or []:
        if not isinstance(c, dict):
            continue
        email = (c.get('email') or '').strip().lower()
        name = (c.get('name') or '').strip()
        if not email and not name:
            continue
        if email and domain_of(email) in TEAM_DOMAINS and 'foresite' in email:
            continue
        k = email or name.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append({'name': name, 'email': email, 'title': (c.get('title') or '').strip()})
    return out


# ---------------------------------------------------------------- merge
deals = {}          # key -> deal
alias = {}          # domain / normalized name -> key


def find_key(company, contacts=None, website=None):
    cands = []
    if website:
        cands.append('dom:' + domain_of(website))
    for c in contacts or []:
        dom = domain_of(c.get('email', '')) if isinstance(c, dict) else ''
        if dom and dom not in TEAM_DOMAINS and not dom.endswith(('gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'me.com')):
            cands.append('dom:' + dom)
    n = norm_company(company)
    if n:
        cands.append('name:' + n)
        # first significant word helps "Malo'o Racks" vs "Maloo"
        first = n.split(' ')[0]
        if len(first) >= 5:
            cands.append('first:' + first)
    for c in cands:
        if c in alias:
            return alias[c], cands
    return None, cands


def upsert(rec, source):
    company = (rec.get('company') or '').strip()
    if not company:
        return None
    if norm_company(company) in ('foresite', 'foresite ads', 'lindas', 'linda s') and source != 'sheet':
        return None
    contacts = clean_contacts(rec.get('contacts'))
    key, cands = find_key(company, contacts, rec.get('website'))
    if key is None:
        key = stable_id(norm_company(company) or company)
        deals[key] = {
            'id': key, 'company': company, 'website': '', 'type': 'prospect', 'contacts': [], 'source': source,
            'sources': [], 'referrer': '', 'owner': '', 'stage': 'new', 'priority': '', 'revenue_hint': '',
            'est_monthly_spend': None, 'plan': '', 'summary': '', 'interest': '', 'last_contact': '', 'last_from': '',
            'next_action': '', 'due_date': '', 'notes': '', 'tags': [], 'meetings': [], 'links': [], 'thread_urls': [],
            'created_at': TODAY + 'T00:00:00Z', 'updated_at': TODAY + 'T00:00:00Z',
        }
    for c in cands:
        alias.setdefault(c, key)
    d = deals[key]
    if source not in d['sources']:
        d['sources'].append(source)
    # longer / nicer company name wins
    if len(company) > len(d['company']) and norm_company(company) != norm_company(d['company']):
        pass
    elif len(company) > len(d['company']):
        d['company'] = company
    if rec.get('website') and not d['website']:
        d['website'] = domain_of(rec['website'])
    for c in contacts:
        if not any((x['email'] and x['email'] == c['email']) or (not c['email'] and x['name'].lower() == c['name'].lower()) for x in d['contacts']):
            d['contacts'].append(c)
    if not d['website']:
        for c in d['contacts']:
            dom = domain_of(c['email'])
            if dom and dom not in TEAM_DOMAINS and not dom.endswith(('gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com')):
                d['website'] = dom
                break
    t = (rec.get('type') or '').strip()
    if t in ('customer', 'partner', 'referral_source') and d['type'] == 'prospect':
        d['type'] = t
    if rec.get('referrer') and not d['referrer']:
        d['referrer'] = rec['referrer'].strip()
    if rec.get('owner') and not d['owner']:
        d['owner'] = rec['owner'].strip()
    # stage: most advanced wins, except explicit lost/customer from platform truth handled later
    st = rec.get('_stage') or map_stage(rec.get('stage'))
    if STAGE_RANK.get(st, 0) > STAGE_RANK.get(d['stage'], 0) and st not in ('lost', 'stalled'):
        d['stage'] = st
    elif st in ('lost', 'stalled') and d['stage'] in ('new', 'intro'):
        d['stage'] = st
    if rec.get('revenue_hint') and not d['revenue_hint']:
        d['revenue_hint'] = rec['revenue_hint']
    if rec.get('deal_size_hint') and not d['revenue_hint']:
        d['revenue_hint'] = rec['deal_size_hint']
    if rec.get('spend'):
        d['est_monthly_spend'] = rec['spend']
    if rec.get('plan') and not d['plan']:
        d['plan'] = rec['plan']
    for f in ('summary', 'interest'):
        if rec.get(f):
            d[f] = (d[f] + ' ' if d[f] and rec[f] not in d[f] else ('' if not d[f] else d[f] + ' ')) if False else (rec[f] if len(rec[f]) > len(d[f]) else d[f])
    lc = (rec.get('last_contact_date') or rec.get('last_contact') or '')[:10]
    if lc and re.match(r'\d{4}-\d{2}-\d{2}', lc) and lc > d['last_contact']:
        d['last_contact'] = lc
        if rec.get('last_from') in ('us', 'them'):
            d['last_from'] = rec['last_from']
    if rec.get('next_action') and (not d['next_action'] or source.startswith('gmail')):
        d['next_action'] = rec['next_action'].strip()
    if rec.get('notes'):
        d['notes'] = (d['notes'] + '\n' if d['notes'] else '') + rec['notes'].strip()
    for u in rec.get('thread_urls') or []:
        if u and u not in d['thread_urls']:
            d['thread_urls'].append(u)
    for m in rec.get('meetings') or []:
        if m.get('date') and not any(x['date'] == m['date'] and x.get('name') == m.get('name') for x in d['meetings']):
            d['meetings'].append({'date': m['date'][:10], 'name': m.get('name', ''), 'who': m.get('who', '')})
    for tag in rec.get('tags') or []:
        if tag not in d['tags']:
            d['tags'].append(tag)
    return key


# 1. Google Sheet (Santiago / Jonathan / Matt Frary)
for r in load(os.path.join(DATA, 'sheet_pipeline.json'), []):
    status = ' '.join([r.get('current_status', ''), r.get('engagement', ''), r.get('original_action', '')])
    st = map_stage(status)
    if r.get('current_status', '').lower().startswith('onboard'):
        st = 'customer' if 'onboarded' in r['current_status'].lower() else 'won'
    if r.get('engagement') in ('Green', 'Yellow'):
        st = 'customer'
    rec = {
        'company': r['company'], 'website': r.get('website', ''), 'referrer': r.get('referrer', ''),
        'owner': 'Santiago' if r.get('referrer') == 'Santiago' else 'Jonathan',
        '_stage': st, 'revenue_hint': r.get('notes', ''), 'plan': r.get('plan', ''), 'spend': r.get('spend'),
        'summary': ' · '.join(x for x in [r.get('original_action', ''), r.get('current_status', ''), r.get('engagement', '')] if x),
        'last_contact_date': r.get('intro', ''), 'last_from': 'us' if r.get('intro') else '',
        'next_action': r.get('corrective', ''), 'type': 'customer' if st in ('won', 'customer') else 'prospect',
        'tags': ['santiago-list'] if r.get('referrer') == 'Santiago' else (['matt-frary-list'] if r.get('referrer') == 'Matt Frary' else []),
    }
    upsert(rec, 'sheet')

# 2. Gmail sweeps
for fname, src in (('gmail_pipeline.json', 'gmail:pipeline'), ('gmail_other.json', 'gmail:other'), ('gmail_sent.json', 'gmail:sent')):
    rows = load(os.path.join(SRC, fname), [])
    if isinstance(rows, dict):
        rows = rows.get('prospects') or rows.get('deals') or rows.get('companies') or rows.get('results') or []
    for r in rows:
        if not isinstance(r, dict):
            continue
        if r.get('type') in ('investor', 'vendor', 'internal', 'skip'):
            continue
        r = dict(r)
        r['_stage'] = map_stage(r.get('stage'))
        if r.get('source_label') and not r.get('referrer'):
            r['tags'] = list(r.get('tags') or []) + ['label:' + r['source_label']]
        upsert(r, src)

# 3. Calendly events -> meetings on matching deals (or new deals)
cal = load(os.path.join(SRC, 'calendly.json'), {})
for ev in cal.get('events', []) if isinstance(cal, dict) else []:
    if (ev.get('status') or 'active') != 'active':
        continue
    date = (ev.get('start_time') or '')[:10]
    for inv in ev.get('invitees', []) or []:
        email = (inv.get('email') or '').lower()
        dom = domain_of(email)
        if not email or dom in TEAM_DOMAINS:
            continue
        company = inv.get('company_guess') or inv.get('company') or dom.split('.')[0].title()
        if dom.endswith(('gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'me.com')):
            company = inv.get('company') or inv.get('company_guess') or (inv.get('name') or email)
        rec = {
            'company': company, 'contacts': [{'name': inv.get('name', ''), 'email': email}],
            'meetings': [{'date': date, 'name': ev.get('name', 'Calendly meeting'), 'who': inv.get('name', '')}],
            'interest': inv.get('qa', ''), '_stage': 'call_scheduled' if date >= TODAY else 'discovery',
            'last_contact_date': date if date <= TODAY else '', 'last_from': 'them' if date <= TODAY else '',
            'referrer': 'Calendly', 'tags': ['calendly'],
        }
        upsert(rec, 'calendly')

# 4. Foresite platform truth: active subscription => customer; canceled => lost/churned customer
plat = load(os.path.join(DATA, 'foresite_platform.json'), {})
for t in plat.get('tenants', []):
    name = t['name']
    key, _ = find_key(name)
    sub = t.get('sub')
    if sub in ('active', 'paused'):
        rec = {'company': name, '_stage': 'customer', 'type': 'customer', 'plan': t.get('plan') or '', 'tags': ['platform:' + sub], 'owner': 'Jonathan'}
        k = upsert(rec, 'platform')
        if k:
            deals[k]['stage'] = 'customer'
            if not deals[k]['last_contact']:
                deals[k]['last_contact'] = t.get('created', '')
    elif sub == 'canceled':
        if not key:
            key = upsert({'company': name, '_stage': 'lost', 'type': 'customer', 'plan': t.get('plan') or '', 'owner': 'Jonathan', 'referrer': 'Platform'}, 'platform')
        deals[key]['stage'] = 'lost'
        deals[key]['type'] = 'customer'
        deals[key]['tags'].append('platform:canceled')
        deals[key]['notes'] = (deals[key]['notes'] + '\n' if deals[key]['notes'] else '') + f'Churned: platform subscription canceled ({t.get("plan")}). Win-back candidate.'
        deals[key]['next_action'] = deals[key]['next_action'] or 'Win-back: ask what did not work and offer Ads Only at 10% with no platform fee'
    elif sub is None and key and deals[key]['stage'] in ('new', 'intro'):
        deals[key]['tags'].append('platform:signed-up-no-plan')
        deals[key]['notes'] = (deals[key]['notes'] + '\n' if deals[key]['notes'] else '') + f'Created a Foresite account on {t.get("created")} but never subscribed.'
    elif sub is None and not key and t.get('note') is None:
        # self-serve signups with no subscription and no email trail: low-touch leads
        rec = {'company': name, '_stage': 'new', 'summary': f'Signed up on the Foresite platform {t.get("created")} but never chose a plan.', 'referrer': 'Platform signup', 'last_contact_date': t.get('created', ''), 'tags': ['platform:signed-up-no-plan'], 'owner': 'Arun'}
        upsert(rec, 'platform')

# 5. Overrides (hand edits) win
for name, o in load(os.path.join(DATA, 'overrides.json'), {}).items():
    key, _ = find_key(name)
    if key:
        deals[key].update(o)

# ---------------------------------------------------------------- finish
for d in deals.values():
    # an intro or contract that has sat untouched for 5+ months with nothing booked is stalled, not live
    if d['stage'] in ('new', 'intro', 'call_scheduled', 'discovery', 'proposal') and d['last_contact']:
        n = days_between(d['last_contact'], TODAY)
        if n is not None and n > 150 and not any(m['date'] >= TODAY for m in d['meetings']):
            d['tags'].append('auto-stalled:was-' + d['stage'])
            d['stage'] = 'stalled'
    if not d['owner']:
        d['owner'] = 'Jonathan'
    if not d['referrer']:
        d['referrer'] = {'gmail:pipeline': 'Inbound / email', 'gmail:other': 'Email', 'gmail:sent': 'Outbound', 'calendly': 'Calendly', 'sheet': 'List', 'platform': 'Platform signup'}.get(d['sources'][0], '')
    d['meetings'].sort(key=lambda m: m['date'])
    if d['stage'] in ('won', 'customer') and d['type'] == 'prospect':
        d['type'] = 'customer'
    if not d['next_action']:
        d['next_action'] = suggest_action(d)
    d['score'] = score(d)
    d['suggested_priority'] = suggest_priority(d)
    d['due_date'] = default_due(d)
    if d['est_monthly_spend'] is None:
        d.pop('est_monthly_spend')

os.makedirs(REPORTS, exist_ok=True)
team = {
    'members': [
        {'name': 'Jonathan Shroyer', 'email': 'jonathan@foresiteads.com', 'role': 'CEO'},
        {'name': 'Arun Bordoloi', 'email': 'arun@foresiteads.com', 'role': 'Team'},
    ],
    'signature': 'Jonathan Shroyer\nFounder & CEO, Foresite Ads\njonathan@foresiteads.com · ForesiteAds.com · calendly.com/quimbi',
    'cc': '',
}
seed = {'generated': TODAY, 'deals': sorted(deals.values(), key=lambda d: (-d['score'], d['company'].lower())), 'team': team, 'activity': []}
with open(os.path.join(DATA, 'seed.json'), 'w') as f:
    json.dump(seed, f, indent=1, ensure_ascii=False)

# ---------------------------------------------------------------- report
open_deals = [d for d in seed['deals'] if d['stage'] in OPEN]
by_p = collections.defaultdict(list)
for d in open_deals:
    by_p[d['suggested_priority']].append(d)
cust = [d for d in seed['deals'] if d['stage'] in ('won', 'customer')]
lost = [d for d in seed['deals'] if d['stage'] == 'lost']
lines = [f'# Foresite BD pipeline — {TODAY}', '',
         f'{len(open_deals)} open deals ({len(by_p["high"])} high, {len(by_p["medium"])} medium, {len(by_p["low"])} low), {len(cust)} customers/onboarding, {len(lost)} lost or churned. Sources: Gmail (12 months), Calendly, the Santiago/Jonathan pipeline sheet, Foresite platform subscriptions.', '']
for p in ('high', 'medium', 'low'):
    lines += [f'## {p.title()} priority ({len(by_p[p])})', '', '| Company | Stage | Owner | Size | Last contact | Next action | Due |', '|---|---|---|---|---|---|---|']
    for d in by_p[p]:
        lines.append(f"| {d['company']} | {d['stage']} | {d['owner']} | {d['revenue_hint'][:40]} | {d['last_contact']} {('(' + d['last_from'] + ' last)') if d['last_from'] else ''} | {d['next_action'][:90]} | {d['due_date']} |")
    lines.append('')
lines += ['## Customers & onboarding', '', '| Company | Stage | Plan | Next action |', '|---|---|---|---|']
for d in cust:
    lines.append(f"| {d['company']} | {d['stage']} | {d.get('plan','')} | {d['next_action'][:90]} |")
lines += ['', '## Lost / churned', '', ', '.join(d['company'] for d in lost) or 'none', '']
with open(os.path.join(REPORTS, f'{TODAY}-bd-pipeline.md'), 'w') as f:
    f.write('\n'.join(lines))

print(f'{len(seed["deals"])} deals -> data/seed.json; open {len(open_deals)} (H {len(by_p["high"])} / M {len(by_p["medium"])} / L {len(by_p["low"])}); customers {len(cust)}; lost {len(lost)}')
