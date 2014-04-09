- install from a tarball build (which'll be on /usbkey), shar?
- self-update, optionally from a tarball
    - Determine if GZ external access is a design requirement. For now assume
      GZ external access. Later can go through the 'sdc' zone.
    -
- aside: type="other" support to imgapi, then publish to there
- sdcadm versions: table of current component versions
- update:
    Q: if we self-update automatically all the time as part of upgrade then
        a broken sdcadm release breaks *every SDC installation*
        What's the recovery from that?
        The flip side: how do we ensure that sdcadm is upgraded before a
        given upgrade? Answer: add a dep... but to *every* component?
        That's a pain.
- trim out stuff in node_modules in the sdcadm shar (e.g. large ldapjs
  and restify bits that we don't need)

# upgrade lock

    After gathering info and before downloads and making changes, an upgrade
    must get the upgrade "lock". Because we are potentially multi-process here
    we can't use "flock" (jclulow's module for this, "node-locker"?).

    TODO: If exec keeps the PID, perhaps we *can* use flock. Try it.

    Here is the proposed scheme:

    - get a $timestamp (YYYYMMDDTHHMMSSZ) for this upgrade
    - Attempt to create /var/db/sdcadm/upgrades/inprogress (content should
      be the $timestamp). If that fails because it exists, then there is an
      upgrade in progress (details in that $timestamp dir) *or* there is a
      stale lock from a broken upgrade. It is considered stale if

        1. /var/db/sdcadm/upgrades/$inprogressTimestamp/pid doesn't contain
            the PID of a running process; *and*
        2. is more than 30s old.

      The latter condition is to allowed a time gap for a new master process
      in an in-progress upgrade to write its PID.
    - If breaking an inprogress lock, then remove the inprogress file and
      the stale "pid" file. And retry previous step.

    TODO: Does our "new master process" stuff via kexec change the PID? I
    suspect not. If not, then don't need the "30s old" condition or the
    "pid" file re-writing.


# sdcadm self-update

TODO: Fix install-sdcadm.sh to craete the rollback copy *before* upgrading.
    And to take an envvar or switch for the rollback copy dir
    ($SDCADM_UPGRADE_DIR/sdcadm.old).

self-update:

    sdcadm.selfUpdate()

    - find the latest/version to which to update
    - get an "upgrade lock" (see above)
    - download it to $SDCADM_UPGRADE_DIR
    - https://github.com/jprichardson/node-kexec to actually replace with a
      created upgrade bash script and run the bash script

    SDCADM_UPGRADE_DIR=/var/db/sdcadm/upgrades/$timestamp
    echo $$ >$SDCADM_UPGRADE_DIR/pid  # mark self as the new master for this upgrade
    set -e
    cd /var/tmp/sdcadm-$$
    sh ./sdcadm-install.sh
    # TODO: make all clean up in an 'trap exit' handler.
    # Release upgrade lock.
    rm /var/db/sdcadm/upgrades/inprogress
    rm /var/db/sdcadm/upgrades/$timestamp/pid

self-update with upgrade of other components:

    # $SDCADM_UPGRADE_DIR/upgrade.json was written out

    set -e
    cd /var/tmp/sdcadm-$timestamp
    sh ./sdcadm-install.sh

    # Note: SDCADM_UPGRADE_TIMESTAMP envvar is the signal to sdcadm upgrade to
    # use the current inprogress upgrade.
    SDCADM_UPGRADE_TIMESTAMP=... exec sdcadm upgrade

rollback of self-update with upgrade of other components:

    - `sdcadm rollback` shows details on the last upgrade, gets confirmation,
      ensures have the images, agents, etc. available to which to rollback

    ??? START HERE
    - Need the record of upgrade somewhere. Can't use flock because of kexec
      new process.
        /var/db/sdcadm/upgrades/inprogress -> $timestamp
        /var/db/sdcadm/upgrades/$timestamp/
            pid    # PID of the current master process for the upgrade

            If 5 minutes old then consider it stale? Upgrades can take way
            longer. So 5 minutes is hard.







# Think about airgap upgrade process

Have 'smartdatacenter-upgrade-$version.tgz' releases that are all the
components to be upgraded:

    CHANGES.md
    README.md
    cnapi-$ver.zfs.gz
    cnapi-$ver.manifest
    ... agents, sdcadm, platform, ...

Then call:

    sdcadm update path/to/dir


# sdcadm update

    sdcadm update DIR
    sdcadm update UPGRADE-JSON-FILE
        {
            "cnapi": "UUID",
            "provisioner": "UUID",
            ...
        }
    sdcadm update COMPONENT [COMPONENT ...]
        Where 'COMPONENT' is just the name, e.g. 'cnapi', for the latest
        available. Or 'cnapi:1.2.3' for that version (or latest of that ver
        if multiple images with that ver). Or 'cnapi:UUID' for a specific
        cnapi. Or just 'UUID' because that in unambiguous.
    sdcadm update
        Upgrade all of the latest components.
    sdcadm update TICKET
        RFE. If we can have a *best guess* at component upgrades required for a
        given TICKET. Only if this would seem super useful. Would require
        a separate public service that exposes this from analyzing all Jira
        tickets for commits (or commits to repos mentioning that ticket), plus
        open status of ticket, plus optional addition metadata. Seems too
        loosey goosey to be confidence inspiring.

1. Get a UpgradeRecord with all details: size of downloads, update procedure
   (which implies impact), estimate of maint time.
2. Present overview and confirmation.
3. sdcadm self-update? Figure out how the post-run works for re-started 'sdcadm'
   after self-update.
4. Run the update procedure.

