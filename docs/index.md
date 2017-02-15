---
title: sdcadm (Administer a SDC standup)
markdown2extras: tables, code-friendly, cuddled-lists, link-patterns
markdown2linkpatternsfile: link-patterns.txt
apisections:
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2017, Joyent, Inc.
-->

# sdcadm

`sdcadm` is a tool that lives in the Triton headnode's GZ, for
handling post-setup (i.e. setup steps after initial headnode setup),
upgrades, listing of services and instances, health checks, and other setup
duties.

# Current status

While `sdcadm` is still under significant development, and is far from complete,
it is currently the recommended way to update SDC. Signs of incompleteness are
that sub-commands of `sdcadm experimental ...` are required as part of the upgrade
process.

# Triton post-setup with sdcadm

The document [post-setup](./post-setup.md) details the required steps in order to
configure Triton DataCenter for practical usage, like HA setup and the
addition of services not installed by default.

# Manage Triton upgrades with sdcadm

The document [update](./update.md) provides a detailed description on how to
proceed with the update of a given Triton DataCenter (just "Triton" for
short) standup.

# Man page

The [sdcadm man page](../man/man1/sdcadm.1.ronn) provides reference for every
sdcadm subcommand.

# Operator guide

In depth Triton DataCenter [operator guide documentation](https://docs.joyent.com/private-cloud), including usage
of sdcadm for many tasks, is also available.
