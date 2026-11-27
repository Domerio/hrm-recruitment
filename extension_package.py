"""Build an unpacked-browser-extension ZIP from public extension source only."""
import fnmatch
from html.parser import HTMLParser
import io
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
from urllib.parse import urlsplit
import zipfile


PACKAGE_ROOT = 'hrm-boss-extension'
_SUFFIXES = {'.js', '.mjs', '.html', '.css', '.svg', '.png', '.jpg', '.jpeg',
             '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.wasm'}
_PRIVATE_NAMES = {'test', 'tests', 'logs', 'log', 'data', 'backups', 'backup',
                  'node_modules', '__pycache__', 'secrets', 'credentials', 'keys'}
_MAX_FILE_BYTES = 16 * 1024 * 1024
_MAX_PACKAGE_BYTES = 80 * 1024 * 1024


class ExtensionPackageError(ValueError):
    pass


def _public_name(path):
    for part in path.parts:
        lower = part.lower()
        if (part.startswith('.') or '\\' in part or ':' in part or
                lower in _PRIVATE_NAMES or lower.startswith(('test_', 'test-', 'secret', 'credential')) or
                '.test.' in lower or '.spec.' in lower):
            return False
    return True


def _linked(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) &
                                            getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400))


def _reference(path, *, parent='', wildcard=False):
    if (not isinstance(path, str) or not path or '\\' in path or ':' in path or
            path.startswith('/') or any(part == '..' for part in PurePosixPath(path).parts)):
        raise ExtensionPackageError('插件资源路径无效，请检查插件发布文件后重试')
    value = (PurePosixPath(parent) / path).as_posix()
    if not _public_name(PurePosixPath(value)) or (not wildcard and any(char in value for char in '*?[')):
        raise ExtensionPackageError('插件包含不可发布的资源引用，请检查插件文件后重试')
    return value


def _manifest_references(manifest):
    for key in ('action', 'browser_action', 'page_action'):
        item = manifest.get(key, {})
        if item.get('default_popup'):
            yield item['default_popup'], False
        icons = item.get('default_icon', {})
        for icon in ([icons] if isinstance(icons, str) else icons.values()):
            yield icon, False
    for icon in manifest.get('icons', {}).values():
        yield icon, False
    background = manifest.get('background', {})
    for script in background.get('scripts', []):
        yield script, False
    for key in ('service_worker', 'page'):
        if background.get(key):
            yield background[key], False
    for item in manifest.get('content_scripts', []):
        for resource in item.get('js', []) + item.get('css', []):
            yield resource, False
    for item in manifest.get('web_accessible_resources', []):
        for resource in ([item] if isinstance(item, str) else item.get('resources', [])):
            yield resource, True
    for key in ('options_page', 'devtools_page'):
        if manifest.get(key):
            yield manifest[key], False
    for item, key in ((manifest.get('options_ui', {}), 'page'), (manifest.get('side_panel', {}), 'default_path')):
        if item.get(key):
            yield item[key], False


class _HTMLResources(HTMLParser):
    def __init__(self):
        super().__init__()
        self.references = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        attribute = 'href' if tag == 'link' else 'src' if tag in ('script', 'img', 'iframe') else None
        if attribute and values.get(attribute):
            self.references.append(values[attribute])


def _validate_resources(files, manifest):
    def require(value, *, parent='', wildcard=False):
        name = _reference(value, parent=parent, wildcard=wildcard)
        if not (any(fnmatch.fnmatchcase(item, name) for item in files) if wildcard else name in files):
            raise ExtensionPackageError('插件运行文件不完整，请重新部署 extension 目录后重试')
    for value, wildcard in _manifest_references(manifest):
        require(value, wildcard=wildcard)
    for name, content in files.items():
        suffix = PurePosixPath(name).suffix
        parent = str(PurePosixPath(name).parent)
        if suffix == '.html':
            parser = _HTMLResources()
            parser.feed(content.decode('utf-8-sig'))
            for value in parser.references:
                parsed = urlsplit(value)
                if parsed.scheme or parsed.netloc or not parsed.path:
                    continue
                require(parsed.path, parent=parent)
        elif suffix in ('.js', '.mjs'):
            text = content.decode('utf-8-sig')
            for value in re.findall(r'''\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']''', text):
                if value.startswith('.'):
                    require(value, parent=parent)
            for value in re.findall(r'''\bruntime\.getURL\(\s*["']([^"']+)["']''', text):
                require(value)
            for group in re.findall(r'\bfiles\s*:\s*\[([^\]]*)\]', text):
                for value in re.findall(r'''["']([^"']+)["']''', group):
                    require(value)
            # This extension also injects named literal lists, including the
            # conditional canvas `scripts` arrays. Check those declarations,
            # without trying to evaluate arbitrary JavaScript expressions.
            for variable in set(re.findall(r'\b(?:files|js)\s*:\s*([A-Za-z_$][\w$]*)\b', text)):
                declaration = r'\b(?:const|let|var)\s+' + re.escape(variable) + r'\s*=\s*([^;]+);'
                for expression in re.findall(declaration, text):
                    for value in re.findall(r'''["']([^"']+\.m?js)["']''', expression):
                        require(value)


def _snapshot(directory):
    try:
        source = Path(directory)
        if _linked(source) or not source.is_dir():
            raise ExtensionPackageError('插件发布目录不可用，请检查工作台 extension 目录')
        root = source.resolve(strict=True)
        files, total = {}, 0
        def walk_error(error):
            raise error
        for folder, directories, names in os.walk(root, followlinks=False, onerror=walk_error):
            base = Path(folder)
            directories[:] = sorted(name for name in directories
                                    if _public_name((base / name).relative_to(root)) and not _linked(base / name))
            for name in sorted(names):
                file = base / name
                relative = file.relative_to(root)
                if (not _public_name(relative) or _linked(file) or
                        (relative.as_posix() not in ('manifest.json', '安装说明.md') and file.suffix.lower() not in _SUFFIXES)):
                    continue
                info = file.stat()
                if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
                    continue
                if not file.resolve(strict=True).is_relative_to(root) or info.st_size > _MAX_FILE_BYTES:
                    raise ExtensionPackageError('插件发布文件异常，请检查 extension 目录后重试')
                with file.open('rb') as stream:
                    opened = os.fstat(stream.fileno())
                    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino) or _linked(file):
                        raise ExtensionPackageError('插件文件正在更新，请稍后重试下载')
                    body = stream.read(_MAX_FILE_BYTES + 1)
                total += len(body)
                if len(body) > _MAX_FILE_BYTES or total > _MAX_PACKAGE_BYTES or len(files) >= 2000:
                    raise ExtensionPackageError('插件安装包超过允许大小，请检查发布文件')
                files[relative.as_posix()] = body
        if 'manifest.json' not in files or '安装说明.md' not in files:
            raise ExtensionPackageError('插件发布文件不完整，缺少 manifest.json 或安装说明.md')
        manifest = json.loads(files['manifest.json'].decode('utf-8-sig'))
        version, name = manifest.get('version'), manifest.get('name')
        if (manifest.get('manifest_version') not in (2, 3) or not isinstance(version, str) or
                not re.fullmatch(r'\d{1,5}(?:\.\d{1,5}){0,3}', version) or
                any(int(part) > 65535 for part in version.split('.')) or
                not isinstance(name, str) or not name.strip() or len(name) > 256 or
                any(ord(char) < 32 for char in name)):
            raise ExtensionPackageError('插件 manifest.json 格式或版本无效，请检查后重试')
        _validate_resources(files, manifest)
        metadata = {'name':name, 'version':version, 'filename':f'{PACKAGE_ROOT}-{version}.zip',
                    'download_url':'/api/extension/download'}
        return metadata, files
    except ExtensionPackageError:
        raise
    except (OSError, UnicodeError, ValueError, TypeError, KeyError, AttributeError):
        raise ExtensionPackageError('浏览器插件安装包暂不可用，请检查插件发布文件后重试') from None


def _workbench_origin(origin):
    if not isinstance(origin, str) or len(origin) > 128 or any(char.isspace() for char in origin):
        raise ExtensionPackageError('工作台访问地址无效，请从工作台重新下载')
    try:
        parsed = urlsplit(origin)
        if (parsed.scheme != 'http' or not parsed.hostname or parsed.username or parsed.password or
                parsed.path or parsed.query or parsed.fragment or
                not 1 <= (parsed.port if parsed.port is not None else 80) <= 65535):
            raise ValueError('invalid origin')
        if parsed.hostname != 'localhost':
            address = ipaddress.ip_address(parsed.hostname)
            if address.version != 4 or address.is_unspecified:
                raise ValueError('invalid host')
    except ValueError:
        raise ExtensionPackageError('工作台访问地址无效，请从工作台重新下载') from None
    return origin


def extension_package_metadata(directory, workbench_origin=None):
    metadata = _snapshot(directory)[0]
    if workbench_origin is not None:
        metadata['workbench_origin'] = _workbench_origin(workbench_origin)
    return metadata


def build_extension_package(directory, workbench_origin=None):
    metadata, files = _snapshot(directory)
    if workbench_origin is not None:
        metadata['workbench_origin'] = _workbench_origin(workbench_origin)
        files['workbench-default.mjs'] = ('export const DEFAULT_WORKBENCH_ORIGIN = ' +
            json.dumps(metadata['workbench_origin']) + ';\n').encode('utf-8')
    archive = io.BytesIO()
    try:
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as package:
            for name, content in sorted(files.items()):
                package.writestr(PACKAGE_ROOT + '/' + name, content)
    except (OSError, ValueError, RuntimeError):
        raise ExtensionPackageError('浏览器插件安装包生成失败，请稍后重试') from None
    return metadata, archive.getvalue()
