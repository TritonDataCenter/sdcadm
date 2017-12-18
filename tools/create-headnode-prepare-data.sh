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
# Dev Note: This script is a temporary prototype of code that should be
# migrated to node.js code as part of `sdcadm server headnode-setup`
# (see a start at sdcadm.git:lib/headnode.js#ProcHeadnodeSetup.execute).
#

#
# This script will populate data in /usbkey/extra/headnode-prepare (to be
# served by the "assets" zone) for use by "headnode-prepare.sh" running on
# a CN. It must be run from the headnode global zone.
#
# This is similar in spirit to populating data in "/usbkey/extra/joysetup"
# to be used for setting up a server as a CN.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
if [[ -n "$TRACE" ]]; then
    set -o xtrace
fi
set -o errexit
set -o pipefail


# ---- globals/config

export PATH=/usr/bin:/usr/sbin:/smartdc/bin:/opt/smartdc/bin
LOGFILE="/var/log/create-headnode-prepare-data.log"


#---- support stuff

function fatal
{
    echo "$0: fatal error: $*"
    exit 1
}

function usage {
    echo 'Populate /usbkey/extra/headnode-prepare for secondary headnode setup'
    echo 'on the given CNs.'
    echo ''
    echo 'Usage:'
    echo '    bash create-headnode-prepare-data.sh [-hv] [CN-UUID ...]  '
    echo ''
    echo 'Options:'
    echo '   -h       Print this help and exit.'
    echo '   -v       Verbose trace output.'
}

function assertGz {
    [[ $(zonename) == "global" ]] || fatal "not running in the global zone"
}

function assertHn {
    [[ $(bootparams | grep ^headnode=) == "headnode=true" ]] \
        || fatal "not running on a headnode"
}

function create_headnode_prepare_data {
    local protoDir=/var/tmp/usbkey-proto
    local destDir=/usbkey/extra/headnode-prepare
    local cnUuid
    local cnUuids
    local usbkeyStatus
    local mountDir

    echo "Creating headnode-prepare data in $destDir"

    cnUuids="$*"

    usbkeyStatus=$(sdc-usbkey status)
    mountDir=$(sdc-usbkey mount --nofoldcase)

    mkdir -p /usbkey/extra/headnode-prepare

    # config & boot/networking.json for each CN
    for cnUuid in $cnUuids; do
        echo "Creating config files for CN $cnUuid:"

        if [[ ! -f $mountDir/config ]]; then
            echo "error: where is $mountDir/config?" >&2
            return 1
        fi

        if $(/usr/lib/sdc/net-boot-config --enabled); then
            sdc-login -l dhcpd /opt/smartdc/booter/bin/hn-netfile "$cnUuid" \
                > $destDir/$cnUuid.networking.json
            echo "    $destDir/$cnUuid.networking.json"

            cat $mountDir/config \
                | sed -e '/^admin_nic=/d; /^admin_ip=/d; /^external_/d; /^hostname=/d;' \
                > $destDir/$cnUuid.config
            echo '' >> $destDir/$cnUuid.config
            cat $destDir/$cnUuid.networking.json \
                | json vnics \
                | json -c 'this.nic_tag==="admin"' 0 \
                | json -e 'this.s = "admin_nic="+this.mac+"\nadmin_ip="+this.ip' s \
                >> $destDir/$cnUuid.config
            cat $destDir/$cnUuid.networking.json \
                | json -e 'this.s = "hostname="+this.hostname' s \
                >> $destDir/$cnUuid.config
            echo "    $destDir/$cnUuid.config"

            #XXX what about adding *external_nic,ip* values?!
        else
            # XXX test this
            # this is wrong when running from the headnode, can't use local `sysinfo`
            # Perhaps could still generate the networking.json and use that info?  TODO: try this
            XXX
            local admin_nic sysinfo_nic_admin admin_ip
            admin_nic=$(/bin/bootparams | grep ^admin_nic | cut -d= -f2)
            [[ -n "$admin_nic" ]] || fatal "could not determine admin_nic from bootparams"
            sysinfo_nic_admin=$(sysinfo -p | grep NIC_admin | cut -d"'" -f2)
            admin_ip=$(sysinfo -p | grep Network_Interface_${sysinfo_nic_admin}_IPv4_Address | cut -d"'" -f2)
            [[ -n "$admin_ip" ]] || fatal "could not determine admin_nic from sysinfo"

            cat $mountDir/config \
                | sed -e '/^admin_nic=/d; /^admin_ip=/d; /^external_/d; /^hostname=/d;'
                > $destDir/$cnUuid.config
            echo '' >> $destDir/$cnUuid.config
            echo "admin_nic=$admin_nic" >> $destDir/$cnUuid.config
            echo "admin_ip=$admin_ip" >> $destDir/$cnUuid.config
            echo "    $destDir/$cnUuid.config"

            XXX need to get hostname in config
        fi
    done

    echo "Creating $destDir/usbkey-base.tgz"

    local protoDir=/var/tmp/usbkey-proto
    rm -rf $protoDir
    mkdir $protoDir
    # XXX This should get trimmed of cruft, e.g.:
    #       ur-scripts/agents-*.sh
    for f in .joyliveusb boot config.inc license scripts tools.tar.gz cn_tools.tar.gz banner boot_archive.manifest firmware private services ur-scripts usb_key.manifest version; do
        cp -PR $mountDir/$f $protoDir/$f
    done

    # sdcadm (latest is in /usbkey/extra/sdcadm/sdcadm.sh,
    # per newish 'sdcadm self-update')
    # TODO: change to use sdcadm image location from TOOLS-1954.
    if [[ ! -f "/usbkey/extra/sdcadm/sdcadm.sh" ]]; then
        echo "error: /usbkey/extra/sdcadm/sdcadm.sh does not exist, please run 'sdcadm self-update'" >&2
        return 1
    fi
    cp /usbkey/extra/sdcadm/sdcadm.sh $protoDir/sdcadm-install.sh

    # os
    # Note: Cannot copy from "/usbkey/os" because it has the wrong case.
    cp -PR $mountDir/os $protoDir/os

    (cd $protoDir && gtar czf $destDir/usbkey-base.tgz ./)
    rm -rf $protoDir
    echo "Created '$destDir/usbkey-base.tgz'."

    sdc-usbkey unmount    # Others don't want our 'nofoldcase' mount.
    if [[ "$usbkeyStatus" == "mounted" ]]; then
        sdc-usbkey mount
    fi

    return 0
}


#---- mainline

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

# Log copy of output to $LOGFILE.
exec > >(tee -a ${LOGFILE}) 2>&1

assertGz
assertHn

cnUuids="$*"
if [[ -z "$cnUuids" ]]; then
    fatal "missing CN-UUID argument(s)"
fi

# Hack setup of /usbkey/extra/sdcadm
# TODO: TOOLS-1954 will provide an official location for sdcadm.
if [[ ! -f /usbkey/extra/sdcadm/sdcadm.sh ]]; then
    echo "Downloading latest sdcadm installer to /usbkey/extra/sdcadm/..."
    mkdir -p /usbkey/extra/sdcadm/
    sdcadmUuid=$(updates-imgadm list name=sdcadm --latest -H -o uuid)
    echo "  Latest sdcadm build is $sdcadmUuid."
    updates-imgadm get $sdcadmUuid >/usbkey/extra/sdcadm/sdcadm.imgmanifest
    updates-imgadm get-file $sdcadmUuid >/usbkey/extra/sdcadm/sdcadm.sh
fi

create_headnode_prepare_data $cnUuids



exit 0
