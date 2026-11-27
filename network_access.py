"""Listener configuration and exact local-address checks for the workbench."""
import ipaddress
import os
from urllib.parse import urlsplit


def load_environment(root):
    path = root / '.env'
    for line in path.read_text(encoding='utf-8').splitlines() if path.exists() else []:
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            os.environ.setdefault(key.strip(), value.strip())


def bind_host():
    value = os.environ.get('HOST', '127.0.0.1').strip()
    try:
        return str(ipaddress.IPv4Address(value))
    except ValueError:
        raise ValueError('HOST must be an IPv4 address, such as 127.0.0.1 or 0.0.0.0') from None


def bind_port():
    try:
        value = int(os.environ.get('PORT', '8765'))
        if 1 <= value <= 65535:
            return value
    except ValueError:
        pass
    raise ValueError('PORT must be between 1 and 65535')


def is_loopback(address):
    try:
        return ipaddress.ip_address(address).is_loopback
    except ValueError:
        return False


def permitted_host(authority, local_address, port):
    # Trust the actual destination of this accepted socket, not DNS or forwarded headers.
    # Arbitrary hostnames would restore the DNS rebinding risk of a local HR workbench.
    if not authority or any(char.isspace() or char in '/\\?#@' for char in authority):
        return False
    try:
        parsed = urlsplit('http://' + authority)
        if (parsed.username is not None or parsed.password is not None or parsed.path
                or parsed.query or parsed.fragment or (80 if parsed.port is None else parsed.port) != port):
            return False
        if parsed.hostname == 'localhost':
            return is_loopback(local_address)
        address = ipaddress.ip_address(parsed.hostname)
        return not address.is_unspecified and address == ipaddress.ip_address(local_address)
    except (ValueError, TypeError):
        return False
