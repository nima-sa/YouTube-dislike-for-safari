"""Ephemeral signing; only the explicit public artifact directory is exportable."""
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import tempfile
from . import core
from .automation import identity_settings, REPO
from .signing import Signing, quiet
from .macos import MacSigning
from .macos_store import MacStoreSigning


def validate_bundles(app,version,build,identity):
    records=[]
    mac=(app/'Contents').is_dir()
    expected={'page.malina.youtube-dislike', 'page.malina.youtube-dislike.macos.extension'} if mac else {
        'page.malina.youtube-dislike','page.malina.youtube-dislike.ios.extension','page.malina.youtube-dislike.ios.share'}
    for bundle in [app,*sorted(app.rglob('*.appex'))]:
        content=bundle/'Contents' if mac else bundle
        info=plistlib.loads((content/'Info.plist').read_bytes())
        core.require(info['CFBundleShortVersionString']==version and info['CFBundleVersion']==build,'Built version differs')
        for key,value in identity.items():
            core.require(str(info.get(key.removeprefix('INFOPLIST_KEY_')))==value,'Embedded CI identity differs')
        binary=(content/'MacOS' if mac else content)/info['CFBundleExecutable']
        architectures=set(quiet('lipo','-archs',binary).decode().split())
        core.require(architectures==({'arm64','x86_64'} if mac else {'arm64'}),'Built architectures differ')
        records.append({'bundle_id':info['CFBundleIdentifier'],'version':version,'build':build,'executable_sha256':core.sha(binary)})
    core.require(len(records)==len(expected) and {r['bundle_id'] for r in records}==expected,'Embedded target set differs')
    return records


def project_spec(source):
    path=source/'YouTube Dislike.xcodeproj/project.pbxproj'
    project=plistlib.loads(quiet('plutil','-convert','xml1','-o','-',path))
    targets={}
    for obj in project['objects'].values():
        if obj.get('isa')!='PBXNativeTarget': continue
        configs=project['objects'][obj['buildConfigurationList']]['buildConfigurations']
        settings=[project['objects'][c]['buildSettings'] for c in configs]
        release=next(project['objects'][c]['buildSettings'] for c in configs if project['objects'][c]['name']=='Release')
        platform='iOS' if settings[0].get('SDKROOT')=='iphoneos' else 'macOS'
        targets[obj['name']]={'platform':platform,'settings':{'base':dict(release)},'_configs':settings}
    return project,{'targets':targets}


def build_release(output,commit):
    core.require(os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('GITHUB_REF')=='refs/heads/main','Signing only in main CI')
    def interrupted(signum, frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    output.mkdir(parents=True,exist_ok=False)
    public=output/'public'; public.mkdir()
    version,build=core.versions(); identity=identity_settings(commit)
    # All compilation/project mutations are isolated from the authenticated checkout.
    with tempfile.TemporaryDirectory(prefix='ryd-release-') as temp:
        work=Path(temp); source=work/'source'; source.mkdir()
        quiet('git','archive','--format=tar','--output',work/'source.tar',commit)
        quiet('tar','-xf',work/'source.tar','-C',source)
        project,spec=project_spec(source)
        signers=[]
        try:
            mac=MacSigning(work/'developer-id'); signers.append(mac)
            mac.preflight(); mac.configure(source,spec)
            ios=Signing(work/'ios'); signers.append(ios)
            ios.preflight(version,build); ios.configure(source,spec)
            store=MacStoreSigning(work/'mac-store'); signers.append(store)
            store.preflight(version,build); store.configure(source,spec)
            for target in spec['targets'].values():
                for settings in target['_configs']:
                    settings.update(target['settings']['base']); settings.update(identity)
            (source/'YouTube Dislike.xcodeproj/project.pbxproj').write_bytes(plistlib.dumps(project))
            archives={}; records={}
            for platform in ['macOS','iOS']:
                archive=work/(platform+'.xcarchive'); archives[platform]=archive
                quiet('xcodebuild','-quiet','-project',source/'YouTube Dislike.xcodeproj','-scheme','YouTube Dislike '+platform,
                      '-configuration','Release','-destination','generic/platform='+platform,'-derivedDataPath',work/('derived-'+platform),
                      '-archivePath',archive,'archive')
                apps=list((archive/'Products/Applications').glob('*.app'))
                core.require(len(apps)==1,'Expected one archived app')
                records[platform]=validate_bundles(apps[0],version,build,identity)
                quiet('codesign','--verify','--deep','--strict',apps[0])
            # Exports and notarization stay in temp; only final packages are retained.
            (work/'public').mkdir()
            mac_record=mac.export_notarize(archives['macOS'],work,version,build,identity)
            ipa=ios.export(archives['iOS'],work,version,build,identity,source)
            pkg,store_bundles=store.export(archives['macOS'],work,version,build,identity)
            for path,name in [(ipa,'YouTube-Dislike.ipa'),(pkg,'YouTube-Dislike-macOS.pkg'),(work/'public/YouTube-Dislike-macOS.zip','YouTube-Dislike-macOS.zip')]:
                shutil.copyfile(path,public/name)
            # No retry after an uncertain upload: next preflight refuses an existing number.
            apple={'IOS':ios.upload(public/'YouTube-Dislike.ipa',build),
                   'MAC_OS':store.upload(public/'YouTube-Dislike-macOS.pkg',build)}
            manifest={'repository':REPO,'commit':commit,'workflow_commit':os.environ['GITHUB_SHA'],
                      'run_id':os.environ['GITHUB_RUN_ID'],'version':version,'build':build,
                      'tools':{'xcode':quiet('xcodebuild','-version').decode().strip(),
                               'swift':quiet('swift','--version').decode().strip(),
                               'macos':quiet('sw_vers','-productVersion').decode().strip()},
                      'apple':apple,'macos':mac_record,'bundles':records,'mac_store_bundles':store_bundles,
                      'checks':['signed-commit-and-tag','public-tree','versions','unsigned-builds','javascript','swift','release-safety',
                                'bundle-identifiers','code-signatures','universal-macos','notarization','stapling','apple-processing'],
                      'limitations':'Provenance only, not byte-for-byte reproducibility. Device QA and App Review are separate.'}
            (public/'build-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
            core.check_contents('build-manifest.json',(public/'build-manifest.json').read_bytes())
            (public/'SHA256SUMS').write_text(''.join(f'{core.sha(p)}  {p.name}\n' for p in sorted(public.iterdir())))
        finally:
            # Continue cleanup even when another cleanup step fails.
            failures=[]
            for signer in reversed(signers):
                try: signer.cleanup()
                except Exception: failures.append(type(signer).__name__)
            core.require(not failures,'Signing cleanup failed: '+', '.join(failures))
