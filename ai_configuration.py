"""Server-only OpenAI-compatible model settings and bounded model discovery."""
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import urllib.error
import urllib.request
from urllib.parse import urlsplit, urlunsplit


_LOCK = threading.RLock()
_PROVIDERS = {'deepseek', 'openai-compatible'}


class ConfigurationConflict(ValueError):
    pass


def canonical_base_url(value):
    if (not isinstance(value, str) or not value.strip() or len(value) > 2000 or
            any(ord(char) < 32 or ord(char) == 127 for char in value) or '\\' in value or
            re.search(r'%[01][0-9a-f]|%7f', value, re.IGNORECASE)):
        raise ValueError('请输入有效的 API 基础地址')
    try:
        value = value.strip()
        if any(char.isspace() for char in value):
            raise ValueError()
        parsed = urlsplit(value)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username is not None or
                parsed.password is not None or parsed.query or parsed.fragment or parsed.port == 0):
            raise ValueError()
        # Reading port above also rejects malformed/out-of-range ports.
        parsed.port
    except ValueError:
        raise ValueError('API 地址须为 HTTP/HTTPS，且不含账号、查询参数或片段') from None
    path = parsed.path.rstrip('/')
    for suffix in ('/chat/completions', '/models'):
        if path.endswith(suffix):
            path = path[:-len(suffix)].rstrip('/')
            break
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), path, '', ''))


def _model_id(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 200 or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError('请填写200字以内的模型 ID')
    return value.strip()


def _key(value):
    if not isinstance(value, str) or len(value) > 4000 or any(ord(char) < 33 or ord(char) > 126 for char in value.strip()):
        raise ValueError('API Key 格式无效')
    return value.strip()


def environment_config():
    return {'provider':'deepseek', 'base_url':canonical_base_url(os.environ.get('AI_BASE_URL', 'https://api.deepseek.com')),
            'model':_model_id(os.environ.get('AI_MODEL', 'deepseek-chat')), 'api_key':_key(os.environ.get('DEEPSEEK_API_KEY', '')),
            'revision':0, 'source':'environment'}


def load_config(path):
    path = Path(path)
    with _LOCK:
        if not path.exists():
            return environment_config()
        try:
            raw = json.loads(path.read_text(encoding='utf-8'))
            if (not isinstance(raw, dict) or raw.get('provider') not in _PROVIDERS or
                    type(raw.get('revision')) is not int or raw['revision'] < 1):
                raise ValueError()
            # An explicit empty saved key never falls back to the environment.
            return {'provider':raw['provider'], 'base_url':canonical_base_url(raw['base_url']),
                    'model':_model_id(raw['model']), 'api_key':_key(raw['api_key']),
                    'revision':raw['revision'], 'source':'saved'}
        except (OSError, KeyError, TypeError, ValueError):
            raise ValueError('已保存的模型配置无法读取，请在连接与集成中重新保存配置') from None


def public_config(config):
    has_key = bool(config['api_key'])
    return {key:config[key] for key in ('provider','base_url','model','revision','source')} | {
        'has_key':has_key, 'key_hint':'已配置（不显示）' if has_key else '未配置',
        'configured':has_key or config['provider'] == 'openai-compatible'}


def safe_config(path):
    try:
        return public_config(load_config(path))
    except ValueError as error:
        return {'provider':'deepseek','base_url':'https://api.deepseek.com','model':'deepseek-chat',
                'revision':0,'source':'invalid','has_key':False,'key_hint':'配置待修复','configured':False,'error':str(error)}


def save_config(path, data):
    path = Path(path)
    with _LOCK:
        try:
            previous = load_config(path)
        except ValueError:
            previous = {'provider':'','base_url':'','model':'','api_key':'','revision':0,'source':'invalid'}
        if type(data.get('revision')) is not int or data['revision'] != previous['revision']:
            raise ConfigurationConflict('模型配置已更新，请刷新配置后再保存，当前输入已保留。')
        provider = data.get('provider')
        if provider not in _PROVIDERS:
            raise ValueError('请选择 DeepSeek 或 OpenAI 兼容服务')
        base, model = canonical_base_url(data.get('base_url')), _model_id(data.get('model'))
        if 'clear_key' in data and type(data['clear_key']) is not bool:
            raise ValueError('清除密钥选项格式无效')
        entered = _key(data.get('api_key', ''))
        changed_service = provider != previous['provider'] or base != previous['base_url']
        key = entered or ('' if changed_service or data.get('clear_key') else previous['api_key'])
        if data.get('clear_key'):
            key = ''
        content = {'provider':provider,'base_url':base,'model':model,'api_key':key}
        changed = any(content[field] != previous[field] for field in content)
        if not changed and previous['source'] == 'saved':
            return previous, False
        content['revision'] = previous['revision'] + 1
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                    prefix='.ai-config-', suffix='.json', delete=False) as output:
                temporary = Path(output.name)
                os.chmod(output.name, 0o600)
                json.dump(content, output, ensure_ascii=False)
                output.flush(); os.fsync(output.fileno())
            os.replace(temporary, path)
        except OSError:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            raise ValueError('模型配置保存失败，原配置已保留') from None
        return {**content,'source':'saved'}, changed


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def model_urlopen(request, timeout=90):
    return urllib.request.build_opener(_NoRedirect()).open(request, timeout=timeout)


def authorization_headers(config):
    headers = {'Content-Type':'application/json'}
    if config['api_key']:
        headers['Authorization'] = 'Bearer ' + config['api_key']
    return headers


def credential_fingerprint(config):
    return hashlib.sha256(config['api_key'].encode()).hexdigest()


def list_models(config):
    request = urllib.request.Request(config['base_url']+'/models', headers=authorization_headers(config))
    try:
        with model_urlopen(request, timeout=20) as response:
            raw = response.read(1_000_001)
        if len(raw) > 1_000_000:
            raise ValueError('模型列表过大，请直接填写模型 ID')
        payload = json.loads(raw)
        rows = payload.get('data') if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            raise ValueError('服务未返回标准模型列表，可直接填写模型 ID')
        identifiers = []
        for item in rows[:2000]:
            if not isinstance(item, dict):
                continue
            try:
                identifier = _model_id(item.get('id'))
            except ValueError:
                continue
            if config['api_key'] and config['api_key'] in identifier:
                continue
            if identifier not in identifiers:
                identifiers.append(identifier)
        return [{'id':identifier} for identifier in identifiers]
    except urllib.error.HTTPError as error:
        raise ValueError(f'读取模型列表返回 HTTP {error.code}，可直接填写模型 ID') from None
    except (urllib.error.URLError, TimeoutError):
        raise ValueError('读取模型列表连接失败或超时，可直接填写模型 ID') from None
    except (json.JSONDecodeError, UnicodeError):
        raise ValueError('服务未返回有效模型列表，可直接填写模型 ID') from None
