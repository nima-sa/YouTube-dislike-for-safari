import copy
from datetime import datetime, timedelta, timezone
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from release_tools import core, automation, signing, macos, macos_store

class Safety(unittest.TestCase):
    def test_signing_uses_release_settings(self):
        import plistlib
        from release_tools.build import project_spec
        project={'objects':{
            'target': {'isa':'PBXNativeTarget','name':'App','buildConfigurationList':'configs'},
            'configs': {'buildConfigurations':['debug','release']},
            'debug': {'name':'Debug','buildSettings':{'SDKROOT':'iphoneos','SWIFT_OPTIMIZATION_LEVEL':'-Onone'}},
            'release': {'name':'Release','buildSettings':{'SDKROOT':'iphoneos','SWIFT_OPTIMIZATION_LEVEL':'-O'}},
        }}
        with patch('release_tools.build.quiet',return_value=plistlib.dumps(project)):
            _, spec=project_spec(Path('.'))
        self.assertEqual(spec['targets']['App']['settings']['base']['SWIFT_OPTIMIZATION_LEVEL'],'-O')

    def test_identity_input_preserves_extension_configuration(self):
        import plistlib
        from release_tools.build import embed_identity
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            extension = {'NSExtension': {'NSExtensionPointIdentifier': 'com.apple.share-services'}}
            (root / 'Extension.plist').write_bytes(plistlib.dumps(extension))
            spec = {'targets': {'App': {'settings': {'base': {}}},
                                'Share': {'settings': {'base': {'INFOPLIST_FILE': 'Extension.plist'}}}}}
            embed_identity(root, spec, {'INFOPLIST_KEY_CICommit': 'a' * 40, 'INFOPLIST_KEY_CIBuild': '3'})
            for name, target in spec['targets'].items():
                info = plistlib.loads((root / target['settings']['base']['INFOPLIST_FILE']).read_bytes())
                self.assertEqual(info['CICommit'], 'a' * 40)
                self.assertEqual(info['CIBuild'], '3')
                if name == 'Share': self.assertEqual(info['NSExtension'], extension['NSExtension'])
            self.assertEqual(plistlib.loads((root / 'Extension.plist').read_bytes()), extension)

    def test_altool_detects_help_on_stderr(self):
        from subprocess import CompletedProcess
        modern = b'--api-key <string> --api-issuer <id>'
        for stdout, stderr in [(modern, b''), (b'', modern)]:
            with patch('subprocess.run', return_value=CompletedProcess([], 0, stdout=stdout, stderr=stderr)):
                self.assertEqual(signing.altool_auth('KEY', 'ISSUER', 'IOS'),
                                 ['--api-key', 'KEY', '--api-issuer', 'ISSUER'])
        with patch('subprocess.run', return_value=CompletedProcess([], 0, stdout=b'--type --apiKey', stderr=b'')):
            self.assertEqual(signing.altool_auth('KEY', 'ISSUER', 'MAC_OS')[1], 'osx')
        with patch('subprocess.run', return_value=CompletedProcess([], 0, stdout=b'', stderr=b'unknown')):
            with self.assertRaises(RuntimeError): signing.altool_auth('KEY', 'ISSUER', 'IOS')

    def test_upload_diagnostics_do_not_echo_private_output(self):
        raw = b'Asset validation failed: Invalid large app icon alpha channel /private/secret-path KEYVALUE person@example.org (ITMS-90717)'
        result = signing.upload_failure_summary(raw)
        self.assertIn('alpha channel', result)
        self.assertIn('ITMS-90717', result)
        for private in ['secret-path', 'KEYVALUE', 'person@example.org']:
            self.assertNotIn(private, result)

    def test_versions(self):
        self.assertEqual(core.versions(),('2026.11.1','3'))

    def test_dispatch_verifies_source_before_workflow(self):
        from types import SimpleNamespace
        commit = 'a' * 40
        with patch.object(core, 'git', return_value=commit.encode()), patch.object(automation, 'verify_source', side_effect=RuntimeError('Invalid source')), patch.object(core, 'run') as run:
            with self.assertRaises(RuntimeError):
                automation.dispatch(SimpleNamespace(tag='v2026.11.1'))
            run.assert_not_called()
        with patch.object(core, 'git', return_value=commit.encode()), patch.object(automation, 'verify_source') as verify, patch.object(core, 'run') as run:
            automation.dispatch(SimpleNamespace(tag='v2026.11.1'))
            verify.assert_called_once_with('v2026.11.1', commit)
            self.assertIn('commit=' + commit, run.call_args.args)

    def test_tags(self):
        for tag in ['v01.2.3','v2026.11.1/evil','--help','v2026.11.1\n','2026.11.1']:
            with self.assertRaises(RuntimeError): automation.tag_name(tag)
        self.assertEqual(automation.tag_name('v2026.11.1'),'v2026.11.1')

    def test_tag_version_and_build(self):
        p = {'version': '2026.11.1', 'build': '3'}
        for tag in ['v2026.11.1', 'v2026.11.1-build.3', 'v2026.11.1-build.3-r2']:
            automation.verify_tag_version(tag, p, p)
        for tag in ['v2026.11.1-build.4', 'v2026.11.2-build.3', 'v2026.11.1-build.03', 'v2026.11.1-build.4-r2', 'v2026.11.1-build.3-r02']:
            with self.assertRaises(RuntimeError): automation.verify_tag_version(tag, p, p)
        with self.assertRaises(RuntimeError):
            automation.verify_tag_version('v2026.11.1-build.3', p, {**p, 'version': '2026.11.2'})

    def test_invalid_signature(self):
        from subprocess import CompletedProcess
        for returncode,stderr in [(1,b''),(0,b'[GNUPG:] VALIDSIG OTHER 1 2 OTHER')]:
            with patch('subprocess.run',return_value=CompletedProcess([],returncode,stderr=stderr)):
                with self.assertRaises(RuntimeError): automation.signature('tag','x',{})

    def test_unexpected_paths(self):
        for name in ['Configs/Local.xcconfig','secret.p8','artwork/a.png','docs/log.txt','../README.md','x/xcuserdata/a']:
            self.assertFalse(core.public_path(name))
        self.assertTrue(core.public_path('README.md'))

    def test_secret_redaction(self):
        secret=b'-----BEGIN '+b'PRIVATE KEY-----'
        with self.assertRaises(RuntimeError) as e: core.check_contents('fixture',secret)
        self.assertNotIn(secret.decode(),str(e.exception))

    def test_profile_rejects_wrong_bundle_team_expiry_and_development(self):
        valid={'TeamIdentifier':['TEAM123456'],'Entitlements':{'application-identifier':'TEAM123456.page.malina.youtube-dislike'},
               'ExpirationDate':datetime.now(timezone.utc)+timedelta(days=1),'UUID':'12345678-1234-1234-1234-123456789abc'}
        signing.validate_profile(valid,'page.malina.youtube-dislike','TEAM123456')
        for change in [{'ProvisionedDevices':['device']},{'ProvisionsAllDevices':True},{'TeamIdentifier':['OTHER']},
                       {'ExpirationDate':datetime.now(timezone.utc)-timedelta(days=1)},
                       {'Entitlements':{'application-identifier':'TEAM123456.wrong'}}]:
            with self.assertRaises(RuntimeError): signing.validate_profile({**valid,**change},'page.malina.youtube-dislike','TEAM123456')

    def test_mac_profile_distribution_types(self):
        p={'Platform':['OSX'],'TeamIdentifier':['TEAM123456'],'Entitlements':{'com.apple.application-identifier':'TEAM123456.page.malina.youtube-dislike'},'ExpirationDate':datetime.now(timezone.utc)+timedelta(days=1)}
        macos_store.validate_profile(p,'page.malina.youtube-dislike','TEAM123456',None)
        with self.assertRaises(RuntimeError): macos.validate_profile(p,'page.malina.youtube-dislike','TEAM123456')
        p['ProvisionsAllDevices']=True
        macos.validate_profile(p,'page.malina.youtube-dislike','TEAM123456')
        with self.assertRaises(RuntimeError): macos_store.validate_profile(p,'page.malina.youtube-dislike','TEAM123456',None)

    def test_recovery_and_tampering(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d)
            manifest={'repository':automation.REPO,'commit':'a'*40,'run_id':'123','version':'2026.11.1','build':'3',
                      'apple':{'IOS':{'processing_state':'VALID'},'MAC_OS':{'processing_state':'VALID'}},'macos':{'notarization_status':'Accepted'}}
            for name in automation.ASSETS-{'SHA256SUMS'}: (folder/name).write_text(json.dumps(manifest) if name=='build-manifest.json' else 'fixture')
            (folder/'SHA256SUMS').write_text(''.join(f'{core.sha(p)}  {p.name}\n' for p in sorted(folder.iterdir())))
            (folder/'verification-bundles.jsonl').write_text('fixture')
            automation.check_artifacts(folder,'a'*40,'123')
            for commit,run in [('b'*40,'123'),('a'*40,'124')]:
                with self.assertRaises(RuntimeError): automation.check_artifacts(folder,commit,run)
            (folder/'YouTube-Dislike.ipa').write_text('tampered')
            with self.assertRaises(RuntimeError): automation.check_artifacts(folder,'a'*40,'123')

if __name__=='__main__': unittest.main()
