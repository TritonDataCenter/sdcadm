<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2019 Joyent, Inc.
-->

# sdcadm

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md) --
*Triton does not use GitHub PRs* -- and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

`sdcadm` is a tool that lives in the Triton headnode's GZ, for
handling post-setup (i.e. setup steps after initial headnode setup),
upgrades, listing of services and instances, health checks, and other setup
duties.

Please see the [index](./docs/index.md) for more details.


# Current status

While `sdcadm` is still under significant development, and is far from complete,
it is currently the recommended way to update SDC. Signs of incompleteness are
that sub-commands of `sdcadm experimental ...` are required as part of the upgrade
process.

# Triton post-setup with sdcadm

The document [post-setup](docs/post-setup.md) details the required steps in order to
configure Triton DataCenter for practical usage, like HA setup and the
addition of services not installed by default.

# Manage Triton upgrades with sdcadm

The document [update](docs/update.md) provides a detailed description on how to
proceed with the update of a given Triton DataCenter (just "Triton" for
short) standup.

# Man page

The [sdcadm man page](man/man1/sdcadm.1.ronn) provides reference for every
sdcadm subcommand.

# Developer notes

## Updating sdcadm

To update to bits you've built locally (with `make publish`), cover over
`bits/sdcadm` to your headnode, import them into your `imgapi` instance,
then use the `-S` flag to `sdcadm self-update`:

    sdc-imgadm import -c none \
      -f /tmp/sdcadm-mybranch-20190701T145750Z-gfcba035.sh
      -m /tmp/sdcadm-mybranch-20190701T145750Z-gfcba035.imgmanifest
    sdcadm self-update -S http://imgapi.mydc.example.com/ --latest

## Testing sdcadm

This should only be done by developers, and only in dev or test environments.
Tests will muck around with the sdc setup, doing terrible and unholy things to
your data.

Note that tests are expected to run on a fresh setup, since the test suite
will go through all the `post-setup` subcommands.

In order to run sdcadm tests, you'll first need to signal to the tests that
you really do want them to run:

    touch /lib/sdc/.sdc-test-no-production-data

After that, to run the tests themselves:

    /opt/smartdc/sdcadm/test/runtests

The full battery of tests can take up to thirty minutes to run. To only run
tests in a single file, instead of all test files, consider using the -f flag
with the `runtests` command. For example, to run the tests in sdcadm.test.js:

    /opt/smartdc/sdcadm/test/runtests -f sdcadm.test.js


### Unit Tests

`sdcadm` includes some unit tests. At this time the coverage is significantly
less than the integration tests.  Unit tests can be run with:

    make test-unit

Individual test files can be run with a command such as:

    ./node_modules/.bin/tap test/unit/foo.js

`node-tap` includes several flags that may be useful while developing, such as
only running suites that match a certain name.
