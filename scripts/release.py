#!/usr/bin/env python3
import argparse
import sys
from release_tools import core

def main():
    p=argparse.ArgumentParser()
    p.add_argument('command',choices=['check','gate','verify','dispatch','build','publish','identity'])
    p.add_argument('--history',action='store_true')
    p.add_argument('--worktree',action='store_true')
    p.add_argument('--tag')
    p.add_argument('--commit')
    p.add_argument('--source-run')
    p.add_argument('--output')
    a=p.parse_args()
    if a.command=='check': core.versions(); core.audit(a.history,a.worktree)
    elif a.command=='gate': core.gate()
    else:
        from release_tools import automation
        getattr(automation,a.command.replace('-','_'))(a)

if __name__=='__main__':
    try: main()
    except Exception as e:
        # CalledProcessError argv may contain credentials; print only our safe errors.
        print(str(e) if isinstance(e,RuntimeError) else 'Release command failed; private details suppressed',file=sys.stderr)
        sys.exit(1)
