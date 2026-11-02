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

    def test_versions(self):
        self.assertEqual(core.versions(),('2026.11.1','3'))

    def test_gate_requires_both_permissions(self):
        good={'distribution_allowed':True,'permission_evidence':'https://example.org/permission'}
        for policy,env in [(core.policy(),'true'),(good,'false')]:
            with patch.object(core,'policy',return_value=policy),patch.dict(os.environ,RELEASE_DISTRIBUTION_ALLOWED=env):
                with self.assertRaises(RuntimeError): core.gate()
        with patch.object(core,'policy',return_value=good),patch.dict(os.environ,RELEASE_DISTRIBUTION_ALLOWED='true'): core.gate()

    def test_tags(self):
        for tag in ['v01.2.3','v2026.11.1/evil','--help','v2026.11.1\n','2026.11.1']:
            with self.assertRaises(RuntimeError): automation.tag_name(tag)
        self.assertEqual(automation.tag_name('v2026.11.1'),'v2026.11.1')

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
