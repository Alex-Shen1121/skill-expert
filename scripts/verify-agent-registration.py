#!/usr/bin/env python3
"""Exercise the freshly built debug CLI in an isolated acceptance root."""
import argparse
import concurrent.futures
import json
import os
import platform
from pathlib import Path
import sqlite3
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--binary', required=True, type=Path)
parser.add_argument('--root', required=True, type=Path)
args = parser.parse_args()
args.root.mkdir(parents=True, exist_ok=True)
root = Path(tempfile.mkdtemp(prefix='agent-registration-', dir=args.root.resolve()))
binary = args.binary.resolve()
environment = dict(os.environ, SKILL_EXPERT_ACCEPTANCE_ROOT=str(root))
results = []

def command(arguments, expected=0):
    process = subprocess.run([str(binary), *arguments], env=environment, encoding="utf-8", capture_output=True, timeout=45)
    stream = process.stdout if process.returncode == 0 else process.stderr
    assert process.returncode == expected, (arguments, process.returncode, process.stdout, process.stderr)
    assert not (process.stderr if process.returncode == 0 else process.stdout), (arguments, 'unexpected second output stream')
    payload = json.loads(stream)
    results.append({'arguments': arguments, 'exit': process.returncode, 'result': payload})
    return payload

status = command(['--json', 'repo', 'status'])
assert Path(status['base_dir']).resolve() == (root / 'state').resolve(), 'Requires the current debug build with acceptance isolation'
# Rust canonicalize uses the Windows extended path prefix; keep that native spelling.
root = Path(status['base_dir']).parent
db = Path(status['db_path'])
assert db.is_relative_to(root)
agents = command(['agents', 'list'])
duo = [agent for agent in agents if agent['key'] == 'gitlab_duo']
assert len(duo) == 1 and not duo[0]['is_custom'] and duo[0]['project_relative_skills_dir'] == '.agents/skills'
assert duo[0]['skills_dir'] == str(root / 'home' / '.gitlab' / 'duo' / 'skills')
with sqlite3.connect(db) as connection:
    connection.execute('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)', ('disabled_tools', json.dumps([a['key'] for a in agents])))

first = command(['agents', 'add-custom', '  first  ', '--path', str(root / 'first skills')])
assert first['registered'] is True and first['definition']['key'] == 'first'
assert first['definition']['display_name'] == 'first' and first['definition']['project_relative_skills_dir'] is None
assert first['deployment']['state'] == 'not_run'
second = command(['--json', 'tools', 'add-custom', 'second', '--path', str(root / 'second'), '--name', ' Second ', '--project-path', ' .second/skills '])
assert second['tool']['display_name'] == 'Second' and second['tool']['project_relative_skills_dir'] == '.second/skills'
invalid_inputs = [
    ['first', '--path', str(root / 'replacement')],
    ['gitlab_duo', '--path', str(root / 'duo')],
    ['blank-name', '--path', str(root / 'blank'), '--name', '   '],
    ['bad-global', '--path', 'relative'],
    ['root-project', '--path', str(root / 'root'), '--project-path', './'],
    ['parent-project', '--path', str(root / 'parent'), '--project-path', '.a/../skills'],
]
if os.name == 'nt':
    invalid_inputs.extend([f'windows-project-{i}', '--path', str(root / f'win-{i}'), '--project-path', value]
                          for i, value in enumerate([r'C:\skills', 'C:skills', r'\skills', r'\\server\share\skills', r'\\?\C:\skills', r'..\skills']))
for arguments in invalid_inputs:
    error = command(['agents', 'add-custom', *arguments], 1)
    assert error['registered'] is False
command(['--json', 'agents', 'add-custom', 'missing-path'], 2)

# Independent processes, not threads sharing a store mutex.
def register(key):
    process = subprocess.run([str(binary), '--json', 'agents', 'add-custom', key, '--path', str(root / key)], env=environment, encoding="utf-8", capture_output=True, timeout=45)
    return process.returncode, json.loads(process.stdout or process.stderr)
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    distinct = list(pool.map(register, ['parallel-a', 'parallel-b']))
assert [code for code, _ in distinct] == [0, 0], distinct
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    duplicate = list(pool.map(register, ['same', 'same']))
assert sorted(code for code, _ in duplicate) == [0, 1], duplicate
results.append({'concurrent_distinct': distinct, 'concurrent_duplicate': duplicate})

source = root / 'receipt-demo'
source.mkdir()
(source / 'SKILL.md').write_text('---\nname: receipt-demo\ndescription: isolated registration test\n---\nTest content.\n')
command(['--json', 'skills', 'install', str(source), '--local', '--sync'])
blocked = root / 'blocked-targets/receipt-demo'
blocked.mkdir(parents=True)
(blocked / 'external.txt').write_text('must remain')
partial = command(['agents', 'add-custom', 'blocked_target', '--path', str(blocked.parent)], 1)
assert partial['code'] == 'DEPLOYMENT_INCOMPLETE' and partial['registered'] is True
assert partial['deployment']['state'] == 'partial'
assert any(target['outcome'] == 'refused' and target['tool'] == 'blocked_target' for target in partial['deployment']['targets'])
assert (blocked / 'external.txt').read_text() == 'must remain'
with sqlite3.connect(db) as connection:
    connection.execute("CREATE TRIGGER reject_registration_target BEFORE INSERT ON skill_targets WHEN NEW.tool = 'record_failure' BEGIN SELECT RAISE(ABORT, 'injected'); END;")
unconfirmed = command(['--json', 'agents', 'add-custom', 'record_failure', '--path', str(root / 'unconfirmed')], 1)
assert unconfirmed['registered'] is True and unconfirmed['deployment']['state'] == 'unknown'
assert any(target['tool'] == 'record_failure' and target['outcome'] == 'unconfirmed' for target in unconfirmed['deployment']['targets'])
assert (root / 'unconfirmed/receipt-demo/SKILL.md').read_text() == (source / 'SKILL.md').read_text()
with sqlite3.connect(db) as connection:
    assert connection.execute("SELECT count(*) FROM skill_targets WHERE tool = 'record_failure'").fetchone()[0] == 0
    connection.execute('DROP TRIGGER reject_registration_target')
# After explicit read-only file/record verification, retry only this Agent.
retry = command(['--json', 'skills', 'sync', '--tool', 'record_failure'])
assert retry['deployment']['state'] == 'complete'
assert all(target['tool'] == 'record_failure' for target in retry['deployment']['targets'])

with sqlite3.connect(db) as connection:
    current = json.loads(connection.execute("SELECT value FROM settings WHERE key='custom_tools'").fetchone()[0])
    current.append({'key': 'gitlab_duo', 'display_name': 'Legacy Duo', 'skills_dir': str(root / 'legacy'), 'project_relative_skills_dir': None, 'category': 'lobster'})
    legacy = json.dumps(current, indent=2)
    connection.execute('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)', ('custom_tools', legacy))
    connection.execute('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)', ('custom_tool_paths', json.dumps({'gitlab_duo': 'dormant-relative'})))
for _ in range(2):
    listed = command(['agents', 'list'])
    duo = [agent for agent in listed if agent['key'] == 'gitlab_duo']
    assert len(duo) == 1 and duo[0]['is_custom'] and not duo[0]['enabled']
    assert duo[0]['display_name'] == 'Legacy Duo' and duo[0]['project_relative_skills_dir'] is None
    with sqlite3.connect(db) as connection:
        assert connection.execute("SELECT value FROM settings WHERE key='custom_tools'").fetchone()[0] == legacy
with sqlite3.connect(db) as connection:
    connection.execute("UPDATE settings SET value='{' WHERE key='custom_tools'")
error = command(['agents', 'add-custom', 'blocked', '--path', str(root / 'blocked')], 1)
assert error['registered'] is False
with sqlite3.connect(db) as connection:
    assert connection.execute("SELECT value FROM settings WHERE key='custom_tools'").fetchone()[0] == '{'
    connection.execute("UPDATE settings SET value=? WHERE key='custom_tools'", (legacy,))

output = {'root': str(root), 'binary': str(binary), 'platform': platform.platform(), 'source_sha': os.environ.get('GITHUB_SHA'), 'status': 'passed', 'checks': len(results), 'results': results}
(root / 'results.json').write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'status': 'passed', 'checks': len(results), 'evidence': str(root / 'results.json')}, ensure_ascii=False))
