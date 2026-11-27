"""Atomic, additive authorization of unpacked browser-extension IDs."""
import json
import os
from pathlib import Path
import re
import tempfile
import threading


_LOCK = threading.RLock()


def _valid(identifier):
    return isinstance(identifier, str) and re.fullmatch(r'[a-p]{32}', identifier) is not None


def extension_ids(path):
    with _LOCK:
        try:
            data = json.loads(Path(path).read_text(encoding='utf-8'))
            values = data.get('ids', []) if isinstance(data, dict) else []
            if not isinstance(values, list):
                values = []
            values = ([data.get('id')] if isinstance(data, dict) else []) + values
            return list(dict.fromkeys(identifier for identifier in values if _valid(identifier)))
        except (OSError, ValueError, TypeError):
            return []


def _save(path, identifiers):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                prefix='.extension-', suffix='.json', delete=False) as output:
            temporary = Path(output.name)
            json.dump({'id':identifiers[0] if identifiers else '', 'ids':identifiers}, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def pair_extension(path, identifier):
    if not _valid(identifier):
        raise ValueError('插件 ID 应为 32 位 a-p 字母')
    with _LOCK:
        identifiers = extension_ids(path)
        if identifier not in identifiers:
            identifiers.append(identifier)
        _save(path, identifiers)
        return identifiers


def revoke_extension(path, identifier=None):
    if identifier is not None and not _valid(identifier):
        raise ValueError('插件 ID 应为 32 位 a-p 字母')
    with _LOCK:
        identifiers = [] if identifier is None else [value for value in extension_ids(path) if value != identifier]
        _save(path, identifiers)
        return identifiers
