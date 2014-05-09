#!/bin/bash
#
# Copyright (c) 2014, Joyent, Inc. All rights reserved.
#
# This is the script included in sdcadm tarballs to handle
# the sdcadm install/upgrade on a headnode GZ.
#
# Usage:
#   install-sdcadm.sh    # in the extracted shar dir
#
# Environment:
#   SDCADM_LOGDIR=<path to an existing dir>
#           If not provided, then details, including rollback info, will be
#           put in "/var/sdcadm/self-updates/YYYYMMDDTHHMMSSZ".
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
if [[ -n "$SDCADM_LOGDIR" ]]; then
    LOGDIR=$SDCADM_LOGDIR
    TRIM_LOGDIRS=false
    if [[ -n "$(echo $LOGDIR | (egrep '^\/var\/sdcadm\/self-updates\/.' || true))" ]]; then
        # Be defensive and only allow trimming of `dirname $LOGDIR` if it is
        # where we expect it to be.
        TRIM_LOGDIRS=true
    fi
else
    LOGDIR=/var/sdcadm/self-updates/$(date +%Y%m%dT%H%M%SZ)
    mkdir -p $LOGDIR
    TRIM_LOGDIRS=true
fi
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
[[ -d "$LOGDIR" ]] || fatal "'$LOGDIR' does not exist"

[[ -d $OLDDIR ]] && rm -rf $OLDDIR
[[ -d $NEWDIR ]] && rm -rf $NEWDIR

trap 'restore_old_on_error $?' EXIT

cp -PR ./ $NEWDIR
rm $NEWDIR/install-sdcadm.sh
rm -rf $NEWDIR/.temp_bin

# Archive the old sdcadm for possible rollback and log other details.
cp ./package.json $LOGDIR/package.json
cp ./etc/buildstamp $LOGDIR/buildstamp
if [[ -d $DESTDIR ]]; then
    echo "Archiving $(cat $DESTDIR/etc/buildstamp) to $LOGDIR/sdcadm.old"
    cp -PR $DESTDIR $LOGDIR/sdcadm.old
fi

if [[ "$TRIM_LOGDIRS" == "true" ]]; then
    # Only retain the latest 5 log dirs.
    (cd $(dirname $LOGDIR) && ls -1d ????????T??????Z | sort -r | tail +6 \
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
if [[ ! -f $CONFIG_PATH ]]; then
    mkdir -p $(dirname $CONFIG_PATH)
    echo '{}' >$CONFIG_PATH
fi
SERVER_UUID=$(sysinfo | json UUID)
json -f $CONFIG_PATH -e "this.serverUuid = '$SERVER_UUID'" >$CONFIG_PATH.new
mv $CONFIG_PATH.new $CONFIG_PATH

# Import the sdcadm-setup service and gracefully start it.
echo "Importing and starting sdcadm-setup service"
cp $DESTDIR/smf/manifests/sdcadm-setup.xml /var/svc/manifest/site/sdcadm-setup.xml
svccfg import /var/svc/manifest/site/sdcadm-setup.xml

[[ -d $OLDDIR ]] && rm -rf $OLDDIR

echo "Successfully upgraded to sdcadm $(cat $DESTDIR/etc/buildstamp)"
exit 0
