# sdcadm

- Repository: <git@git.joyent.com:sdcadm.git>, <https://mo.joyent.com/sdcadm>
- Who: Trent Mick
- API Docs: <https://mo.joyent.com/docs/sdcadm>
- XMPP/Jabber: <mib@groupchat.joyent.com>
- Tickets/bugs: <https://devhub.joyent.com/jira/browse/TOOLS>
- CI builds: <https://jenkins.joyent.us/job/sdcadm>


# Overview

`sdcadm` is a tool that lives in the SmartDataCenter headnode GZ for
handling SDC upgrades (and possibly other SDC setup duties).


# Development

    git clone git@git.joyent.com:sdcadm.git
    cd sdcadm
    git submodule update --init
    make all
    ./bin/sdcadm help

Pushing local clone changes to a COAL HN for quicker dev cycle:

    # ... make edits ...
    ./tools/rsync-to root@10.99.99.7


# Testing

TODO
