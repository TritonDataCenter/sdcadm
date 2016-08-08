/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var util = require('util');
var test = require('tape').test;
var exec = require('child_process').exec;

var CURR_CHANNEL = null;

test('setup', function (t) {
    exec('sdcadm channel get', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');
        if (stdout) {
            CURR_CHANNEL = stdout.trim();
        }
        t.end();
    });
});

test('sdcadm channel --help', function (t) {
    exec('sdcadm channel --help', function (err, stdout, stderr) {
        t.ifError(err);

        t.notEqual(stdout.indexOf('sdcadm channel [OPTIONS] COMMAND', -1));
        t.equal(stderr, '');

        t.end();
    });
});


test('sdcadm channel list', function (t) {
    exec('sdcadm channel list', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stderr, '');

        var expected = [
            'experimental',
            'dev',
            'staging',
            'release',
            'support'
        ];

        expected.forEach(function (name) {
            t.ok(stdout.match(name), 'contains name: ' + name);
        });

        var lines = stdout.split('\n');
        var titles = lines[0].split(/\s+/);
        t.deepEqual(titles, ['NAME', 'DEFAULT', 'DESCRIPTION']);
        t.end();
    });
});


test('sdcadm channel set', function (t) {
    exec('sdcadm channel set release', function (err, stdout, stderr) {
        t.ifError(err);
        t.equal(stdout.trim(),
                'Update channel has been successfully set to: \'release\'');
        t.equal(stderr, '');
        t.end();
    });
});


test('sdcadm channel reset',  function (t) {
    if (CURR_CHANNEL === null) {
        t.end();
        return;
    }
    var cmd = util.format('sdcadm channel set %s', CURR_CHANNEL);
    exec(cmd, function (err, stdout, stderr) {
        t.ifError(err);

        t.equal(stdout.trim(), 'Update channel has been successfully set to: ' +
                        '\'' + CURR_CHANNEL + '\'');
        t.equal(stderr, '');
        t.end();
    });
});
