#!/bin/bash
#
# Copyright (c) 2014, Joyent, Inc. All rights reserved.
#
# Install/upgrade sdcadm on this headnode GZ.
#
# - install to /opt/smartdc/sdcadm.new
# - mv the old one out of the way (if necessary)
# - mv /opt/smartdc/sdcadm.new /opt/smartdc/sdcadm
# - linkup /opt/smartdc/bin/sdcadm
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


DESTDIR=/opt/smartdc/sdcadm
NEWDIR=$DESTDIR.new
OLDDIR=$DESTDIR.old
ARCHIVEDIR=/var/db/sdcadm/self-updates/$(date +%Y%m%dT%H%M%SZ)


#---- support stuff

function fatal
{
    echo "$0: fatal error: $*" >&2
    exit 1
}

function restore_old_on_error
{
    [[ $1 -ne 0 ]] || exit 0

    if [[ -d $OLDDIR ]]; then
        echo "$0: restoring $DESTDIR from $OLDDIR"
        rm -rf $DESTDIR
        mv $OLDDIR $DESTDIR
    fi

    fatal "$0: error exit status $1" >&2
}


#---- mainline

# Sanity checks.
[[ "$(zonename)" == "global" ]] || fatal "not running in global zone"
[[ "$(sysinfo | json "Boot Parameters.headnode")" == "true" ]] \
    || fatal "not running on the headnode"
[[ -f "./etc/buildstamp" ]] || fatal "missing './etc/buildstamp'"

[[ -d $OLDDIR ]] && rm -rf $OLDDIR
[[ -d $NEWDIR ]] && rm -rf $NEWDIR

trap 'restore_old_on_error $?' EXIT

cp -PR ./ $NEWDIR
rm -f $NEWDIR/install-sdcadm.sh
rm -rf $NEWDIR/.temp_bin

# Move the old out of the way, swap in the new.
if [[ -d $DESTDIR ]]; then
    mv $DESTDIR $OLDDIR
fi
mv $NEWDIR $DESTDIR

# Link-up to get `sdcadm` on the PATH.
rm -f /opt/smartdc/bin/sdcadm
ln -s $DESTDIR/bin/sdcadm /opt/smartdc/bin/sdcadm

# Move old sdcadm to /var/db/sdcadm/self-updates/$timestamp for later
# possible rollback. We bother at all with the OLDDIR because at least we
# know that it will be on the same mount/device as the DESTDIR.
if [[ -d $DESTDIR ]]; then
    mkdir -p $ARCHIVEDIR
    mv $OLDDIR $ARCHIVEDIR/sdcadm

    # Only retain the latest 5.
    ls -1 $(dirname $ARCHIVEDIR) | sort -r | tail +6 | xargs -n1 rm -rf
fi
