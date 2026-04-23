/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2026 Edgecast Cloud LLC.
 */

/*
 * NB: these tests require a tritonadm image to be published on the
 * updates server's selected channel.
 */

var test = require('tape').test;
var exec = require('child_process').exec;


function checkGetResults(t, err, stdout, stderr, moreStrings) {
    t.ifError(err);
    t.equal(stderr, '');

    if (stdout.indexOf('Already up-to-date') !== -1 ||
            stdout.indexOf('No tritonadm images available') !== -1) {
        t.end();
        return;
    }

    var findStrings = [
        'Install tritonadm',
        'Download tritonadm image from',
        'Run tritonadm installer'
    ];

    if (moreStrings) {
        findStrings = findStrings.concat(moreStrings);
    }

    findStrings.forEach(function (str) {
        t.ok(stdout.match(str), 'check ' + str + ' present in output');
    });

    t.end();
}


test('sdcadm experimental get-tritonadm --help', function (t) {
    exec('sdcadm experimental get-tritonadm --help',
            function (err, stdout, stderr) {
        t.ifError(err);
        t.notEqual(stdout.indexOf(
            'experimental get-tritonadm --latest [<options>]'),
            -1);
        t.equal(stderr, '');
        t.end();
    });
});


test('sdcadm experimental get-tritonadm (no args) errors', function (t) {
    exec('sdcadm experimental get-tritonadm',
            function (err, _stdout, stderr) {
        t.ok(err, 'expected error exit when called without arguments');
        t.ok(stderr.match(/image UUID|--latest/i),
            'error mentions required arg');
        t.end();
    });
});


test('sdcadm experimental get-tritonadm --latest --dry-run', function (t) {
    exec('sdcadm experimental get-tritonadm --latest --dry-run',
            function (err, stdout, stderr) {
        checkGetResults(t, err, stdout, stderr);
    });
});


test('sdcadm experimental get-tritonadm --latest --channel=staging',
        function (t) {
    var cmd = 'sdcadm experimental get-tritonadm --latest --dry-run ' +
        '--channel=staging';
    exec(cmd, function (err, stdout, stderr) {
        checkGetResults(t, err, stdout, stderr, ['Using channel staging']);
    });
});
