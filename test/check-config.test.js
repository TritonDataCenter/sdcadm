/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 */


var test = require('tape').test;
var exec = require('child_process').exec;


test('sdcadm check-config --help', function (t) {
    exec('sdcadm check-config --help', function (err, stdout, stderr) {
        t.ifError(err);

        t.ok(stdout.indexOf('sdcadm check-config [<options>]') !== -1);
        t.equal(stderr, '');

        t.end();
    });
});


// Right now check-config is pretty much useless. Need to update it and take
// a complete review of a proper test suite.
// Need to fix https://jira.joyent.us/browse/TOOLS-1517 in order to avoid the
// test failing.
test.skip('sdcadm check-config', function (t) {
    exec('sdcadm check-config', function (err, stdout, stderr) {
        t.ifError(err);

        t.equal(stdout, 'All good!\n');
        t.equal(stderr, '');

        t.end();
    });
});
