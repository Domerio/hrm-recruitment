"""Manage only this checkout's workbench server; never kill by port alone."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

import psutil
from network_access import load_environment, bind_host, bind_port

ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / 'server.py'
DATA = ROOT / 'data'
load_environment(ROOT)
PORT = bind_port()
HOST = bind_host()
HEALTH_HOST = '127.0.0.1' if HOST == '0.0.0.0' else HOST

def same_path(a, b):
    return os.path.normcase(str(Path(a).resolve())) == os.path.normcase(str(Path(b).resolve()))

def belongs_to_project(process):
    try:
        argv, cwd = process.cmdline(), process.cwd()
        if len(argv) < 2 or not same_path(process.exe(), sys.executable):
            return False
        if any(arg not in ('-u', '-B') for arg in argv[1:-1]):
            return False
        script = Path(argv[-1])
        if not script.is_absolute():
            script = Path(cwd) / script
        return same_path(cwd, ROOT) and same_path(script, SCRIPT)
    except (psutil.Error, OSError, ValueError):
        return False

def listeners():
    # Read every TCP listener, including duplicate Windows SO_REUSEADDR bindings.
    return sorted({c.pid for c in psutil.net_connections(kind='tcp')
        if c.laddr and c.laddr.port == PORT and c.status == psutil.CONN_LISTEN}, key=lambda pid:pid or 0)

def verified_processes(pids):
    processes=[]
    for pid in pids:
        if not pid:
            raise RuntimeError(f'Cannot identify a listener on {PORT}; nothing stopped.')
        process=psutil.Process(pid)
        if not belongs_to_project(process):
            raise RuntimeError(f'Port {PORT} includes an unrelated or unverified process ({pid}); nothing stopped.')
        processes.append(process)
    return processes

def health():
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f'http://{HEALTH_HOST}:{PORT}/api/health',timeout=1) as response:
            return json.load(response)
    except (OSError, ValueError):
        return {}

def launch():
    DATA.mkdir(exist_ok=True)
    flags=0
    if os.name=='nt':
        flags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    with (DATA/'server-out.log').open('ab') as out, (DATA/'server-error.log').open('ab') as err:
        child=subprocess.Popen([sys.executable,'-u',str(SCRIPT)],cwd=ROOT,stdin=subprocess.DEVNULL,
            stdout=out,stderr=err,creationflags=flags,close_fds=True)
    deadline=time.monotonic()+12
    while time.monotonic()<deadline:
        if child.poll() is not None:
            raise RuntimeError('Server exited during startup. Check data/server-error.log.')
        result=health()
        if result.get('pid')==child.pid and result.get('capture_version')==1:
            return result
        time.sleep(.25)
    raise RuntimeError(f'New server ({child.pid}) did not become ready. Check data/server-error.log; no additional server was launched.')

def manage(action):
    pids=listeners()
    if action=='status':
        return {'listeners':pids,'health':health()}
    processes=verified_processes(pids)
    current=health()
    if action=='start' and len(pids)==1 and current.get('pid')==pids[0] and current.get('version')=='0.5.73' and current.get('bind_host')==HOST:
        return {'already_running':True,**current}
    if processes:
        if set(listeners())!=set(pids):
            raise RuntimeError('Listeners changed during inspection; nothing stopped. Run again.')
        for process in processes:
            if not belongs_to_project(process):
                raise RuntimeError('Service identity changed; no further processes stopped.')
            process.terminate()
        _,alive=psutil.wait_procs(processes,timeout=5)
        if alive:
            raise RuntimeError('A verified service is still exiting; no additional server launched.')
    if listeners():
        raise RuntimeError(f'Port {PORT} is still occupied; no additional server launched.')
    return {'stopped':pids,**launch()}

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['start','restart','status'])
    try:
        print(json.dumps(manage(parser.parse_args().action),ensure_ascii=True),flush=True)
    except (RuntimeError,psutil.Error) as error:
        raise SystemExit(str(error)) from None
