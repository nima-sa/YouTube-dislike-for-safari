"""Ephemeral iOS signing and upload. Secrets are read only from environment."""
import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request

from . import core as release


def required(name):
    value = os.environ.get(name, '')
    release.require(value, f'Missing GitHub secret/variable: {name}')
    return value


def quiet(*args, env=None):
    # Never include secret-bearing argv or raw signing output in an exception/log.
    result = subprocess.run([str(a) for a in args], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env)
    release.require(result.returncode == 0, f'{args[0]} failed (private signing output suppressed)')
    return result.stdout


def jwt_signature(der):
    """Convert OpenSSL's short P-256 DER signature to JWT's fixed-width r || s."""
    release.require(len(der) >= 8 and der[0] == 0x30 and der[1] == len(der) - 2,
                    'Invalid ES256 signature')
    values, offset = [], 2
    for _ in range(2):
        release.require(offset + 2 <= len(der) and der[offset] == 2, 'Invalid ES256 integer')
        length = der[offset + 1]
        raw = der[offset + 2:offset + 2 + length]
        release.require(len(raw) == length and 1 <= length <= 33, 'Invalid ES256 integer size')
        value = int.from_bytes(raw, 'big')
        release.require(value < 2 ** 256, 'ES256 integer overflow')
        values.append(value.to_bytes(32, 'big'))
        offset += 2 + length
    release.require(offset == len(der), 'Trailing ES256 signature data')
    return b''.join(values)


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def validate_profile(profile, bundle_id, team):
    entitlements = profile['Entitlements']
    release.require(profile['TeamIdentifier'] == [team], 'Provisioning team differs')
    release.require(entitlements['application-identifier'] == f'{team}.{bundle_id}',
                    'Provisioning bundle identifier differs')
    release.require(not entitlements.get('get-task-allow') and not profile.get('ProvisionedDevices')
                    and not profile.get('ProvisionsAllDevices'), 'An App Store distribution profile is required')
    release.require(profile['ExpirationDate'].replace(tzinfo=timezone.utc) > datetime.now(timezone.utc),
                    'Provisioning profile expired')
    release.require(re.fullmatch(r'[A-Fa-f0-9-]{36}', profile['UUID']), 'Invalid profile UUID')


class Signing:
    platform = 'IOS'

    def __init__(self, directory):
        self.directory = directory
        directory.mkdir(mode=0o700)
        self.profiles = []
        self.keychain = directory / 'ci.keychain-db'
        self.original_keychains = None
        self.profile_map = {}

    def api(self, path):
        url = 'https://api.appstoreconnect.apple.com' + path if path.startswith('/') else path
        parsed = urllib.parse.urlsplit(url)
        release.require(parsed.scheme == 'https' and parsed.netloc == 'api.appstoreconnect.apple.com',
                        'Unexpected App Store API pagination host')
        now = int(time.time())
        header = b64url(json.dumps({'alg': 'ES256', 'kid': self.key_id, 'typ': 'JWT'}).encode())
        payload = b64url(json.dumps({'iss': self.issuer, 'iat': now, 'exp': now + 600,
                                    'aud': 'appstoreconnect-v1'}).encode())
        message = f'{header}.{payload}'
        signing_input = self.directory / 'jwt-input'
        signing_input.write_text(message)
        signature = quiet('openssl', 'dgst', '-sha256', '-sign', self.api_key, signing_input)
        token = message + '.' + b64url(jwt_signature(signature))
        request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)

    def preflight(self, version, build):
        self.version = version
        release.require(os.environ.get('GITHUB_REF') == 'refs/heads/main',
                        'TestFlight uploads run only from main')
        self.team = required('APPLE_TEAM_ID')
        self.prefix = required('BUNDLE_ID_PREFIX')
        self.app_id = required('ASC_APP_ID')
        self.key_id, self.issuer = required('ASC_KEY_ID'), required('ASC_ISSUER_ID')
        release.require(re.fullmatch(r'[A-Z0-9]{10}', self.team), 'Invalid team ID')
        release.require(re.fullmatch(r'[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+', self.prefix), 'Invalid bundle prefix')
        release.require(self.app_id.isdigit() and re.fullmatch(r'[A-Z0-9]{10}', self.key_id)
                        and re.fullmatch(r'[a-fA-F0-9-]{36}', self.issuer), 'Invalid App Store API identifiers')
        self.api_key = self.directory / f'AuthKey_{self.key_id}.p8'
        self.api_key.write_bytes(base64.b64decode(required('ASC_KEY_P8_BASE64'), validate=True))
        self.api_key.chmod(0o600)
        app = self.api(f'/v1/apps/{self.app_id}')['data']
        release.require(app['attributes']['bundleId'] == self.prefix, 'App Store app differs')
        maximum, seen = 0, set()
        path = '/v1/builds?' + urllib.parse.urlencode({'filter[app]': self.app_id, 'filter[preReleaseVersion.platform]': self.platform, 'limit': 200})
        while path:
            release.require(path not in seen, 'Repeated App Store pagination URL')
            seen.add(path)
            page = self.api(path)
            for item in page['data']:
                number = item['attributes']['version']
                release.require(re.fullmatch(r'[1-9]\d*', number), 'Non-integer uploaded build needs manual review')
                maximum = max(maximum, int(number))
            path = page.get('links', {}).get('next')
        release.require(int(build) > maximum, f'Build must exceed uploaded build {maximum}; never reuse an upload number')
        self.previous_build = maximum

    def configure(self, source, spec):
        targets = {name: target for name, target in spec['targets'].items() if target['platform'] == 'iOS'}
        # Separate secrets avoid exceeding GitHub's per-secret size limit when
        # the provisioning profiles are encoded together.
        profile_secrets = {
            'YouTube Dislike iOS': 'IOS_PROFILE_APP_BASE64',
            'YouTube Dislike iOS Extension': 'IOS_PROFILE_SAFARI_BASE64',
            'YouTube Dislike Share': 'IOS_PROFILE_SHARE_BASE64',
        }
        release.require(set(targets) == set(profile_secrets), 'Profile mapping must cover exactly the iOS targets')
        data = {name: required(secret) for name, secret in profile_secrets.items()}
        identifiers = {name: target['settings']['base']['PRODUCT_BUNDLE_IDENTIFIER'].replace(
            '$(BUNDLE_ID_PREFIX)', self.prefix) for name, target in targets.items()}
        self.install_certificate('APPLE_CERTIFICATE_P12_BASE64', 'APPLE_CERTIFICATE_PASSWORD')
        for name, bundle_id in identifiers.items():
            temporary = self.directory / f'{name}.mobileprovision'
            temporary.write_bytes(base64.b64decode(data[name], validate=True))
            profile = plistlib.loads(quiet('security', 'cms', '-D', '-i', temporary))
            validate_profile(profile, bundle_id, self.team)
            uuid = self.install_profile(temporary, profile)
            self.profile_map[bundle_id] = uuid
            settings = targets[name]['settings']['base']
            settings.update(CODE_SIGN_STYLE='Manual', CODE_SIGN_IDENTITY='Apple Distribution',
                            PROVISIONING_PROFILE_SPECIFIER=uuid, DEVELOPMENT_TEAM=self.team)
        (source / 'Configs/Local.xcconfig').write_text(
            f'DEVELOPMENT_TEAM = {self.team}\nBUNDLE_ID_PREFIX = {self.prefix}\n')

    def install_certificate(self, certificate_secret, password_secret, trusted_tools=()):
        cert = self.directory / 'distribution.p12'
        cert.write_bytes(base64.b64decode(required(certificate_secret), validate=True))
        password = secrets.token_urlsafe(32)
        self.original_keychains = quiet('security', 'list-keychains', '-d', 'user').decode()
        quiet('security', 'create-keychain', '-p', password, self.keychain)
        quiet('security', 'set-keychain-settings', '-lut', '21600', self.keychain)
        quiet('security', 'unlock-keychain', '-p', password, self.keychain)
        quiet('security', 'import', cert, '-P', required(password_secret),
              '-t', 'cert', '-f', 'pkcs12', '-k', self.keychain, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security',
              *(value for tool in trusted_tools for value in ('-T', tool)))
        quiet('security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:',
              '-k', password, self.keychain)
        import shlex
        quiet('security', 'list-keychains', '-d', 'user', '-s', self.keychain,
              *shlex.split(self.original_keychains))

    def install_profile(self, temporary, profile):
        uuid = profile['UUID']
        release.require(re.fullmatch(r'[A-Fa-f0-9-]{36}', uuid), 'Invalid profile UUID')
        for folder in ['Library/MobileDevice/Provisioning Profiles',
                       'Library/Developer/Xcode/UserData/Provisioning Profiles']:
            target = Path.home() / folder / f'{uuid}{temporary.suffix}'
            target.parent.mkdir(parents=True, exist_ok=True)
            release.require(not target.exists(), 'Refusing to overwrite an installed profile')
            self.profiles.append(target)
            shutil.copyfile(temporary, target)
        return uuid

    def export(self, archive, output, version, build, provenance, source):
        from .build import validate_bundles
        options = self.directory / 'ExportOptions.plist'
        options.write_bytes(plistlib.dumps({
            'method': 'app-store-connect', 'destination': 'export', 'signingStyle': 'manual',
            'teamID': self.team, 'signingCertificate': 'Apple Distribution',
            'provisioningProfiles': self.profile_map, 'manageAppVersionAndBuildNumber': False,
            'testFlightInternalTestingOnly': False, 'uploadSymbols': True,
        }))
        exported = output / 'export'
        quiet('xcodebuild', '-exportArchive', '-archivePath', archive,
                    '-exportPath', exported, '-exportOptionsPlist', options)
        ipas = list(exported.glob('*.ipa'))
        release.require(len(ipas) == 1, 'Expected exactly one exported IPA')
        extracted = output / 'export-check'
        release.run('ditto', '-x', '-k', ipas[0], extracted)
        apps = list((extracted / 'Payload').glob('*.app'))
        release.require(len(apps) == 1, 'Expected exactly one app in IPA')
        validate_bundles(apps[0], version, build, provenance)
        quiet('codesign', '--verify', '--deep', '--strict', apps[0])
        for bundle in [apps[0], *sorted(apps[0].rglob('*.appex'))]:
            info = plistlib.loads((bundle / 'Info.plist').read_bytes())
            bundle_id = info['CFBundleIdentifier']
            profile = plistlib.loads(quiet('security', 'cms', '-D', '-i', bundle / 'embedded.mobileprovision'))
            validate_profile(profile, bundle_id, self.team)
            release.require(profile['UUID'] == self.profile_map[bundle_id], 'Exported iOS profile differs')
            ent = plistlib.loads(quiet('codesign', '-d', '--entitlements', ':-', bundle))
            release.require(ent.get('application-identifier') == f'{self.team}.{bundle_id}'
                            and not ent.get('get-task-allow'), 'Exported iOS entitlements differ')
        return ipas[0]

    def upload(self, ipa, build):
        before = release.sha(ipa)
        # Apple's altool shim can update independently of Xcode. New versions use
        # kebab-case authentication flags and infer the platform from the IPA.
        help_text = quiet('xcrun', 'altool', '--help')
        auth = (['--api-key', self.key_id, '--api-issuer', self.issuer]
                if b'--api-key <' in help_text else
                ['--type', 'osx' if self.platform == 'MAC_OS' else 'ios',
                 '--apiKey', self.key_id, '--apiIssuer', self.issuer])
        quiet('xcrun', 'altool', '--upload-app', '-f', ipa, *auth,
              env=dict(os.environ, API_PRIVATE_KEYS_DIR=str(self.directory)))
        release.require(release.sha(ipa) == before, 'Artifact changed during upload')
        path = '/v1/builds?' + urllib.parse.urlencode({'filter[app]': self.app_id,
                                                     'filter[version]': build,
                                                     'filter[preReleaseVersion.platform]': self.platform,
                                                     'filter[preReleaseVersion.version]': self.version,
                                                     'include': 'preReleaseVersion', 'limit': 200})
        for _ in range(40):
            page = self.api(path)
            builds = page['data']
            release.require(len(builds) <= 1, 'Ambiguous App Store build number')
            if builds:
                item = builds[0]
                prerelease_id = item['relationships']['preReleaseVersion']['data']['id']
                versions = [v for v in page.get('included', [])
                            if v['type'] == 'preReleaseVersions' and v['id'] == prerelease_id]
                release.require(len(versions) == 1 and versions[0]['attributes']['platform'] == self.platform
                                and versions[0]['attributes']['version'] == self.version
                                and item['attributes']['version'] == build,
                                'Apple returned a different platform, version or build')
                state = item['attributes']['processingState']
                release.require(state not in ('FAILED', 'INVALID'), 'Apple rejected the uploaded build')
                if state == 'VALID':
                    return {'app_id': self.app_id, 'build_id': item['id'], 'processing_state': state,
                            'build_number': build, 'previous_max_build': self.previous_build,
                            'platform': self.platform, 'marketing_version': self.version,
                            'status': 'processed-for-testflight', 'app_store_published': False}
            print(f'Waiting for App Store Connect {self.platform} processing...', flush=True)
            time.sleep(30)
        raise RuntimeError('Apple processing timed out; inspect App Store Connect before another upload')

    def cleanup(self):
        import shlex
        errors = []
        actions = []
        if self.original_keychains is not None:
            actions.append(lambda: quiet('security', 'list-keychains', '-d', 'user', '-s', *shlex.split(self.original_keychains)))
        if self.keychain.exists():
            actions.append(lambda: quiet('security', 'delete-keychain', self.keychain))
        for profile in self.profiles:
            actions.append(lambda p=profile: p.unlink(missing_ok=True))
        actions.append(lambda: shutil.rmtree(self.directory))
        for action in actions:
            try:
                action()
            except Exception:
                errors.append(True)
        release.require(not errors, 'Temporary signing cleanup failed')
