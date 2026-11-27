"""Local evaluation timing and explicitly requested model-content traces.

Each run has a JSONL event stream and a readable summary. Timings use a monotonic
clock; displayed timestamps use Asia/Shanghai (UTC+08:00). Timing events accept
only scalar metrics. Full request/response bodies go into a separate sidecar,
with authentication data redacted. Logging never changes task results.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
import base64
import binascii
import json
import math
from pathlib import Path
import re
import sys
import threading
import time
import uuid


_LOCAL_ZONE = timezone(timedelta(hours=8))
_current = ContextVar('evaluation_trace', default=None)
_stack = ContextVar('evaluation_trace_spans', default=())
_warning_lock = threading.Lock()
_warned = False

_NUMBER_FIELDS = frozenset({
    'candidate_id', 'job_id', 'config_revision', 'http_status', 'attempt',
    'retry_index', 'timeout_seconds', 'request_bytes', 'response_bytes',
    'resume_chars', 'resume_lines', 'instruction_chars', 'output_chars',
    'wait_seconds', 'queue_wait_ms', 'duration_ms', 'max_tokens',
    'input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens',
    'completion_tokens', 'reasoning_tokens', 'cached_tokens',
    'input_cached_tokens', 'output_reasoning_tokens', 'retry_count',
    'temperature', 'condition_count', 'required_condition_count',
    'evaluation_id', 'evaluation_epoch', 'source_id', 'job_revision', 'candidate_revision',
})
_BOOL_FIELDS = frozenset({'cached', 'saved', 'shared', 'reused', 'truncated', 'response_complete', 'precheck_rejected', 'model_skipped'})
_STRING_FIELDS = frozenset({
    'task_id', 'model', 'provider', 'route', 'status', 'finish_reason',
    'validation_path', 'error_type', 'error_code', 'call_id', 'precheck_version', 'evaluation_method',
})
_METADATA_FIELDS = frozenset({
    'candidate_id', 'job_id', 'task_id', 'model', 'provider', 'config_revision',
    'route', 'status', 'http_status', 'cached', 'saved', 'evaluation_id', 'evaluation_epoch', 'evaluation_method', 'model_skipped',
    'source_id', 'job_revision', 'candidate_revision',
})
_USAGE_FIELDS = ('input_tokens', 'output_tokens', 'total_tokens',
                 'cached_tokens', 'reasoning_tokens')
_SENSITIVE_KEYS = frozenset({
    'apikey', 'authorization', 'proxyauthorization', 'xapikey', 'accesstoken',
    'refreshtoken', 'password', 'passwd', 'secret', 'clientsecret', 'privatekey',
    'credential', 'credentials', 'apitoken', 'authtoken', 'bearertoken', 'token',
    'sessiontoken', 'cookie', 'setcookie',
})
_AUTH_VALUE = re.compile(r'(?i)\b(Bearer)([ \t]+)[A-Za-z0-9._~+/=-]+')
_BASIC_VALUE = re.compile(r'(?i)\b(Basic)([ \t]+)([A-Za-z0-9+/]+={0,2})')
_BASIC_HEADER_VALUE = re.compile(
    r'''(?i)(\b(?:Proxy-)?Authorization["']?[ \t]*[=:][ \t]*["']?Basic[ \t]+)[A-Za-z0-9._~+/=-]+''')
_SECRET_ASSIGNMENT = re.compile(
    r'''(?ix)(\b(?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|'''
    r'''password|passwd|client[_-]?secret|secret|auth[_-]?token)\b["']?[ \t]*[=:][ \t]*)'''
    r'''(?:\[REDACTED\]|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]\"']+)''')
_STAGE_LABELS = {
    'evaluate_resume': '评估简历', 'prepare_evaluation': '整理履历与岗位输入',
    'rule_precheck':'代码核对岗位硬性条件',
    'request_build': '构建模型请求', 'model_roundtrip': '模型请求与响应全过程',
    'response_body_read': '读取完整响应', 'response_json_parse': '解析接口响应 JSON',
    'model_json_parse': '解析模型结果 JSON', 'model_attempt': '本轮模型评估',
    'inference_dispatch': '分配或等待共享推理', 'validate_attempt': '校验本轮结果',
    'validation_and_scoring': '结果校验及计分', 'validate_schema': '校验结果结构',
    'normalize_support_scores': '归一化证据支持分', 'education_policy': '核对学历规则',
    'validate_final_schema': '复核最终结果结构', 'experience_consistency': '核对工作年限一致性',
    'calculate_score': '计算最终评分', 'load_candidate_and_cache': '读取候选人与查询缓存',
    'persist_evaluation': '保存评估结果', 'load_job': '读取岗位',
    'revalidate_inputs': '复核输入是否变化',
    'load_direct_candidate_and_cache': '直接评估：读取候选人与查询缓存',
    'load_screen_candidate_and_cache': '采集筛选：读取候选人与查询缓存',
    'persist_screen_evaluation': '保存采集筛选结果', 'persist_failure': '保存失败诊断',
    'load_chat_resume': '读取沟通简历', 'persist_chat_evaluation': '保存沟通简历评估',
    'database_open': '连接数据库', 'input_fingerprint': '计算评估输入指纹',
    'revalidate_queued_inputs': '出队后复核输入',
    'database_read': '读取数据库', 'database_save': '保存数据库',
    'db_open': '连接数据库', 'db_commit': '提交数据库事务',
    'http_request': '发送请求并等待 HTTP 响应头',
    'rate_limit_wait': '等待限流冷却', 'inference_wait': '等待共享推理结果',
    'task_execute': '执行队列任务',
    'request_content_log': '写入模型请求内容日志',
    'response_content_log': '写入模型响应内容日志',
    'http_error_body_read': '读取 HTTP 错误响应体',
}


def _clock():
    return time.perf_counter()


def _timestamp():
    return datetime.now(_LOCAL_ZONE).isoformat(timespec='milliseconds')


def _name(value):
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_.:-]{0,79}', value) else 'stage'


def _clean(fields, allowed=None):
    """Only known scalar metrics are allowed, including after span dict mutation."""
    result = {}
    for key, value in fields.items():
        if allowed is not None and key not in allowed:
            continue
        if key == 'call_id' and type(value) is int and 0 <= value <= 2 ** 63 - 1:
            result[key] = str(value)
        elif key in _NUMBER_FIELDS:
            if (type(value) is int and 0 <= value <= 2 ** 63 - 1 or
                    type(value) is float and math.isfinite(value) and value >= 0):
                result[key] = value
        elif key in _BOOL_FIELDS:
            if type(value) is bool:
                result[key] = value
        elif key in _STRING_FIELDS and isinstance(value, str):
            # Paths and messages are not accepted, even through a mislabeled field.
            if len(value) <= 256 and re.fullmatch(r'[A-Za-z0-9_./:\[\]-]*', value) and '://' not in value:
                result[key] = value
    return result


def _redact_basic(match):
    token = match[3]
    try:
        decoded = base64.b64decode(token + '=' * (-len(token) % 4), validate=True)
    except (ValueError, binascii.Error):
        return match[0]
    # Basic auth usually encodes username:password. Padded, longer base64 values
    # also look like credentials; ordinary skills such as Basic Python do not.
    if b':' in decoded or len(token) >= 12 and token.endswith('='):
        return match[1] + match[2] + '[REDACTED]'
    return match[0]


def _redact_text(text, secrets):
    """Keep text verbatim unless credentials require replacement."""
    for secret in secrets:
        text = text.replace(secret, '[REDACTED]')
    text = _AUTH_VALUE.sub(lambda match: match[1] + match[2] + '[REDACTED]', text)
    text = _BASIC_HEADER_VALUE.sub(lambda match: match[1] + '[REDACTED]', text)
    text = _BASIC_VALUE.sub(_redact_basic, text)
    # Requests and assistant content often contain JSON encoded inside JSON.
    # Inspect complete JSON strings too, rather than missing escaped key values.
    stripped = text.lstrip()
    if stripped.startswith(('{', '[', '"')):
        try:
            decoded = json.loads(text)
        except (ValueError, TypeError):
            pass
        else:
            redacted = _redact_payload(decoded, secrets)
            if redacted != decoded:
                return json.dumps(redacted, ensure_ascii=False, allow_nan=False)
            return text
    return _SECRET_ASSIGNMENT.sub(lambda match: match[1] + '[REDACTED]', text)


def _redact_payload(value, secrets):
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError('payload object keys must be strings')
            safe_key = _redact_text(key, secrets)
            normalized = re.sub(r'[^a-z0-9]', '', key.lower())
            result[safe_key] = '[REDACTED]' if normalized in _SENSITIVE_KEYS else _redact_payload(item, secrets)
        return result
    if isinstance(value, (list, tuple)):
        return [_redact_payload(item, secrets) for item in value]
    if isinstance(value, bytes):
        return _redact_text(value.decode('utf-8', errors='replace'), secrets)
    if isinstance(value, str):
        return _redact_text(value, secrets)
    if value is None or type(value) in (bool, int, float):
        return value
    raise TypeError('unsupported payload type')


def _warn_once():
    global _warned
    with _warning_lock:
        if _warned:
            return
        _warned = True
    try:
        print('Evaluation timing log unavailable; evaluation continues.', file=sys.stderr)
    except Exception:
        pass


class _Trace:
    def __init__(self, directory, operation, metadata):
        self.trace_id = uuid.uuid4().hex
        self.operation = _name(operation)
        self.started = _clock()
        self.started_at = _timestamp()
        self.metadata = _clean(metadata, _METADATA_FIELDS)
        self.path = None
        self.summary_path = None
        self.payload_path = None
        self._file = None
        self._payload_file = None
        self._payload_disabled = False
        self._payload_records = 0
        self._lock = threading.RLock()
        self._spans = []
        self._events = []
        self._usage = {}
        self._queue_wait_ms = 0.0
        self._submission_ms = 0.0
        self._finished = False
        try:
            folder = Path(directory) / self.started_at[:10]
            folder.mkdir(parents=True, exist_ok=True)
            self.path = folder / (self.trace_id + '.jsonl')
            self.summary_path = folder / (self.trace_id + '.summary.txt')
            self.payload_path = folder / (self.trace_id + '.payloads.jsonl')
            self._file = self.path.open('x', encoding='utf-8', buffering=1)
        except Exception:
            self._disable()
        self._emit('trace_start', step=self.operation, metadata=dict(self.metadata))

    def _disable(self):
        handle, self._file = self._file, None
        if handle is not None:
            try:
                handle.close()
            except Exception:
                pass
        _warn_once()

    def _emit(self, event_name, **fields):
        if self._file is None:
            return
        record = {'schema_version': 1, 'trace_id': self.trace_id,
                  'timestamp': _timestamp(), 'event': event_name,
                  'elapsed_ms': round(max(0.0, _clock() - self.started) * 1000, 3),
                  **fields}
        with self._lock:
            try:
                if self._file is not None:
                    self._file.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + '\n')
                    self._file.flush()
            except Exception:
                self._disable()

    def event(self, name, **fields):
        name = _name(name)
        fields = _clean(fields)
        if name == 'queue_wait':
            self._queue_wait_ms = fields.get('duration_ms', fields.get('queue_wait_ms', 0.0))
        if name == 'submission_prepare':
            self._submission_ms = fields.get('duration_ms', 0.0)
        if name == 'model_usage':
            for key in _USAGE_FIELDS:
                if key in fields:
                    self._usage[key] = self._usage.get(key, 0) + fields[key]
        stack = _stack.get()
        self._emit(name, span_id=stack[-1]['span_id'] if stack else None, **fields)
        self._events.append((name, fields))

    def annotate(self, **fields):
        cleaned = _clean(fields, _METADATA_FIELDS)
        self.metadata.update(cleaned)
        if cleaned:
            self._emit('metadata', **cleaned)

    def _close_payload(self, failed=False):
        handle, self._payload_file = self._payload_file, None
        if handle is not None:
            try:
                handle.close()
            except Exception:
                failed = True
        if failed:
            self._payload_disabled = True
            _warn_once()

    def record_payload(self, kind, payload, *, secrets=(), **fields):
        """Write full authorized content without retaining it in timing memory."""
        if self._finished or self._payload_disabled or self.payload_path is None:
            return
        with self._lock:
            try:
                if isinstance(secrets, str):
                    secrets = (secrets,)
                secret_values = tuple(sorted({item for item in secrets if isinstance(item, str) and item},
                                             key=len, reverse=True))
                stack = _stack.get()
                record = {'schema_version': 1, 'trace_id': self.trace_id,
                          'timestamp': _timestamp(),
                          'elapsed_ms': round(max(0.0, _clock() - self.started) * 1000, 3),
                          'span_id': stack[-1]['span_id'] if stack else None,
                          'kind': _name(kind), **_clean(fields)}
                if isinstance(payload, bytes):
                    record.update(payload_type='bytes', payload_encoding='utf-8', decode_errors='replace')
                elif isinstance(payload, str):
                    record['payload_type'] = 'text'
                else:
                    record['payload_type'] = 'json'
                record['payload'] = _redact_payload(payload, secret_values)
                encoded = json.dumps(record, ensure_ascii=False, allow_nan=False) + '\n'
                if self._payload_file is None:
                    self._payload_file = self.payload_path.open('x', encoding='utf-8', buffering=1)
                self._payload_file.write(encoded)
                self._payload_file.flush()
                self._payload_records += 1
                self._emit('payload_recorded', kind=record['kind'], **_clean(fields))
            except Exception as error:
                self._close_payload(failed=True)
                self._emit('payload_log_error', error_type=_name(type(error).__name__))

    def finish(self):
        if self._finished:
            return
        self._finished = True
        duration = round(max(0.0, _clock() - self.started) * 1000, 3)
        status = self.metadata.setdefault('status', 'succeeded')
        if self.metadata.get('http_status', 200) >= 400 and status == 'succeeded':
            self.metadata['status'] = 'failed'
        with self._lock:
            self._close_payload()
        self._emit('trace_end', step=self.operation, total_duration_ms=duration,
                   queue_wait_ms=self._queue_wait_ms,
                   submission_duration_ms=self._submission_ms,
                   end_to_end_ms=round(self._submission_ms + duration + self._queue_wait_ms, 3),
                   metadata=dict(self.metadata), usage_totals=dict(self._usage),
                   payload_records=self._payload_records, payload_log_failed=self._payload_disabled)
        with self._lock:
            if self._file is None:
                return
            try:
                self._file.close()
                self._file = None
                self.summary_path.write_text(self._summary(duration), encoding='utf-8')
            except Exception:
                self._disable()

    def _summary(self, duration):
        lines = [
            '简历评估阶段耗时日志',
            'Trace ID: ' + self.trace_id,
            '执行开始时间（北京时间）: ' + self.started_at,
            '操作: ' + self.operation,
            '状态: ' + self.metadata.get('status', 'succeeded'),
            '记录范围: 招聘服务器内部计时；不含浏览器读取简历、OCR 或浏览器到服务器的网络时间。',
            '提交准备: %.3f ms' % self._submission_ms,
            '排队等待: %.3f ms' % self._queue_wait_ms,
            '执行总耗时: %.3f ms' % duration,
            '服务器端到端耗时（提交准备 + 排队 + 执行）: %.3f ms' % (self._submission_ms + self._queue_wait_ms + duration),
        ]
        for key, value in self.metadata.items():
            if key != 'status':
                lines.append('%s: %s' % (key, value))
        lines += ['', '各阶段（按开始顺序；总耗时包含子阶段，自身耗时扣除子阶段）:']
        for item in self._spans:
            if 'duration_ms' not in item:
                continue
            fields = item.get('fields', {})
            name = item['name']
            label = ('  ' * item['depth']) + (_STAGE_LABELS[name] + ' (' + name + ')' if name in _STAGE_LABELS else name)
            lines.append('%s | 开始 +%.3f ms | 总耗时 %.3f ms | 自身 %.3f ms | %s%s' % (
                label, max(0.0, item['started'] - self.started) * 1000,
                item['duration_ms'], item['self_duration_ms'], item['status'],
                ' | ' + json.dumps(fields, ensure_ascii=False) if fields else ''))
        self_total = sum(item.get('self_duration_ms', 0.0) for item in self._spans)
        lines += ['', '说明: 嵌套阶段不能直接相加；请用执行总耗时判断总体速度。',
                  '执行总耗时含阶段间处理及期间日志写入，不含本摘要写入；阶段自身耗时合计可能小于执行总耗时。',
                  '已计时阶段自身耗时合计: %.3f ms' % self_total,
                  '未归入阶段及日志开销（约）: %.3f ms' % max(0.0, duration - self_total)]
        if self._usage:
            lines += ['', '模型报告的 Token 用量（各次实际请求累计，包含重试）:',
                      json.dumps(self._usage, ensure_ascii=False, sort_keys=True)]
        useful = [(name, fields) for name, fields in self._events if name not in ('model_usage', 'queue_wait', 'submission_prepare')]
        if useful:
            lines += ['', '事件:']
            lines += [name + ' ' + json.dumps(fields, ensure_ascii=False) for name, fields in useful]
        lines += ['', '限制: 当前为非流式客户端观测，不能分离服务端排队、预填充、思考、生成时间或首 Token 延迟（TTFT）。',
                  'HTTP 等待包含网络和服务端处理；响应读取也可能包含尚未完成的生成。',
                  '内容日志包含实际发送的履历、提示词和模型回复全文；认证字段和已知密钥会脱敏。',
                  'HTTP 请求头和接口地址不作为日志元数据记录；正文中的普通链接保留。',
                  '内容记录数: ' + str(self._payload_records),
                  '内容日志: ' + self.payload_path.name + ('（写入失败或不完整）' if self._payload_disabled else
                      '（未产生内容记录）' if not self._payload_records else ''),
                  '详细事件: ' + self.path.name, '']
        return '\n'.join(lines)


def current_trace():
    return _current.get()


@contextmanager
def trace_run(directory, operation, **metadata):
    """Open one local trace, or join an existing trace without creating another."""
    existing = current_trace()
    if existing is not None:
        existing.annotate(**metadata)
        with span(operation):
            yield existing
        return
    trace = _Trace(directory, operation, metadata)
    token = _current.set(trace)
    stack_token = _stack.set(())
    try:
        yield trace
    except BaseException as error:
        trace.annotate(status='failed')
        trace.event('run_error', error_type=type(error).__name__)
        raise
    finally:
        try:
            trace.finish()
        finally:
            _stack.reset(stack_token)
            _current.reset(token)


@contextmanager
def span(name, **fields):
    """Time a stage. The yielded dict accepts safe fields discovered at completion."""
    trace = current_trace()
    if trace is None:
        yield fields
        return
    stack = _stack.get()
    item = {'span_id': 's' + str(len(trace._spans) + 1),
            'parent_span_id': stack[-1]['span_id'] if stack else None,
            'name': _name(name), 'depth': len(stack), 'children_seconds': 0.0,
            'started': _clock()}
    trace._spans.append(item)
    trace._emit('stage_start', step=item['name'], span_id=item['span_id'],
                parent_span_id=item['parent_span_id'], **_clean(fields))
    token = _stack.set(stack + (item,))
    status = 'succeeded'
    try:
        yield fields
    except BaseException as error:
        status = 'failed'
        fields['error_type'] = type(error).__name__
        raise
    finally:
        duration = max(0.0, _clock() - item['started'])
        if stack:
            stack[-1]['children_seconds'] += duration
        _stack.reset(token)
        clean = _clean(fields)
        clean.pop('duration_ms', None)  # A caller cannot replace the measured time.
        clean.pop('status', None)
        item.update(duration_ms=round(duration * 1000, 3),
                    self_duration_ms=round(max(0.0, duration - item['children_seconds']) * 1000, 3),
                    status=status, fields=clean)
        trace._emit('stage_end', step=item['name'], span_id=item['span_id'],
                    parent_span_id=item['parent_span_id'], duration_ms=item['duration_ms'],
                    self_duration_ms=item['self_duration_ms'], status=status, **clean)


def event(name, **fields):
    trace = current_trace()
    if trace is not None:
        trace.event(name, **fields)


def annotate(**fields):
    trace = current_trace()
    if trace is not None:
        trace.annotate(**fields)


def record_payload(kind, payload, *, secrets=(), **fields):
    """Persist a complete request/response only inside an active local trace."""
    trace = current_trace()
    if trace is not None:
        trace.record_payload(kind, payload, secrets=secrets, **fields)


def record_usage(usage):
    """Normalize only provider-reported token counts; never keep arbitrary usage data."""
    if not isinstance(usage, dict) or current_trace() is None:
        return
    normalized = {}
    for key, alias in (('input_tokens', 'prompt_tokens'), ('output_tokens', 'completion_tokens'),
                       ('total_tokens', 'total_tokens')):
        value = usage.get(key, usage.get(alias))
        if type(value) is int and 0 <= value <= 2 ** 63 - 1:
            normalized[key] = value
    for target, containers, nested_key in (
        ('cached_tokens', ('input_tokens_details', 'prompt_tokens_details'), 'cached_tokens'),
        ('reasoning_tokens', ('output_tokens_details', 'completion_tokens_details'), 'reasoning_tokens'),
    ):
        for container in containers:
            details = usage.get(container)
            value = details.get(nested_key) if isinstance(details, dict) else None
            if type(value) is int and 0 <= value <= 2 ** 63 - 1:
                normalized[target] = value
                break
        else:
            value = usage.get(target, usage.get('prompt_cache_hit_tokens') if target == 'cached_tokens' else None)
            if type(value) is int and 0 <= value <= 2 ** 63 - 1:
                normalized[target] = value
    if normalized:
        event('model_usage', **normalized)
