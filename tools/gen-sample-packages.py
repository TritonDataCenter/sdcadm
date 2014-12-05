#!/usr/bin/env python

"""A crack at generating a *sample* set of SDC packages

Example run:

$ npm install -g tabula json
$ python gen-sample-pkgs.py | json -aj name max_physical_memory max_swap quota cpu_cap fss vcpu description  | tabula -s max_physical_memory -s name name max_physical_memory max_swap quota cpu_cap fss vcpu description
NAME                 MAX_PHYSICAL_MEMORY  MAX_SWAP  QUOTA   CPU_CAP  FSS  VCPU  DESCRIPTION
sample-0.25-kvm      256                  512       4096    20       20   1     Sample 0.25 GB RAM, 4 GB Disk
sample-0.25-smartos  256                  512       4096    20       20   -     Sample 0.25 GB RAM, 4 GB Disk
sample-0.5-kvm       512                  1024      8192    20       20   1     Sample 0.5 GB RAM, 8 GB Disk
sample-0.5-smartos   512                  1024      8192    20       20   -     Sample 0.5 GB RAM, 8 GB Disk
sample-1.0-kvm       1024                 2048      16384   20       20   1     Sample 1 GB RAM, 16 GB Disk
sample-1.0-smartos   1024                 2048      16384   20       20   -     Sample 1 GB RAM, 16 GB Disk
sample-4.0-kvm       4096                 8192      65536   50       50   1     Sample 4 GB RAM, 64 GB Disk
sample-4.0-smartos   4096                 8192      65536   50       50   -     Sample 4 GB RAM, 64 GB Disk
sample-8.0-kvm       8192                 16384     131072  100      100  1     Sample 8 GB RAM, 128 GB Disk
sample-8.0-smartos   8192                 16384     131072  100      100  -     Sample 8 GB RAM, 128 GB Disk
sample-16.0-kvm      16384                32768     262144  200      200  2     Sample 16 GB RAM, 256 GB Disk
sample-16.0-smartos  16384                32768     262144  200      200  -     Sample 16 GB RAM, 256 GB Disk

Notes:
- With the exception of the cpu_cap=20 values (see below), this will
  linear-fast-fit fill a Richmond-A or TL-A compute node.
- Set a min cpu_cap at 20 to avoid some very small values for the smaller
  sized packages. Implication: This will result in CPU over provisioning if have
  lots of the smaller packages on a CN. So be it. I'll doc that on the command
  that adds these sample packages.
"""


import sys
import json
import copy

top = {
    "name": "sample-16-smartos",
    "version": "1.0.0",
    "active": True,
    "cpu_cap": 200,
    "default": False,
    "max_lwps": 4000,
    "max_physical_memory": 16384,
    "max_swap": 32768,
    "quota": 262144,
    "zfs_io_priority": 100,
    "group": "Sample",
    "description": "Sample 16 GB RAM, 256 GB Disk",
    "v": 1
}


# Keith: """Basically I'd take the 16GB/2CPU/256GB instance and divide it by 2,
# 4, 8, and 16. Then you get optimal designation cost and zero waste. I do
# question whether a 0.125 CPU instance is worth using, but who knows. So, those
# instances (and linear multiples of them) will linear-fast-fit fill a
# Richmond-A or TL-A."""
#
# Unfortunately this results in silly low cpu_cap for the smaller RAM pkgs.
# There is no happy answer here at reasonable scale. So for now we punt
# and have a lower cpu_cap lower bound of 20. This effectively means that with
# a lot of the smaller zones on a server will mean CPU overprovisioning.
pkgs = []
for ram_gb in [0.25, 0.5, 1., 4., 8., 16.]:
    pkg = copy.copy(top)
    ram_mb = ram_gb * 1024
    factor = top["max_physical_memory"] / ram_mb
    #print factor
    for field in ["cpu_cap", "max_physical_memory", "max_swap", "quota"]:
        pkg[field] = top[field] / factor
    if pkg["cpu_cap"] < 20:
        pkg["cpu_cap"] = 20
    else:
        pkg["cpu_cap"] = round(pkg["cpu_cap"])
    pkg["fss"] = pkg["cpu_cap"]   # cpu_shares
    pkg["name"] = "sample-%s-smartos" % ram_gb

    ram_str = pkg["max_physical_memory"] / 1024.0
    if ram_str == int(ram_str):
        ram_str = str(int(ram_str))
    pkg["description"] = "Sample %s GB RAM, %s GB Disk" % (
        ram_str,
        int(pkg["quota"] / 1024)
    )
    pkgs.append(pkg)

    pkg_kvm = copy.copy(pkg)
    pkg_kvm["vcpu"] = max(1, int(pkg_kvm["cpu_cap"] / 100.0))
    pkg_kvm["name"] = "sample-%s-kvm" % ram_gb
    pkgs.append(pkg_kvm)

print json.dumps(pkgs, indent=4)
