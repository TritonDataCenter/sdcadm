#!/usr/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2017, Joyent, Inc.
#

#
# A script to *run on a CN*, to prepare it for being rebooted into a headnode
# (HN). Currently this is typically called by
# `sdcadm server headnode-setup ...`.
#
# A prerequisite of this script is that something has populated:
#       http://$assets_admin_ip/extra/headnode-prepare/...
# (a.k.a. "/usbkey/extra/headnode-prepare/..." on the headnode) with files
# that will be downloaded. `sdcadm server headnode-setup ...` does this before
# running this script on the CN.
#
# Mainly this process is about setting up the USB key (minimal base bits,
# OS, config, and grub boot menu.lst) in preparation for booting up directly
# from the USB key.
#
# After the "headnode preparation" from this script, the rebooted server will
# be setup as a headnode via the usual "headnode.sh" setup script.
#
# Limitations:
# - This requires the CN to be setup already.
#

# TODO: perhaps this should be called "headnode-setup-prepare".

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
if [[ -n "$TRACE" ]]; then
    set -o xtrace
fi
set -o errexit
set -o pipefail


# ---- globals/config

export PATH=/usr/bin:/usr/sbin:/smartdc/bin:/opt/smartdc/bin

LOGFILE="/var/log/headnode-prepare.log"


#---- support stuff

function fatal
{
    echo "$0: fatal error: $*"
    exit 1
}

function errexit
{
    [[ $1 -ne 0 ]] || exit 0
    echo "$0: unexpected exit: exit status $1"
    exit $1
}

function usage {
    echo 'Prepare this CN for booting as a headnode.'
    echo ''
    echo 'Usage:'
    echo '    bash headnode-prepare.sh [-hv]'
    echo ''
    echo 'Options:'
    echo '   -h       Print this help and exit.'
    echo '   -v       Verbose trace output.'
}

function assertGz {
    [[ $(zonename) == "global" ]] || fatal "not running in the global zone"
}

function assertNotHn {
    [[ $(bootparams | (grep ^headnode= || true)) != "headnode=true" ]] \
        || fatal "running on a headnode"
}

function assertCnSetup {
    [[ $(sysinfo | json Setup) == "true" ]] || fatal "this CN is not setup"
}


#---- mainline

trap 'errexit $?' EXIT

# Log copy of output to $LOGFILE.
exec > >(tee -a ${LOGFILE}) 2>&1

# Options.
while getopts "hv" opt
do
    case "$opt" in
        h)
            usage
            exit 0
            ;;
        v)
            set -o xtrace
            ;;
        *)
            usage
            fatal "unknown option"
            ;;
    esac
done
shift $((OPTIND - 1))

assertGz
assertNotHn
assertCnSetup

# Mount the USB early for a faster failure if there isn't one.
usbkeyStartState=$(sdc-usbkey status)
mountDir=$(sdc-usbkey mount)
[[ -d "$mountDir" ]] || fatal "error mounting USB key"

# Clean up old work dirs, if too many.
MAX_OLD_WRK_DIRS=5
numOldWrkDirs=$((ls -1d /var/tmp/headnode-prepare-*T* || true) \
    | wc -l | awk '{print $1}')
if [[ $numOldWrkDirs -gt $MAX_OLD_WRK_DIRS ]]; then
    ls -1d /var/tmp/headnode-prepare-*T* \
        | head -$(( $numOldWrkDirs - $MAX_OLD_WRK_DIRS )) \
        | xargs -n1 rm -rf
fi

# Work dir.
wrkDir=/var/tmp/headnode-prepare-$(date '+%Y%m%dT%H%M%S')
rm -rf $wrkDir
mkdir -p $wrkDir

# There is a fun case where `bash /lib/sdc/config.sh -json` can give us stale
# data from its cache (/tmp/.config.json): If it was generated from, say,
# /mnt/usbkey/config, but we then delete that (e.g. from an earlier run of
# this script) or unmount the usbkey. On the next run it'll compare the cache
# file timestamp against /opt/smartdc/config/node.config -- a different file.
if [[ -f /opt/smartdc/config/node.config ]]; then
    touch /opt/smartdc/config/node.config
fi

# Download the bits we'll need from the assets service.
assetsIp=$(bash /lib/sdc/config.sh -json | json assets_admin_ip)
[[ -n "$assetsIp" ]] || fatal "could not find assets_admin_ip in config"
cnUuid=$(sysinfo | json UUID)
curl -sSf http://${assetsIp}/extra/headnode-prepare/usbkey-base.tgz -o $wrkDir/usbkey-base.tgz
curl -sSf http://${assetsIp}/extra/headnode-prepare/$cnUuid.config -o $wrkDir/config
if $(/usr/lib/sdc/net-boot-config --enabled); then
    curl -sSf http://${assetsIp}/extra/headnode-prepare/$cnUuid.networking.json -o $wrkDir/networking.json
fi

# Start with a clean slate.
# TODO Should we have a guard here? E.g. don't blow away answers.json, etc.?
rm -rf $mountDir/*
rm -rf $(ls -d $mountDir/.* | grep -v '/\.$' | grep -v '/\.\.$' | grep -v '/\.joyliveusb$')

# USB key content
(cd $mountDir && gtar -xzv --no-same-owner --no-same-permissions -f $wrkDir/usbkey-base.tgz)
cp $wrkDir/config $mountDir/config
if [[ -f $wrkDir/networking.json ]]; then
    cp $wrkDir/networking.json $mountDir/boot/networking.json
fi

# Ensure "/var/lib/setup.json" is set to tell "headnode.sh" to *not* do
# some initial headnode setup things. E.g. we don't want setup of this
# secondary headnode to create first instances of all the Triton services.
#
# For now, given that we are on a setup CN, we get lucky.
#
# TODO: Go through headnode.sh and see what states we need in there to avoid
#   *initial* headnode setup steps.
#       setup_state_add "sdczones_created"
#       setup_state_add "import_smartdc_service_images"
#       setup_state_add "sapi_full_mode"
#       ... and others.
#
# TODO: A better answer would be to be passing explicit info to headnode.sh,
#   rather than signalling indirectly via setup.json states.
#   How to make it an explicit param somewhere?
#   Put a marker a la factoryreset on one of the datasets? Ask josh.



if [[ "$usbkeyStartState" == "unmounted" ]]; then
    sdc-usbkey unmount
fi

exit 0
