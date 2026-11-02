"""Developer ID signing and notarization for the directly downloadable Mac app."""
import base64
from datetime import datetime, timezone
import json
import os
import plistlib
import re

from . import core
from .signing import Signing, quiet, required


def validate_profile(profile, bundle_id, team):
    ent = profile['Entitlements']
    core.require(profile['TeamIdentifier'] == [team]
                 and ent['com.apple.application-identifier'] == f'{team}.{bundle_id}', 'macOS profile identity differs')
    core.require(profile.get('ProvisionsAllDevices') is True and not profile.get('ProvisionedDevices')
                 and not ent.get('com.apple.security.get-task-allow') and not ent.get('get-task-allow'),
                 'Developer ID distribution profile required')
    core.require(profile['ExpirationDate'].replace(tzinfo=timezone.utc) > datetime.now(timezone.utc), 'macOS profile expired')


class MacSigning(Signing):
    def preflight(self):
        core.require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') == 'refs/heads/main',
                     'Developer ID CI signing runs only on main')
        self.team, self.prefix = required('APPLE_TEAM_ID'), required('BUNDLE_ID_PREFIX')
        self.key_id, self.issuer = required('ASC_KEY_ID'), required('ASC_ISSUER_ID')
        core.require(re.fullmatch(r'[A-Z0-9]{10}', self.team)
                     and re.fullmatch(r'[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+', self.prefix), 'Invalid macOS signing identifiers')
        self.api_key = self.directory / f'AuthKey_{self.key_id}.p8'
        self.api_key.write_bytes(base64.b64decode(required('ASC_KEY_P8_BASE64'), validate=True))
        self.api_key.chmod(0o600)
        for secret in ['MACOS_CERTIFICATE_P12_BASE64', 'MACOS_CERTIFICATE_PASSWORD',
                       'MACOS_PROFILE_APP_BASE64', 'MACOS_PROFILE_SAFARI_BASE64']:
            required(secret)

    def configure(self, source, spec):
        targets = {name: t for name, t in spec['targets'].items() if t['platform'] == 'macOS'}
        mapping = {'YouTube Dislike': 'MACOS_PROFILE_APP_BASE64', 'YouTube Dislike Extension': 'MACOS_PROFILE_SAFARI_BASE64'}
        core.require(set(targets) == set(mapping), 'macOS profile mapping differs')
        self.install_certificate('MACOS_CERTIFICATE_P12_BASE64', 'MACOS_CERTIFICATE_PASSWORD')
        for name, secret in mapping.items():
            settings = targets[name]['settings']['base']
            bundle_id = settings['PRODUCT_BUNDLE_IDENTIFIER'].replace('$(BUNDLE_ID_PREFIX)', self.prefix)
            temporary = self.directory / f'{name}.provisionprofile'
            temporary.write_bytes(base64.b64decode(required(secret), validate=True))
            profile = plistlib.loads(quiet('security', 'cms', '-D', '-i', temporary))
            validate_profile(profile, bundle_id, self.team)
            uuid = self.install_profile(temporary, profile)
            self.profile_map[bundle_id] = uuid
            settings.update(CODE_SIGN_STYLE='Manual', CODE_SIGN_IDENTITY='Developer ID Application',
                            PROVISIONING_PROFILE_SPECIFIER=uuid, DEVELOPMENT_TEAM=self.team,
                            ENABLE_HARDENED_RUNTIME='YES', OTHER_CODE_SIGN_FLAGS='--timestamp',
                            ARCHS='arm64 x86_64', ONLY_ACTIVE_ARCH='NO')
        (source / 'Configs/Local.xcconfig').write_text(f'DEVELOPMENT_TEAM = {self.team}\nBUNDLE_ID_PREFIX = {self.prefix}\n')

    def export_notarize(self, archive, output, version, build, provenance):
        from .build import validate_bundles
        options = self.directory / 'ExportOptions.plist'
        options.write_bytes(plistlib.dumps({'method': 'developer-id', 'destination': 'export', 'signingStyle': 'manual',
                                           'teamID': self.team, 'signingCertificate': 'Developer ID Application',
                                           'provisioningProfiles': self.profile_map,
                                           'manageAppVersionAndBuildNumber': False}))
        exported = output / 'macos-export'
        quiet('xcodebuild', '-exportArchive', '-archivePath', archive,
                 '-exportPath', exported, '-exportOptionsPlist', options)
        apps = list(exported.glob('*.app'))
        core.require(len(apps) == 1, 'Expected one exported Mac app')
        app = apps[0]
        bundles = validate_bundles(app, version, build, provenance)
        for bundle in [app, *sorted(app.rglob('*.appex'))]:
            core.run('codesign', '--verify', '--strict', bundle)
            details = quiet('codesign', '-d', '--entitlements', ':-', bundle)
            ent = plistlib.loads(details)
            core.require(not ent.get('com.apple.security.get-task-allow'), 'Debug entitlement in exported Mac app')
            info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
            binary = bundle / 'Contents/MacOS' / info['CFBundleExecutable']
            core.require(set(core.run('lipo', '-archs', binary, capture=True).decode().split()) == {'arm64', 'x86_64'},
                         'macOS distribution must be universal (Apple Silicon and Intel)')
        submission = output / 'macos-notarization.zip'
        core.run('ditto', '-c', '-k', '--keepParent', app, submission)
        result = json.loads(quiet('xcrun', 'notarytool', 'submit', submission, '--key', self.api_key,
                                  '--key-id', self.key_id, '--issuer', self.issuer,
                                  '--wait', '--timeout', '30m', '--output-format', 'json'))
        core.require(result.get('status') == 'Accepted', 'Apple notarization was not accepted; no Mac artifact will be published')
        core.run('xcrun', 'stapler', 'staple', app)
        core.run('xcrun', 'stapler', 'validate', app)
        core.run('codesign', '--verify', '--deep', '--strict', app)
        core.run('spctl', '--assess', '--type', 'execute', app)
        # Stapling changes bytes; only package/hash/attest the final stapled app.
        artifact = output / 'public/Slowth-macOS.zip'
        core.run('ditto', '-c', '-k', '--keepParent', app, artifact)
        return {'name': artifact.name, 'sha256': core.sha(artifact), 'notarization_status': result['status'],
                'notarization_id': result['id'], 'architectures': ['arm64', 'x86_64'],
                'distribution': 'developer-id', 'bundles': bundles}
