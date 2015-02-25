/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */


var test = require('tape').test;
var exec = require('child_process').exec;


test('sdcadm update --help', function (t) {
    exec('sdcadm update --help', function (err, stdout, stderr) {
        t.ifError(err);

        t.ok(stdout.indexOf('sdcadm update [<options>] <svc>') !== -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm update --dry-run', function (t) {
    exec('sdcadm update ca --dry-run -y', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        t.notEqual(stdout.indexOf('Finding candidate update images for the ' +
                   '"ca" service.'), -1);

        if (stdout.indexOf('Up-to-date.') === -1) {
            t.notEqual(stdout.indexOf('update "ca" service to image'), -1,
                       'check update string present');
            t.notEqual(stdout.indexOf('Updated successfully'), -1,
                       'check update string present');
        }

        t.end();
    });
});
