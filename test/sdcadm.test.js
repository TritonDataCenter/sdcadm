/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */


var test = require('tape').test;
var exec = require('child_process').exec;


test('sdcadm', function (t) {
    exec('sdcadm', function (err, stdout, stderr) {
        t.ok(err, 'usage error');
        t.equal(err.code, 1);

        t.ok(stdout.match('Usage'));
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm --help', function (t) {
    exec('sdcadm --help', function (err, stdout, stderr) {
        t.ifError(err, 'no help error');

        t.ok(stdout.match('Usage'));
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm --version', function (t) {
    exec('sdcadm --version', function (err, stdout, stderr) {
        t.ifError(err, 'no version error');
        t.ok(stdout.match(/^sdcadm \d+\.\d+\.\d+ \(master-\d+T\d+Z-.+\)/));
        t.equal(stderr, '');

        t.end();
    });
});
