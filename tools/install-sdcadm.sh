#!/bin/bash
#
# Copyright (c) 2014, Joyent, Inc. All rights reserved.
#
# This is the script included in sdcadm tarballs to handle
# the sdcadm install/upgrade on a headnode GZ.
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
ARCHIVEDIR=/var/sdcadm/self-updates/$(date +%Y%m%dT%H%M%SZ)
CONFIG_PATH=/var/sdcadm/sdcadm.conf


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
rm $NEWDIR/install-sdcadm.sh
rm -rf $NEWDIR/.temp_bin

# Archive the old sdcadm for possible rollback.
if [[ -d $DESTDIR ]]; then
    mkdir -p $ARCHIVEDIR
    echo "Archiving $(cat $DESTDIR/etc/buildstamp)"
    cp -PR $DESTDIR $ARCHIVEDIR/sdcadm

    # Only retain the latest 5.
    (cd $(dirname $ARCHIVEDIR) && ls -1 | sort -r | tail +6 \
        | xargs -n1 rm -rf)
fi

# Move the old out of the way, swap in the new.
if [[ -d $DESTDIR ]]; then
    mv $DESTDIR $OLDDIR
fi
mv $NEWDIR $DESTDIR

# Link-up to get `sdcadm` on the PATH.
rm -f /opt/smartdc/bin/sdcadm
ln -s $DESTDIR/bin/sdcadm /opt/smartdc/bin/sdcadm

# Add `serverUuid` to the config (better than having this
# done on every `sdcadm` invocation later).
if [[ -f $CONFIG_PATH ]]; then
    mkdir -p $(dirname $CONFIG_PATH)
    echo '{}' >$CONFIG_PATH
fi
SERVER_UUID=$(sysinfo | json UUID)
json -f $CONFIG_PATH -e "this.serverUuid = '$SERVER_UUID'" >$CONFIG_PATH.new
mv $CONFIG_PATH.new $CONFIG_PATH

[[ -d $OLDDIR ]] && rm -rf $OLDDIR

echo "Successfully upgraded to sdcadm $(cat $DESTDIR/etc/buildstamp)"
exit 0
