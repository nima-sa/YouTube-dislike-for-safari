"""Signed exact-source dispatch and credential-free publication recovery."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from . import core

REPO='skar404/youtube-dislike-for-safari'
ASSETS={'YouTube-Dislike.ipa','YouTube-Dislike-macOS.pkg','YouTube-Dislike-macOS.zip','build-manifest.json','SHA256SUMS'}

def tag_name(tag):
    core.require(isinstance(tag,str) and re.fullmatch(r'v[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-build\.[1-9]\d*(?:-r[1-9]\d*)?)?',tag), 'Invalid release tag')
    return tag

@contextmanager
def keyring():
    with tempfile.TemporaryDirectory() as folder:
        env=dict(os.environ,GNUPGHOME=folder)
        subprocess.run(['gpg','--batch','--import',str(core.ROOT/'release/signing-key.asc')],env=env,capture_output=True,check=True)
        yield env

def signature(kind,ref,env):
    p=subprocess.run(['git','-c','gpg.format=openpgp','-c','gpg.program=gpg','verify-'+kind,'--raw',ref],cwd=core.ROOT,env=env,capture_output=True)
    lines=[line.split() for line in p.stderr.decode().splitlines() if line.startswith('[GNUPG:] VALIDSIG ')]
    core.require(p.returncode==0 and any(core.policy()['signing_fingerprint'] in (line[2],line[-1]) for line in lines),'Untrusted '+kind+' signature')

def verify_tag_version(tag, tagged, current):
    tag_name(tag)
    allowed = {'v' + tagged['version'], 'v' + tagged['version'] + '-build.' + tagged['build']}
    retry = re.fullmatch(re.escape('v' + tagged['version'] + '-build.' + tagged['build']) + r'-r[1-9]\d*', tag)
    core.require((tag in allowed or retry) and tagged['version'] == current['version'] and tagged['build'] == current['build'],
                 'Tag/version/build mismatch')

def verify_source(tag,commit):
    tag_name(tag)
    core.require(re.fullmatch(r'[0-9a-f]{40}',commit or ''),'Exact source commit required')
    core.require(os.environ.get('GITHUB_REPOSITORY',REPO)==REPO,'Repository differs')
    core.git('fetch','--no-tags','origin','refs/heads/main:refs/remotes/origin/main',f'refs/tags/{tag}:refs/release-check/{tag}')
    ref=f'refs/release-check/{tag}'
    core.require(core.git('cat-file','-t',ref,capture=True).strip()==b'tag','Annotated tag required')
    core.require(core.git('rev-parse',ref+'^{commit}',capture=True).decode().strip()==commit,'Tag/commit mismatch')
    core.git('merge-base','--is-ancestor',commit,'origin/main')
    obj=core.git('rev-parse',ref,capture=True).decode().strip()
    core.require(core.git('ls-remote','--refs','origin',f'refs/tags/{tag}',capture=True).decode().strip()==f'{obj}\trefs/tags/{tag}','Remote tag changed')
    with keyring() as env:
        signature('tag',ref,env); signature('commit',commit,env)
    p=json.loads(core.git('show',commit+':release/policy.json',capture=True))
    verify_tag_version(tag,p,core.policy())
    return p

def verify(a):
    verify_source(a.tag,a.commit)
    print('Signed release source verified')

def dispatch(a):
    tag_name(a.tag)
    commit=core.git('rev-parse',f'{a.tag}^{{commit}}',capture=True).decode().strip()
    verify_source(a.tag,commit)
    core.run('gh','workflow','run','release.yml','--repo',REPO,'--ref','main','-f','tag='+a.tag,'-f','commit='+commit)

def identity_settings(commit=None):
    version,build=core.versions()
    commit=commit or core.git('rev-parse','HEAD',capture=True).decode().strip()
    run=os.environ.get('GITHUB_RUN_ID',''); attempt=os.environ.get('GITHUB_RUN_ATTEMPT','')
    core.require(os.environ.get('GITHUB_REPOSITORY')==REPO and re.fullmatch('[0-9a-f]{40}',commit) and run.isdigit() and attempt.isdigit(),'Invalid CI identity')
    return {f'INFOPLIST_KEY_{k}':v for k,v in {'CIRepository':REPO,'CICommit':commit,'CIRun':run,'CIAttempt':attempt,'CIVersion':version,'CIBuild':build}.items()}

def identity(a):
    Path(a.output).write_text(''.join(f'{k} = {v}\n' for k,v in identity_settings().items()))

def build(a):
    verify(a)
    core.require(core.git('rev-parse','HEAD',capture=True).decode().strip()==a.commit,'Build checkout differs from signed source')
    core.versions(); core.audit(history=True)
    from .build import build_release
    build_release(Path(a.output),a.commit)

def check_artifacts(folder,commit,run):
    core.require({p.name for p in folder.iterdir()} == ASSETS | {'verification-bundles.jsonl'},'Unexpected release artifact set')
    sums={}
    for line in (folder/'SHA256SUMS').read_text().splitlines():
        digest,name=line.split('  ',1)
        core.require(name in ASSETS-{'SHA256SUMS'} and name not in sums and re.fullmatch('[0-9a-f]{64}',digest),'Unsafe checksum entry')
        core.require(not (folder/name).is_symlink() and core.sha(folder/name)==digest,'Artifact checksum mismatch')
        sums[name]=digest
    core.require(set(sums)==ASSETS-{'SHA256SUMS'},'Incomplete checksums')
    m=json.loads((folder/'build-manifest.json').read_text())
    core.require(m['commit']==commit and str(m['run_id'])==run and m['repository']==REPO,'Artifact source differs')
    core.require(m['version']==core.policy()['version'] and m['build']==core.policy()['build'],'Artifact version/build differs')
    core.require(all(m['apple'][p]['processing_state']=='VALID' for p in ('IOS','MAC_OS')) and m['macos']['notarization_status']=='Accepted','Missing processing/notarization evidence')
    return m

def publish(a):
    verify(a)
    run=a.source_run
    core.require(re.fullmatch('[1-9][0-9]*',run or ''),'source_run must be numeric')
    result=json.loads(core.run('gh','api',f'repos/{REPO}/actions/runs/{run}',capture=True))
    core.require(result['path']=='.github/workflows/release.yml' and result['event']=='workflow_dispatch' and result['head_branch']=='main' and result['conclusion']=='success','Source run is not a successful protected release workflow')
    # Release workflow checks out the signed commit, which can differ from workflow main.
    with tempfile.TemporaryDirectory() as d:
        folder=Path(d)/'public'
        core.run('gh','run','download',run,'--repo',REPO,'--name','release-public','--dir',folder)
        m=check_artifacts(folder,a.commit,run)
        core.require(m['workflow_commit']==result['head_sha'],'Workflow revision differs')
        for name in sorted(ASSETS):
            output=json.loads(core.run('gh','attestation','verify',folder/name,'--repo',REPO,
                       '--signer-workflow',REPO+'/.github/workflows/release.yml','--source-digest',a.commit,
                       '--format','json',capture=True))
            core.require(output,'Missing verified attestation')
            # Bind to this run, not merely another successful workflow for the same source.
            for verified in output:
                statement=verified['verificationResult']['statement']
                invocation=statement['predicate']['runDetails']['metadata']['invocationId']
                core.require(invocation.startswith(f'https://github.com/{REPO}/actions/runs/{run}/'),'Attestation run differs')
        existing=subprocess.run(['gh','release','view',a.tag,'--repo',REPO],capture_output=True)
        core.require(existing.returncode!=0,'Release exists; never overwrite or automatically replace a draft')
        core.run('gh','release','create',a.tag,'--repo',REPO,'--verify-tag','--draft','--title',a.tag,
                 '--notes','Signed source and attested CI artifacts. App Store review and publication have not been requested.',
                 *sorted(folder.iterdir()))
        downloaded=Path(d)/'downloaded'
        core.run('gh','release','download',a.tag,'--repo',REPO,'--dir',downloaded)
        core.require({p.name:core.sha(p) for p in downloaded.iterdir()}=={p.name:core.sha(p) for p in folder.iterdir()},'Draft upload differs')
        core.run('gh','release','edit',a.tag,'--repo',REPO,'--draft=false')
