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


function checkUpdateResults(t, err, stdout, stderr) {
    t.ifError(err);
    t.equal(stderr, '');

    if (stdout.indexOf('Already up-to-date') !== -1) {
        return t.end();
    }

    var findStrings = [
        'Update to sdcadm',
        'Download update from',
        'Run sdcadm installer',
        'Updated to sdcadm'
    ];

    findStrings.forEach(function (str) {
        t.ok(stdout.match(str), 'check update string present');
    });

    return t.end();
}


test('sdcadm self-update --help', function (t) {
    exec('sdcadm self-update --help', function (err, stdout, stderr) {
        t.ifError(err);

        t.notEqual(stdout.indexOf('sdcadm self-update [<options>]'), -1);
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm self-update --dry-run', function (t) {
    exec('sdcadm self-update --dry-run', function (err, stdout, stderr) {
        checkUpdateResults(t, err, stdout, stderr);
    });
});


test('sdcadm self-update --allow-major-update --dry-run', function (t) {
    exec('sdcadm self-update --allow-major-update --dry-run',
         function (err, stdout, stderr) {
        checkUpdateResults(t, err, stdout, stderr);
    });
});


// TODO: how do we fully run self-update without mucking with the sdcadm we're
// testing?