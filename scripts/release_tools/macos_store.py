"""Export the Mac archive for TestFlight, separately from its Developer ID ZIP."""
import base64
from datetime import datetime, timezone
import plistlib
import re

from . import core
from .signing import Signing, quiet, required


def installer_identity(identities, team):
    matches = re.findall(r'^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"(?:3rd Party Mac Developer Installer|Mac Installer Distribution): '
                         r'[^"\r\n]+ \(([A-Z0-9]{10})\)"\s*$', identities, re.MULTILINE)
    fingerprints = [fingerprint.upper() for fingerprint, owner in matches if owner == team]
    core.require(len(fingerprints) == 1, 'Expected one valid Mac Installer identity for the configured team')
    return fingerprints[0]


def validate_profile(profile, bundle_id, team, group):
    ent = profile['Entitlements']
    core.require(profile.get('Platform') == ['OSX'] and profile['TeamIdentifier'] == [team]
                 and ent.get('com.apple.application-identifier') == f'{team}.{bundle_id}',
                 'Mac App Store profile identity differs')
    core.require(not profile.get('ProvisionsAllDevices') and not profile.get('ProvisionedDevices')
                 and not ent.get('com.apple.security.get-task-allow') and not ent.get('get-task-allow'),
                 'Mac App Store distribution profile required; Developer ID and development profiles are not accepted')
    core.require(profile['ExpirationDate'].replace(tzinfo=timezone.utc) > datetime.now(timezone.utc), 'Mac App Store profile expired')


class MacStoreSigning(Signing):
    platform = 'MAC_OS'

    def configure(self, source, spec):
        targets = {name: t for name, t in spec['targets'].items() if t['platform'] == 'macOS'}
        mapping = {'YouTube Dislike': 'MACOS_STORE_PROFILE_APP_BASE64', 'YouTube Dislike Extension': 'MACOS_STORE_PROFILE_SAFARI_BASE64'}
        core.require(set(targets) == set(mapping), 'Mac App Store profile mapping differs')
        # The iOS signing keychain already supplies the Apple Distribution identity.
        # Add an installer identity in a nested keychain; unwind in reverse order.
        self.install_certificate('MACOS_INSTALLER_P12_BASE64', 'MACOS_INSTALLER_PASSWORD',
                                 trusted_tools=('/usr/bin/productbuild', '/usr/bin/productsign'))
        self.installer_certificate = installer_identity(
            quiet('security', 'find-identity', '-v', '-p', 'basic', self.keychain).decode(), self.team)
        for name, secret in mapping.items():
            bundle_id = targets[name]['settings']['base']['PRODUCT_BUNDLE_IDENTIFIER'].replace('$(BUNDLE_ID_PREFIX)', self.prefix)
            temporary = self.directory / f'{name}.provisionprofile'
            temporary.write_bytes(base64.b64decode(required(secret), validate=True))
            profile = plistlib.loads(quiet('security', 'cms', '-D', '-i', temporary))
            validate_profile(profile, bundle_id, self.team, f'group.{self.prefix}.shared')
            self.profile_map[bundle_id] = self.install_profile(temporary, profile)
        # Do not change archive settings: Xcode re-signs the same compiled archive
        # with these App Store identities during this separate export.

    def export(self, archive, output, version, build, provenance):
        from .build import validate_bundles
        options = self.directory / 'ExportOptions.plist'
        options.write_bytes(plistlib.dumps({
            'method': 'app-store-connect', 'destination': 'export', 'signingStyle': 'manual',
            'teamID': self.team, 'signingCertificate': 'Apple Distribution',
            'installerSigningCertificate': self.installer_certificate,
            'provisioningProfiles': self.profile_map, 'manageAppVersionAndBuildNumber': False,
            'testFlightInternalTestingOnly': False, 'uploadSymbols': True,
        }))
        exported = output / 'macos-store-export'
        quiet('xcodebuild', '-exportArchive', '-archivePath', archive,
                 '-exportPath', exported, '-exportOptionsPlist', options)
        packages = list(exported.glob('*.pkg'))
        core.require(len(packages) == 1, 'Expected exactly one Mac App Store package')
        package = packages[0]
        signature = quiet('pkgutil', '--check-signature', package).decode()
        core.require(f'({self.team})' in signature and
                     ('3rd Party Mac Developer Installer:' in signature or 'Mac Installer Distribution:' in signature),
                     'Mac installer signature differs')
        extracted = output / 'macos-store-check'
        core.run('pkgutil', '--expand-full', package, extracted)
        apps = list(extracted.rglob('*.app'))
        core.require(len(apps) == 1, 'Expected exactly one app inside Mac package')
        app = apps[0]
        bundles = validate_bundles(app, version, build, provenance)
        core.run('codesign', '--verify', '--deep', '--strict', app)
        for bundle in [app, *sorted(app.rglob('*.appex'))]:
            info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
            bundle_id = info['CFBundleIdentifier']
            profile = plistlib.loads(quiet('security', 'cms', '-D', '-i', bundle / 'Contents/embedded.provisionprofile'))
            validate_profile(profile, bundle_id, self.team, f'group.{self.prefix}.shared')
            core.require(profile['UUID'] == self.profile_map[bundle_id], 'Exported Mac App Store profile differs')
            ent = plistlib.loads(quiet('codesign', '-d', '--entitlements', ':-', bundle))
            core.require(ent.get('com.apple.security.app-sandbox') is True
                         and not ent.get('com.apple.security.get-task-allow')
                         and ent.get('com.apple.application-identifier') == f'{self.team}.{bundle_id}',
                         'Exported Mac TestFlight entitlements differ')
            binary = bundle / 'Contents/MacOS' / info['CFBundleExecutable']
            core.require(set(core.run('lipo', '-archs', binary, capture=True).decode().split()) == {'arm64', 'x86_64'},
                         'Mac TestFlight package must support Apple Silicon and Intel')
        return package, bundles
