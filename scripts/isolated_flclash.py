"""Control only a separately spawned, unprivileged installed-version Core."""
import json
import fcntl
import os
import socket
import stat
import struct
import subprocess
import uuid
from pathlib import Path
from tempfile import gettempdir

from backend.distribution import DATA_DIR

PRIVATE_DIR = (DATA_DIR / "private").resolve()

def acquire_run_lock(home):
    fd=os.open(Path(home)/'.run.lock',os.O_CREAT|os.O_RDWR,0o600)
    try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BaseException:os.close(fd);raise RuntimeError('another isolated test is running')
    return fd


def release_run_lock(fd):
    fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)


class IsolatedCore:
    def __init__(self,home=None,guard=None):
        self.home=Path(home or PRIVATE_DIR / 'isolated-core').resolve()
        if not self.home.is_relative_to(PRIVATE_DIR):raise ValueError('isolation home must be private workspace data')
        if (self.home/'FlClashCore').stat().st_mode & (stat.S_ISUID|stat.S_ISGID):raise ValueError('isolated Core must not be privileged')
        self.owns_guard=guard is None
        self.guard=acquire_run_lock(self.home) if guard is None else guard
        self.path=Path(gettempdir())/('swb-'+uuid.uuid4().hex[:16]+'.sock')
        self.listener=socket.socket(socket.AF_UNIX);self.listener.bind(str(self.path));os.chmod(self.path,0o600)
        self.listener.listen(1);self.listener.settimeout(8)
        self.log=open(self.home/'process-private.log','wb');os.chmod(self.home/'process-private.log',0o600)
        self.process=subprocess.Popen([str(self.home/'FlClashCore'),str(self.path)],cwd=self.home,stdout=self.log,stderr=subprocess.STDOUT)
        self.conn,_=self.listener.accept();self.conn.settimeout(20);self.seq=0;self.events=[]
    def receive(self,n):
        b=b''
        while len(b)<n:
            part=self.conn.recv(n-len(b))
            if not part:raise EOFError('isolated core disconnected')
            b+=part
        return b
    def call(self,method,arguments=None):
        self.seq+=1;tag=str(self.seq)
        payload=json.dumps({'id':tag,'method':method,'arguments':arguments},ensure_ascii=False).encode()
        self.conn.sendall(struct.pack('<I',len(payload))+payload)
        for _ in range(5000):
            size=struct.unpack('<I',self.receive(4))[0]
            if size>64*1024*1024:raise ValueError('oversize frame')
            msg=json.loads(self.receive(size))
            if msg.get('id')==tag:
                if msg.get('error'):raise RuntimeError(str(msg['error'].get('code','core_error'))+': '+str(msg['error'].get('message','')))
                if msg.get('file'):
                    source=Path(msg['file']).resolve()
                    if not source.is_relative_to(self.home):raise ValueError('response file outside private home')
                    return json.loads(source.read_text())
                return msg.get('result')
            self.events.append(msg)
        raise RuntimeError('too many events')
    def close(self):
        self.conn.close();self.listener.close()
        try:self.process.wait(timeout=4)
        except subprocess.TimeoutExpired:self.process.terminate();self.process.wait(timeout=4)
        self.log.close();self.path.unlink(missing_ok=True)
        if self.owns_guard:release_run_lock(self.guard)

if __name__=='__main__':
    core=IsolatedCore()
    try:
        print('uninitialized',core.call('getIsInit'))
        print('init',core.call('initClash',{'home-dir':str(core.home),'version':0}))
        print('initialized',core.call('getIsInit'))
    finally:core.close()
