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
import uuid
from urllib.parse import urlsplit, urlunsplit


_LOCK = threading.RLock()
_PROVIDERS = {'deepseek', 'openai-compatible'}
_PROFILE_PROVIDERS = {'text': _PROVIDERS, 'ocr': {'paddleocr'}, 'asr': {'openai-compatible'}}
_EFFECTIVE_FIELDS = ('provider', 'base_url', 'model', 'api_key')
_PROFILE_LIMIT = 100


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
            'revision':0, 'evaluation_epoch':0, 'source':'environment'}


def _profile_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}', value):
        raise ValueError('模型配置标识无效，请重新读取配置')
    return value


def _documentation_url(value):
    if value == '':
        return ''
    canonical_base_url(value)  # Same URL safety rules, without endpoint normalization.
    parsed = urlsplit(value.strip())
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path.rstrip('/'), '', ''))


def _profile(raw, identifier):
    if not isinstance(raw, dict):
        raise ValueError('模型配置格式无效')
    kind, provider = raw.get('kind'), raw.get('provider')
    if kind not in _PROFILE_PROVIDERS or provider not in _PROFILE_PROVIDERS[kind]:
        raise ValueError('模型用途与接口类型不匹配')
    name = raw.get('name')
    if (not isinstance(name, str) or not name.strip() or len(name) > 200 or
            any(ord(char) < 32 or ord(char) == 127 for char in name)):
        raise ValueError('请填写200字以内的模型配置名称')
    base = canonical_base_url(raw.get('base_url'))
    if kind == 'ocr' and base.endswith('/layout-parsing'):
        base = base[:-len('/layout-parsing')].rstrip('/')
    return {'id':_profile_id(identifier), 'name':name.strip(), 'kind':kind, 'provider':provider,
            'base_url':base, 'model':_model_id(raw.get('model')), 'api_key':_key(raw.get('api_key', '')),
            'docs_url':_documentation_url(raw.get('docs_url', ''))}


def _initial_profiles(config):
    current = {'id':'current', 'name':config['model'], 'kind':'text', 'docs_url':'',
               **{key:config[key] for key in _EFFECTIVE_FIELDS}}
    definitions = [
        ('qwen-text', 'Qwen/Qwen3.8-27B', 'text', 'openai-compatible', 'http://10.177.137.55:9030/v1', ''),
        ('paddleocr-vl', 'PaddlePaddle/PaddleOCR-VL-1.6', 'ocr', 'paddleocr',
         'http://10.177.137.55:9031', 'http://10.177.137.55:9031/docs'),
        ('qwen-asr', 'Qwen/Qwen3-ASR-1.7B', 'asr', 'openai-compatible',
         'http://10.177.137.55:9032/v1', 'http://10.177.137.55:9032/docs'),
        ('vibevoice', 'microsoft/VibeVoice', 'asr', 'openai-compatible', 'http://10.177.137.55:9033/v1', ''),
    ]
    return [current] + [{'id':identifier, 'name':model, 'model':model, 'kind':kind, 'provider':provider,
                        'base_url':base, 'docs_url':docs, 'api_key':''}
                       for identifier, model, kind, provider, base, docs in definitions]


def _load_document(path):
    """Read the flat active model and catalog as one consistency boundary."""
    path = Path(path)
    if not path.exists():
        config = environment_config()
        return config, _initial_profiles(config), 'current'
    try:
        raw = json.loads(path.read_text(encoding='utf-8'))
        if (not isinstance(raw, dict) or raw.get('provider') not in _PROVIDERS or
                type(raw.get('revision')) is not int or raw['revision'] < 1 or
                type(raw.get('evaluation_epoch', 0)) is not int or raw.get('evaluation_epoch', 0) < 0):
            raise ValueError()
        # An explicit empty saved key never falls back to the environment.
        config = {'provider':raw['provider'], 'base_url':canonical_base_url(raw['base_url']),
                  'model':_model_id(raw['model']), 'api_key':_key(raw['api_key']),
                  'revision':raw['revision'], 'evaluation_epoch':raw.get('evaluation_epoch', 0), 'source':'saved'}
        if 'profiles' not in raw and 'active_profile_id' not in raw:
            return config, _initial_profiles(config), 'current'
        rows, active_id = raw['profiles'], _profile_id(raw['active_profile_id'])
        if not isinstance(rows, list) or not 1 <= len(rows) <= _PROFILE_LIMIT:
            raise ValueError()
        profiles = [_profile(row, row['id']) for row in rows]
        if len({row['id'] for row in profiles}) != len(profiles):
            raise ValueError()
        active = next((row for row in profiles if row['id'] == active_id), None)
        if (active is None or active['kind'] != 'text' or
                any(active[key] != config[key] for key in _EFFECTIVE_FIELDS)):
            raise ValueError()
        return config, profiles, active_id
    except (OSError, KeyError, TypeError, ValueError):
        raise ValueError('已保存的模型配置无法读取，请在连接与集成中重新保存配置') from None


def load_config(path):
    with _LOCK:
        return _load_document(path)[0]


def load_profiles(path):
    with _LOCK:
        config, profiles, active_id = _load_document(path)
        rows = [{key:row[key] for key in ('id', 'name', 'kind', 'provider', 'base_url', 'model', 'docs_url')} | {
            'has_key':bool(row['api_key']), 'key_hint':'已配置（不显示）' if row['api_key'] else '未配置',
            'request_path':'/layout-parsing' if row['kind'] == 'ocr' else '/chat/completions'} for row in profiles]
        return {'revision':config['revision'], 'active_profile_id':active_id, 'profiles':rows}


def _verify_revision(data, previous):
    if not isinstance(data, dict) or type(data.get('revision')) is not int or data['revision'] != previous['revision']:
        raise ConfigurationConflict('模型配置已更新，请刷新配置后再保存，当前输入已保留。')


def profile_config(path, profile_id, revision):
    """Read a selected saved text service without changing the active evaluator."""
    with _LOCK:
        config, profiles, _ = _load_document(path)
        _verify_revision({'revision':revision}, config)
        identifier = _profile_id(profile_id)
        profile = next((row for row in profiles if row['id'] == identifier), None)
        if profile is None:
            raise ValueError('未找到模型配置，请重新读取配置')
        if profile['kind'] != 'text':
            raise ValueError('OCR 和语音服务当前仅保存配置，不能用于文字模型测试或简历评估')
        return {key:profile[key] for key in _EFFECTIVE_FIELDS} | {
            'revision':config['revision'], 'evaluation_epoch':config.get('evaluation_epoch', 0),
            'source':config['source']}


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
            previous, profiles, active_id = _load_document(path)
        except ValueError:
            previous = {'provider':'','base_url':'','model':'','api_key':'','revision':0,
                        'evaluation_epoch':0,'source':'invalid'}
            profiles, active_id = None, 'current'
        _verify_revision(data, previous)
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
        # A -> B -> A is a new evaluation generation, while a storage-only save is not.
        content['evaluation_epoch'] = previous.get('evaluation_epoch', 0) + int(changed)
        if profiles is None:
            profiles = _initial_profiles(content)
        else:
            profiles = [{**row, **{field:content[field] for field in _EFFECTIVE_FIELDS}}
                        if row['id'] == active_id else row for row in profiles]
        _write_document(path, content, profiles, active_id)
        return {**content,'source':'saved'}, changed


def _write_document(path, config, profiles, active_id):
    """Commit active settings and the editable catalog together, never half a switch."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    content = {key:config[key] for key in (*_EFFECTIVE_FIELDS, 'revision')}
    content['evaluation_epoch'] = config.get('evaluation_epoch', 0)
    content.update(profiles=profiles, active_profile_id=active_id)
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


def update_profiles(path, data):
    path = Path(path)
    with _LOCK:
        previous, profiles, active_id = _load_document(path)
        old_active_id = active_id
        _verify_revision(data, previous)
        action = data.get('action')
        if action not in {'save', 'activate', 'delete'}:
            raise ValueError('模型配置操作无效')
        identifier = data.get('id')
        if identifier is not None:
            identifier = _profile_id(identifier)
        current = next((row for row in profiles if row['id'] == identifier), None)
        if identifier is not None and current is None:
            raise ValueError('未找到模型配置，请重新读取配置')
        updated = [dict(row) for row in profiles]
        if action == 'save':
            if current is None and len(profiles) >= _PROFILE_LIMIT:
                raise ValueError('最多可保存100个模型配置')
            raw = data.get('profile')
            if not isinstance(raw, dict):
                raise ValueError('模型配置格式无效')
            if 'clear_key' in raw and type(raw['clear_key']) is not bool:
                raise ValueError('清除密钥选项格式无效')
            saved = _profile(raw, identifier or 'model-' + uuid.uuid4().hex)
            if current and current['id'] == active_id and saved['kind'] != 'text':
                raise ValueError('当前评估模型必须是文字模型，请先切换评估模型')
            changed_service = current is None or any(saved[key] != current[key]
                                                     for key in ('kind', 'provider', 'base_url'))
            if raw.get('clear_key'):
                saved['api_key'] = ''
            elif not saved['api_key'] and not changed_service:
                saved['api_key'] = current['api_key']
            if current is None:
                updated.append(saved)
            else:
                updated = [saved if row['id'] == identifier else row for row in updated]
        else:
            if current is None:
                raise ValueError('请选择已保存的模型配置')
            if action == 'delete':
                if identifier == active_id:
                    raise ValueError('不能删除当前评估模型，请先选择其他文字模型')
                updated = [row for row in updated if row['id'] != identifier]
            else:
                if current['kind'] != 'text':
                    raise ValueError('只有文字模型可用于简历评估；OCR 和语音服务当前仅保存配置')
                active_id = identifier
        active = next(row for row in updated if row['id'] == active_id)
        content = {key:active[key] for key in _EFFECTIVE_FIELDS}
        changed = any(content[key] != previous[key] for key in _EFFECTIVE_FIELDS)
        if updated == profiles and active_id == old_active_id and previous['source'] == 'saved':
            return previous, False
        content['revision'] = previous['revision'] + 1
        # Catalog edits to inactive profiles do not expire the active model's cache.
        content['evaluation_epoch'] = previous.get('evaluation_epoch', 0) + int(changed)
        _write_document(path, content, updated, active_id)
        return {**content, 'source':'saved'}, changed


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
