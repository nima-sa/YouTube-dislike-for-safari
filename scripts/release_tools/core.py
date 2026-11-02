"""Portable release boundaries. Never log secret values or raw Apple responses."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]

def require(ok, message):
    if not ok:
        raise RuntimeError(message)

def run(*args, cwd=ROOT, capture=False, env=None, input=None):
    p = subprocess.run(list(map(str, args)), cwd=cwd, env=env, input=input,
                       stdout=subprocess.PIPE if capture else None, check=True)
    return p.stdout

def git(*args, **kwargs):
    return run('git', *args, **kwargs)

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def policy():
    return json.loads((ROOT / 'release/policy.json').read_text())

def validate_extension_id(app_id, extension_id):
    require(extension_id.startswith(app_id + '.') and
            re.fullmatch(r'[A-Za-z0-9-]+', extension_id[len(app_id) + 1:]),
            'Extension ID must append exactly one bundle identifier component')


def versions():
    p = policy()
    project = (ROOT / 'YouTube Dislike.xcodeproj/project.pbxproj').read_text()
    for key, value in [('MARKETING_VERSION',p['version']), ('CURRENT_PROJECT_VERSION',p['build'])]:
        found = re.findall(r'\b'+key+r' = ([\d.]+);', project)
        require(len(found) == 10 and set(found) == {value}, 'Inconsistent '+key)
    manifest = json.loads((ROOT / 'YouTube Dislike Extension/Resources/manifest.json').read_text())
    require(manifest['version'] == p['version'], 'WebExtension version differs')
    expected = {'page.malina.youtube-dislike':4, 'page.malina.youtube-dislike.macos-extension':2,
                'page.malina.youtube-dislike.ios-extension':2, 'page.malina.youtube-dislike.ios-share':2}
    ids = re.findall(r'PRODUCT_BUNDLE_IDENTIFIER = "([^"]+)";',project)
    require({v:ids.count(v) for v in ids} == expected, 'Bundle identifiers differ')
    for bundle_id in expected:
        if bundle_id != 'page.malina.youtube-dislike':
            validate_extension_id('page.malina.youtube-dislike', bundle_id)
    require(not re.search(r'DEVELOPMENT_TEAM = [A-Z0-9]+;',project), 'Public development team forbidden')
    return p['version'],p['build']

SECRET_PATTERNS = [
    rb'-----BEGIN (?:(?:[A-Z ]+ )?PRIVATE KEY|PGP (?:PRIVATE|SECRET) KEY BLOCK)-----',
    rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16})\b',
    rb'\bxox[baprs]-[A-Za-z0-9-]{20,}\b',
]

def check_contents(name,data, historical=False):
    for pattern in SECRET_PATTERNS:
        require(not re.search(pattern,data), f'Secret pattern detected in {name} (value redacted)')
    if not historical:
        require(not re.search(rb'/(?:Users|home)/[A-Za-z0-9_.-]+/',data), f'Private filesystem path in {name}')

def public_path(name):
    allowed=json.loads((ROOT/'release/public-files.json').read_text())
    return name in allowed and not any(part in {'..','xcuserdata','node_modules','artwork','.git'} for part in Path(name).parts) and Path(name).suffix.lower() not in {'.p8','.p12','.pem','.key','.mobileprovision','.provisionprofile','.ipa','.pkg','.zip','.log'}

def audit(history=False, worktree=False):
    records=git('ls-files','--stage','-z',capture=True).split(b'\0')
    for record in filter(None,records):
        meta,raw=record.split(b'\t',1); name=raw.decode(); mode,blob,stage=meta.split()
        require(public_path(name),f'File outside public allowlist: {name}')
        require(mode in (b'100644',b'100755') and stage == b'0',f'Unsafe Git entry: {name}')
        path=ROOT/name
        require(not path.is_symlink(),f'Symlink forbidden: {name}')
        data=path.read_bytes() if worktree else git('cat-file','blob',blob.decode(),capture=True)
        check_contents(name,data)
    if history:
        objects=git('rev-list','--objects','--all',capture=True).splitlines()
        count=0
        for record in objects:
            blob=record.split(b' ',1)[0].decode()
            if git('cat-file','-t',blob,capture=True).strip()!=b'blob': continue
            # All historical blobs, including binary data; output never contains values.
            check_contents('historical blob '+blob,git('cat-file','blob',blob,capture=True),historical=True)
            count+=1
        print(f'History secret-pattern scan: {count} blobs; no matches. This is not a guarantee of absence.')
    print('Public Git tree checked')
