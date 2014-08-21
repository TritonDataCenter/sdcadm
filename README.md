# sdcadm

- Repository: <git@git.joyent.com:sdcadm.git>
- Docs: <https://mo.joyent.com/docs/sdcadm>
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
    make all    # note that this fails to install some

Pushing working copy changes to a COAL HN for quicker dev cycle:

    [on-my-mac]$ vi    # make edits
    [on-my-mac]$ ./tools/rsync-to root@10.99.99.7
    [on-my-mac]$ ssh coal

    [root@headnode (coal) ~]# sdcadm ...     # test your changes


# Testing

TODO. There is no current test suite. The current best is that `sdcadm update
...` is run hourly on the
[nightly](https://mo.joyent.com/docs/globe-theatre/master/) standup.
